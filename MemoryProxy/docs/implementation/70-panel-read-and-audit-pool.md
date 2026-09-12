# 70 · 回执 + 抽查池两页：读面契约与池语义（S7-a/S7-b 契约落点）

> **编号顺延**：`00/10/15/20/30/40/45/50/60 → 70`（S7 切片）。
> **本档是 S7-c（panel 两页）的唯一契约来源**：§1 = S7-a 只读 DTO（回填，实现 `a342f98`）；
> §2 = S7-b 池语义与状态机（本单）；§3 = 69 的 L1 接线契约（回填，实现 `6546f5b`）。
> 基线：`2428ced2`。回填原则：**以实现与当轮报告为准逐条核对后落库**（不改实现语义）。

---

## 1 只读面（S7-a 回填；实现 = `src/routes/attribution-read.ts`，commit `a342f98`）

### 1.1 三端点（注册于 `server.ts` Ops 区、catch-all 前）

| 端点 | 参数 | 契约要点 |
|---|---|---|
| `GET /v3/admin/attribution/sessions` | `space_id?`（缺省 `_default`）/ `since?`（ms \| ISO8601）/ `limit?`（缺省 100、上限 1000） | **`since` 与 `limit` 至少给一个**（缺则 400，拒绝无界全表扫）；响应 `{sessions:[…], truncated}`；行 = `{session_key, space_id, first_event_at, last_event_at, counts{units,judged,unconfirmed,used,corrected,pending,failed}}` |
| `GET /v3/admin/attribution/sessions/{session_key}` | `limit?`（缺省 100、上限 1000）/ `offset?`（缺省 0） | 回执 DTO（§1.2）；`truncated` = 分页命中；会话不存在 ⇒ 404 |
| `GET /v3/admin/attribution/audit-candidates` | `space_id?` / `limit?` / `filter?`（**参数位预留**：给值 ⇒ **400**，suspect 判据见 §2） | 未筛候选 = `verdict='unconfirmed'` ∪ queue `failed` ∪ queue `pending`（溢出记账）；响应 `{candidates:[…], counts{unconfirmed,failed,pending}, truncated}` |

鉴权：三端点统一 `checkAdminAuth(c, config.admin.apiKey)` + `adminAuthError`（照 `instance-destroy` 支；`apiKey` 空 ⇒ 公开）。

### 1.2 回执 DTO（字段级）

```jsonc
{
  "code": 0, "message": "ok",
  "data": {
    "session": { "session_key": "...", "space_id": "_default",
                 "first_event_at": 0, "last_event_at": 0,
                 // 版本链快照（60 spec §3）：只是本会话 fetched 窗口内的观测（DR-6a：不回查当前存储）；
                 // observed_versions 按首次出现序去重
                 "assets": [ { "asset_id": "...", "asset_type": "skill",
                               "first_seen_version": 1, "last_seen_version": 2,
                               "observed_versions": [1, 2] } ] },
    "counts": { "units": 0, "judged": 0, "unconfirmed": 0, "used": 0,
                "corrected": 0, "pending": 0, "failed": 0 },
    "overflow": { "pending": 0, "note": "另有 N 个次要决策未逐一归因（top-N 闸门；保持 pending，下轮 FIFO 优先）" },
    "units": [
      {
        "unit_id": "...", "kind": "decision_unit", "unit_type": "code_change|null",
        "turn_seq": 0, "msg_seq": 0, "created_at": 0,
        "judgement": {           // 无判定 ⇒ null
          "judgement_id": "jd_...", "verdict": "confirmed|refuted|unconfirmed",
          "round": 0, "asset_id": "…|null", "asset_type": "…|null",
          "evidence_source_type": null, "judge_impl": "mock:v1",
          "prompt_sha256": "...",
          "detail": { /* detail_json 原样（rationaleRef/candidateCount/unitKind/shortlist/citationMetrics/excludedCategories 等） */ }
        },
        "status_events": [
          { "status_id": "se_...", "event_type": "asset_used|asset_corrected",
            "asset_id": "...", "asset_type": "...", "round": 0,
            "outcome": null, "created_at": 0,
            "route": "version_drift",                          // corrected 才有（取 payload.correction_route）
            "detected_at": 0,                                  // corrected 必带（= created_at）
            "snapshot": { "anchored_version": 1, "latest_version": 2,
                          "semantics": "detected_at_snapshot" },  // corrected 才有
            "payload": { /* 只回指的链接字段（见 §1.3 C7） */ } }
        ],
        "missing": ["judgement", "status_events"]              // 缺即点名
      }
    ],
    "truncated": false
  }
}
```

### 1.3 契约 C1–C8（S7-a）

| # | 契约 | 说明 |
|---|---|---|
| C1 | 只读 | 只用既有只读 repo 方法；零写路径（T9 以"四表行数 + 写计数前后不变"证明） |
| C2 | 鉴权照 `instance-destroy` | `checkAdminAuth`；`apiKey` 空 ⇒ 公开（既有语义） |
| C3 | `space_id` 过滤 | 缺省 `_default`；**本单不做身份映射/ACL**（S7 后置；响应不得暗示已按用户过滤） |
| C4 | **68 D1（快照≠当前值）** | corrected 必带 `detected_at` + `snapshot.semantics="detected_at_snapshot"`；**禁止**任何 `current_version` 形态字段 |
| C5 | K2 粒度=轮 | `turn_seq`/`msg_seq` 原样透传；不得合成更细粒度字段 |
| C6 | 溢出可表达 | `overflow.pending` + 30 spec 原文口径文案（否则被读成"全覆盖"） |
| C7 | 单一真相 | 判定内容只在 `judgement.detail`；`status_events[].payload` 只回指（键 ⊆ 链接白名单：`used_status_id/judgement_id/unit_id/verdict/match_level/coverage/prompt_sha256/judge_impl/correction_route/anchored_version/latest_version/severity`） |
| C8 | 缺即 null + `missing[]` | 取不到的字段一律 `null` 并点名（不猜、不伪造） |

---

## 2 抽查/分歧池（S7-b；实现 = `src/attribution/audit-pool.ts` + 路由 + `attribution_audit_reviews`）

### 2.1 池对象与稳定键（C1）

- 对象 = **`(unit_id, round, category)`**（与主对象"决策单元"一致；同一单元可多命中）；
- `audit_key = "ak_" + sha1(unit_id|round|category).slice(0, 12)` ⇒ 稳定、可回指、可幂等；
- **响应行粒度**：每 `(unit_id, round, category)` 一行；行内 `categories[]` = **该 `(unit_id, round)` 的全部命中类**（重复携带，保证"多命中不丢信息"）。

### 2.2 类别与判据（C2；**全部机械可复算，零新增字段**）

| category | 判据（写死） | 来源键 |
|---|---|---|
| `suspect:truncated` | `verdict='unconfirmed'` **且** `detail.shortlist.overflowCount > 0` | shortlist |
| `suspect:low_coverage` | `verdict='unconfirmed'` **且**（`citationMetrics` 缺失/空 **或** `max(数值 coverage)` < `T_COV=0.5`；`"unknown"` 视作不满足阈值） | citationMetrics |
| `suspect:no_metrics` | `verdict='unconfirmed'` **且** `rationaleRef === 'mechanical:no-metrics'` | rationaleRef |
| `suspect:malformed` | `rationaleRef` 以 **`malformed:`** 开头（真 provider 解析畸形 ⇒ 明确可疑） | rationaleRef |
| `disagreement:flip` | 同 `unit_id` 存在 **≥2 个 round**，且 verdict 集合大小 **> 1**（重判翻转；挂在 **latest round** 行上） | 多轮 judgement |
| `disagreement:corrected` | 该 `(unit, round)` 的 used 资产存在 `asset_corrected` 行（同 session 域） | status 事件 |
| `orphan:dead_letter` | queue `status='failed'`（死信：从未得到判定；无判定字段 ⇒ 相应字段 `null`） | queue |

- **硬排除**：`rationaleRef === 'tombstone:result_missing'` ⇒ **不入 `suspect:*`**（避免与"未执行"类重复计数；池页若展示单列）。
- **定义句（逐字）**：**`unconfirmed_suspect` = 上表 `suspect:*` 四类的并集**；**不许**引入任何需要人判或随机数的判据。
- 一个单元可多命中 ⇒ `categories: string[]`（不许只留一个而丢信息）。

### 2.3 池查询（C3；只读）

`GET /v3/admin/attribution/audit-pool?category=&space_id=&limit=&offset=`

- 响应：`{ items: [{ audit_key, unit_id, round, category, categories[], verdict, judge_impl, rationale_ref, session_key, created_at }], counts_by_category, truncated }`；
- `category=` 过滤（缺省 = 全部类）；`counts_by_category` 为**过滤前**全类计数（自洽：与 items 的 category 可对账）；
- 鉴权/信封/无界纪律照 §1（缺 `since`/`limit` 语义此处以 `limit` 兜底：缺省 100、上限 1000）；
- **抽样（若需要）必须确定性哈希**（`hash(audit_key) % 100 < pct`）；**禁 `Math.random()`**；**本 spec 建议不引入随机抽查**（运维按 `category=` 筛 + 人工挑）。

### 2.4 状态机与写口（C4；本切片唯一新增写路径）

**新表 `attribution_audit_reviews`（append-only）**：

```sql
CREATE TABLE IF NOT EXISTS attribution_audit_reviews (
  review_id    TEXT PRIMARY KEY,   -- "ar_" + sha1(audit_key|prev_status|status|actor).slice(0,12)
  audit_key    TEXT NOT NULL,
  status       TEXT NOT NULL,      -- confirmed | dismissed | needs_fix
  prev_status  TEXT NOT NULL,      -- unreviewed | confirmed | dismissed | needs_fix
  actor        TEXT NOT NULL,      -- 必填（不许匿名）
  note         TEXT,               -- 选填（长度上限 2000）
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aar_key ON attribution_audit_reviews(audit_key, created_at);
```

- **状态 4 值**：`unreviewed`（初始；**物理上不落行**——"无行"即 unreviewed）/ `confirmed` / `dismissed` / `needs_fix`；
- **迁移表（写死；其余 ⇒ 400）**：

  | prev_status | 允许的 status |
  |---|---|
  | `unreviewed` | `confirmed` / `dismissed` / `needs_fix` |
  | `confirmed` | `needs_fix` / `dismissed` |
  | `dismissed` | `needs_fix` |
  | `needs_fix` | `confirmed` / `dismissed` |

  （**自迁移全禁**：`X → X` ⇒ 400。）
- **幂等锚**：`review_id = "ar_" + sha1(audit_key|prev_status|status|actor).slice(0,12)`——同迁移重放 ⇒ **duplicate**（含 `prev_status` ⇒ 多次真实迁移各得其锚、天然防重放）；冲突姿势照 `insertIdempotent`（`ON CONFLICT … DO UPDATE … RETURNING created_at`）。
- **写口**：`POST /v3/admin/attribution/audit-reviews`（body：`{audit_key, prev_status, status, actor, note?}`；`checkAdminAuth` 同 §1）：
  - `actor` 缺失/空白 ⇒ **400**（不许匿名默认）；`note` 超 2000 ⇒ 400；
  - 未知 `status` ⇒ 400；**非法迁移**（不在迁移表）⇒ 400；**`prev_status` ≠ 当前 latest 状态** ⇒ 400（乐观校验；**重放先行**——同 `review_id` 已存在 ⇒ 直接 duplicate、不做 prev 校验）；
  - 响应：`{code:0, message:"ok", data:{review_id, status, prev_status, kind: "inserted"|"duplicate"}}`。
- **语义边界（硬，写死）**：抽查状态**不驱动判定变更**——**不**写 `asset_used`/`asset_corrected`、**不**自动触发重判（重判仍由人显式跑 61 的 `--rejudge`）；状态**只服务审计**。**不做**用户级 ACL（同 §1 C3），但 `actor` **必记**。

### 2.5 物化触发条件（C5；句式照 60 spec §3）

> **池 = 查询层（不物化）**；**物化触发条件** = 实现单实测「`/audit-pool` 在 **≥10k units** 规模下 **P95 > 500ms**，或**必须跨全表排序**才能分页」⇒ 另立**物化单**（独立评审，不在本 spec 预建）。

---

## 3 L1 自动接线（69 回填；实现 = `src/attribution/l1-wiring.ts` + `worker.ts` CLI，commit `6546f5b`）

### 3.1 C1 入口与组合顺序（写死）

CLI（worker `main`）：`--correct-l1` + 范围三选一 `--session=<key>` / `--all-sessions --since=<ms|ISO8601>`（都不给 ⇒ `EXIT_L1_SCOPE_INVALID=5`，零扫描）；`--session` 与 `--all-sessions` 互斥、`--since` 仅搭 `--all-sessions`。

| 组合 | 行为 |
|---|---|
| 无 `--correct-l1` | 与未接线前逐字相同（零回归） |
| `--correct-l1 --session=X`（无 `--once`） | 只修正、不消费（可离线圈用） |
| `--correct-l1 --once` | **先抽干消费、后修正**（顺序写死） |
| `--all-sessions` 缺 `--since` | 拒绝（码 5，防无界全表扫） |

post-cycle：`runWorker` 的 `onIdle?: (consumedSessions) => void`（与 `onRound` 分开命名）——常驻=每次空转、`--once`=抽干结束各调一次；**缺省关**（`attribution.judge.worker.correctL1 = {enabled:false, minIdleMs:30000}`）。

### 3.2 C2 脏集

仅"**本进程消费过的 session**"（内存 Set 去重；不扩到 proxy 写入侧——corrected 信号前提是"回指已存在的 used 行"）。**登记**：fetched-only 漂移与进程重启后的丢失，由 CLI / 周期补扫覆盖。

### 3.3 C3 节流

脏集空 / 未到期 ⇒ **零动作**；同 session 相邻两次修正间隔 ≥ `minIdleMs`；一次扫完即从脏集移除。

### 3.4 C4 失败姿态

L1 异常必须被捕获：`failed` 计数 + stderr 一行 warn；**不改 cycle 计数、不改队列行状态、不退出**。

### 3.5 C5 观测

`L1Outcome` 六计数（`assetsScanned / assetsWithDrift / assetsSkippedNoVersion / correctedInserted / correctedDuplicate / failed`）落 stderr 一行；post-cycle 关闭时零新输出。

### 3.6 C6 定格口径

**引 68 D1（60 spec §5 "payload 新鲜度契约"）**：corrected 行版本字段 = 检测时（首次判定）快照；重跑 ⇒ duplicate、`payload_json` 逐字不变；**不得**修改 `insertIdempotent` 的 upsert 子句与锚公式（γ 已否）。

### 3.7 C7 只读/写入边界

L1 只**追加** `asset_corrected` 行；used/judgement 行零改写；会话枚举读口（两 repo 的 `distinctSessionKeys`）**只读**、DB 降级 ⇒ 空数组；不碰 proxy 写入路径；不做定时器（周期化 = 运维 cron）。
