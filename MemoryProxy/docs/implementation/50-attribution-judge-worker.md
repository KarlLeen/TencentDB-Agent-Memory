# 50 · S5 judge worker 判定主链

> **本文件当前只落 S5 的第一个交付单元**：落库侧四态判别式（1a/1b/2）与 worker 消费分支（3/4），含 known limitation（1c）。
> S5 其余部分（决策单元→候选分档 / shortlist / 全文核实 / 三道机械锚点 / `asset_used` 汇总 / 真 provider / `round>0` 重判 / `task_boundary`·`manual` 触发）**尚未定稿**，后续小节追加到本文件。
>
> 依据：design §4.3、红线 8、R2（NULL 唯一性陷阱）；上游交付单为"落库判别式 + worker 分支"。
> 验收编号：A1–A4（见 §7）。测量环境：`better-sqlite3 11.10.0`（SQLite `3.49.2`）、node `v22.19.0`。

---

## 1 问题：旧落库是一个"二态 + 假不变量"

旧实现（本交付单元之前）：

```sql
INSERT OR IGNORE INTO attribution_judgement_details (...)
```

`insertIdempotent()` 返回 `{judgementId, inserted: boolean}`，并以 `res.changes === 1` 作判别。

三条硬伤：

1. **判定异常被塞进 `ignored` 桶**。`ignored` 原本只该表示"崩溃后重放"（预期路径，info 级），但同
   `(unit_id, round)` 被**另一个 asset** 占用时也走同一条路 —— 一个真实异常被静默记成正常重放。
2. **`changes` 分不出 inserted / duplicate**：实测两者 `changes` **都是 1**（§3 表 B1/B2）。判别式必须换锚。
3. **`:55` 那句"`false` = 主键已存在" 是假注释**：`OR IGNORE` 同时吞掉主键冲突与任何唯一约束冲突，"false" 并不等价于"重放"。

## 2 设计：一条语句给出四态

### 2.1 1a · DDL：落点唯一性锚 = `(unit_id, round)`

`src/db/schema.ts`（**纯 additive + `IF NOT EXISTS`**，`SCHEMA_VERSION` 不动）：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_ajd_unit_round
  ON attribution_judgement_details(unit_id, round);
```

- 键里**不含** `asset_id`：`asset_id` 可空，若拿它入键就撞上 R2（SQLite 里 NULL 互不相等 ⇒ 未归因行无条件放行）。
- 确定性主键 `judgement_id = "jd_" + sha1(unit_id|asset_id|round).slice(0,12)` **保留不变**（红线 8 不变）。

### 2.2 1b · 定向 upsert + `RETURNING`

`src/attribution/judgement-details-repo.ts` 的 `insertStmt`：

```sql
INSERT INTO attribution_judgement_details (...)
VALUES (...)
ON CONFLICT(unit_id, round) DO UPDATE SET verdict = excluded.verdict
  WHERE attribution_judgement_details.asset_id IS excluded.asset_id
RETURNING created_at
```

三个要点：

- `ON CONFLICT(unit_id, round)`：冲突目标必须与 2.1 的唯一索引**逐字对齐**，否则 `prepare()` 直接抛
  `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`（§5 哨兵测试钉住了这条依赖）。
- `WHERE ... IS excluded.asset_id`：用 `IS` 而不是 `=`，让 `asset_id IS NULL`（未归因）也能正确判"同 asset"。
- `RETURNING` 是判别 inserted/duplicate 的**唯一**依据；读回用 `Statement.get()`（`.run()` 拿不到返回行，
  且 `changes` 不可用 —— 见 §3）。

### 2.3 2 · 四态判别式

```ts
export type JudgementDetailInsertKind = "inserted" | "duplicate" | "anomaly" | "failed";

export interface InsertIdempotentResult {
  judgementId: string;
  kind: JudgementDetailInsertKind;   // 机器可读，调用方不得靠日志文案/last_error 区分
}
```

| `kind` | 触发条件（实测口径） | counters | 语义 |
|---|---|---|---|
| `inserted` | 有返回行 **且** `row.created_at === 本次传入的 createdAt` | `inserted += 1` | 本次新落一行 |
| `duplicate` | 有返回行 **且** `created_at` 是库里旧值 | `ignored += 1` | 同 `(unit_id, round)` 同 asset 的重放（预期路径，`console.info`） |
| `anomaly` | **无返回行**（`WHERE` 不匹配） | `anomaly += 1` | 同 `(unit_id, round)` 已被**另一个 asset** 占用（`console.warn`） |
| `failed` | `get()` 抛错 | `failures += 1` | 未点名约束冲突 / 写入异常（例：sha1 截断撞主键、DB 降级） |

`counters` 新增 `anomaly` 桶；`ignored` 语义**收窄**为"只表示 duplicate"（字段名沿用，A4 口径不变）。

## 3 实测矩阵（真驱动，非推断）

同一套场景在两个独立内存库上分别用 `.get()` 与 `.run()` 各跑一遍（每格只执行一次语句）：

| 场景 | `changes` | `RETURNING` | 判别 |
|---|---|---|---|
| B1 新行 `(u1,r0,asset-A)` `t=1000` | 1 | `{created_at:1000}` | `inserted` |
| B2 重放同 asset `t=2000` | **1** | `{created_at:1000}`（旧值） | `duplicate` |
| B3 同 `(u1,r0)` 异 asset `t=3000` | 0 | 空 | `anomaly` |
| B4 异 `(u1,r1,asset-A)` `t=4000` | 1 | `{created_at:4000}` | `inserted`（锚是二元组） |
| B5 `asset_id=NULL` 首插 `t=5000` | 1 | `{created_at:5000}` | `inserted` |
| B6 `NULL` 重放 `t=6000` | 1 | `{created_at:5000}` | `duplicate`（NULL 被覆盖住，R2 不成立） |
| B7 `NULL → 有值 asset-C` `t=7000` | 0 | 空 | `anomaly` |
| B8b 重放，`createdAt` 与库里**同一毫秒** | 1 | `{created_at:t}`（== 传入值） | ⚠️ 误判成 `inserted` —— known limitation §6.1 |
| B8c 重放，`createdAt = t+1`（进程内单调） | 1 | `{created_at:t}` | `duplicate` ✔ |
| B10 只撞 `judgement_id`（`(unit_id,round)` 不冲突） | THROW `UNIQUE constraint failed: ...judgement_id` | — | `failed` |
| B11 `DO NOTHING` 首插 / 重放 / anomaly | 1 / **0** / **0** | 行 / **空** / **空** | ⚠️ duplicate 与 anomaly **同形** —— §5 哨兵 |

**B8b 是 1c 的 known limitation 实证；B11 是"简化会毁掉判别式"的实证**（重放与异常都 `changes=0`、都无返回行）。

## 4 worker 分支（3）与 cycle 结果（4）

`src/attribution/worker.ts` 的 `consumeRow()` 由"二态"改为四态分流：

- `inserted` / `duplicate` ⇒ **才可以** `complete()` 结算租约；计数分别进 `completed` / `idempotent`；
  `complete()` 返回 false 时照旧 `leaseLost += 1`。
- `anomaly` ⇒ `result.anomaly += 1`，**不进 `errored`**；走 `fail()`，按返回分桶 `deadLettered` / `requeued`。
- `failed` ⇒ `result.errored += 1`；同样走 `fail()`。
- `anomaly` / `failed` 与 `catch` 共用同一条 `failAndReport()`（fail → 分桶 → `status:"error"` 日志 → 退避），
  避免两处各写一遍退避逻辑。

`AttributionWorkerCycleResult`（3/4 同一批）：

- **新增** `anomaly: number`（`emptyCycleResult()` 与 `main()` 的退出摘录同步）。
- **删除** 幽灵字段 `retried: number`：全仓只有声明与初始化两处，无任何读方（不是"接不上真实语义"，
  而是语义被 `requeued` 完整覆盖）⇒ 直接删，不留给下一个新字段照抄它的死法。

日志渠道不变（`JudgeLogStatus = "ok" | "idempotent" | "error"`）：anomaly/failed 落 `status:"error"` + `error` 文案，
但**机器判别只认 `result.anomaly` / `counters.anomaly`**，不解析 `last_error` 文本。

## 5 反简化回归哨兵（三组破坏性实测）

`ON CONFLICT ... DO UPDATE ... WHERE` 是整套判别式的机关，极易被"优化"成 `OR IGNORE` / `DO NOTHING` / 去掉 `WHERE`。
把三种简化**真替进 `insertStmt` 各跑一遍**（每次跑完还原工作区），实测：

| 简化变体 | 变红的用例 | A3 那条 | 重放那两条 |
|---|---|---|---|
| `ON CONFLICT ... DO NOTHING` | T5 主用例、T5 NULL 用例 | **✓ 仍绿** | ✗ 红 |
| `INSERT OR IGNORE`（回到旧写法） | T5 主用例、T5 NULL 用例 | **✓ 仍绿** | ✗ 红 |
| `DO UPDATE` **去掉条件 `WHERE`** | "不同 round / 换 asset"、A3 | ✗ 红 | ✓ 绿 |

**结论（与直觉相反，回归测试必须按此设计）**：没有任何单一用例能兜住全部简化 ——

- **吞型简化**（`OR IGNORE` / `DO NOTHING`）让**重放被误判成 `anomaly`**（无返回行），只有重放用例（A4）能发现；
  A3 反而因为"无返回行 ⇒ anomaly"被**误打误撞满足**，**不会**变红。
- 反过来，去掉条件 `WHERE` 才会让 A3 变红。

⇒ **A3 与 A4 必须同时在**，缺一个就有一整类简化能溜过去。（本文件早期草稿曾断言"A3 立刻变红"，已被上述实测推翻。）

另有一道原理性对照（同文件"反简化哨兵"用例）：对同 DDL 上的 `DO NOTHING` 语句直接实测 ——
首插有返回行，**重放与 anomaly 都无返回行**、`changes` 也都是 0 ⇒ 吞型简化在原理上无法区分这两态（表中 B11）。

`ON CONFLICT` 目标必须与唯一索引逐字对齐这条依赖，也被哨兵测试的**红因**钉住：索引缺失时
`prepare()` 抛 `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`。

## 6 known limitations（1c）

### 6.1 同毫秒重放（已在实现里消掉，残留跨进程边界）

判别依据是"`RETURNING.created_at` 是否等于本次传入值"。若直接用 `Date.now()`，**同一毫秒内的重放**
会与库里旧值相等 ⇒ 被判成 `inserted`（实测见 §3 B8b）。

**修法（已落地）**：`nextCreatedAt()` 保证**进程内严格单调**：

```ts
lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
```

> 注：等价的直觉写法 `Math.max(Date.now(), ++last)`（自增计数器）**不保证单调** —— 当 `Date.now()` 不变时，
> `++last` 给出 1/2/3… 都小于 `now`，取 max 之后仍是同一个值。必须是"与上一次**返回值**比较"。

**残留**：跨进程仍可能与另一进程写入的时间戳相等（需要两进程对同一 `(unit_id, round)`、同一毫秒写同 asset 才可能）。
影响面仅"计数分桶偶尔多算一个 `inserted`"，**不造成静默丢数据**（行不会丢、不会重）。

### 6.2 `duplicate` 会覆盖 `verdict`

`DO UPDATE SET verdict = excluded.verdict` 下，重放若带了不同 `verdict`，**后到者覆盖前者**；
而 `detail_json` 保持首写（`DO UPDATE` 不动它）。

- 本交付单元**保持现状**（不改成 `DO NOTHING` —— 那会连带毁掉 anomaly 判别，见 §5）。
- 需要"首写不可覆盖"时再单独立项（届时必须保留 anomaly 判别能力，例如 `SET verdict = verdict` 之类的白写）。
- 测试口径同步：`judgement-details-repo.test.ts` 只断言 `detail_json` 未被覆盖，**不再**声称"原行完全不被改"。

### 6.3 存量库升级：已有重复 `(unit_id, round)` 行会让唯一索引建不起来

旧语义（仅主键幂等）允许同一 `(unit_id, round)` 因 asset 不同落**多行**。实测：

```
旧库 (u9,r0) 行数 = 2（旧语义允许 anomaly 双行）
建索引 THROW: UNIQUE constraint failed: attribution_judgement_details.unit_id, attribution_judgement_details.round
```

该索引在 `SCHEMA_SQL` 里，**建失败会连带整个 `exec` 失败 ⇒ `getDb()` 返回 null（整库降级）**。
这是"升级路径"上唯一比现状更糟的点，处置口径：

- 该表是**可重建的派生物**（基座 §3：本地清表零数据风险）；
- 升级前需清掉重复行（`DELETE` 掉非首见行）或直接重建该表；
- 本交付单元**不做**自动去重（删数据不在授权范围内），仅在此登记。

### 6.4 `asset_id` 为 NULL 的行不能靠"换 asset"区分

`B5/B6/B7`：未归因行（`NULL`）与"先 NULL 后有值"的情形，其 `anomaly` 语义与普通异 asset 一致 ——
因为锚 `(unit_id, round)` 不含 asset。这是设计意图（R2 的正面证明），不是缺陷。

## 7 验收 A1–A4（红→绿，同一批文件、同一台机）

**红**（未改实现，只先改/加测试）：

```
Test Files  4 failed (4)
     Tests  9 failed | 30 passed (39)
```

**绿**（改完 1a/1b/2/3/4 后）：

```
Test Files  4 passed (4)
     Tests  39 passed (39)
```

| 编号 | 断言 | 红 | 绿 |
|---|---|---|---|
| A1 | 落库 `failed` ⇒ `complete()` 零次、`fail()` 恰一次、只进 `errored` | ✗ | ✓ |
| A2 | 落库 `anomaly` ⇒ `result.anomaly === 1` 且 `errored === 0` | ✗ | ✓ |
| A3 | 真 repo + 唯一索引：同 `(unit_id, round)` 换 asset ⇒ `anomaly` 且库里恰 1 行 | ✗ | ✓ |
| A4 | 重放 ⇒ `kind === "duplicate"`、`counters.inserted` 仍 1、`counters.ignored` +1 | ✗ | ✓ |

分母说明：红与绿**同为 39**（4 个文件），红里 9 个失败 = 4 个新用例（A1/A2/A3/哨兵）+ 5 处既有断言迁移。

## 8 语义变更声明（既有测试口径改动 5 处）

| 文件 | 位置 | 旧口径 | 新口径 | 理由 |
|---|---|---|---|---|
| `judgement-details-repo.test.ts` | T5 主用例 + NULL 用例 | `res.inserted === true/false` | `res.kind === "inserted"/"duplicate"` | 二态 → 四态 |
| `judgement-details-repo.test.ts` | T5 "不同 round / 不同 asset" | 三条落 **3 行** | 第三条判 `anomaly`，落 **2 行** | **语义变更**：`(unit_id, round)` 成为唯一落点 |
| `db-degraded-singletons.test.ts` | 矩阵 5/6 Null 实现 | `inserted === false`（"不伪造成功"） | `kind === "failed"` | 无 DB ⇒ 未落库，既非 inserted 也非 duplicate（库里并无该行） |
| `citation/__tests__/source.test.ts` | T17 归档回读 | `res.inserted === true` | `res.kind === "inserted"` | 同上（断言点未在交付单里列出，属本次补齐） |

> 交付单只点了 `judgement-details-repo.test.ts` 的 4 处；实际依赖旧布尔语义的断言共 **5 处**（另两处在
> `db-degraded-singletons.test.ts` 与 `citation/__tests__/source.test.ts`），已一并迁移 —— 漏改会留下
> `undefined` 直判的假绿。

## 9 后续（S5 未完部分，按依赖序）

1. 决策单元锚定：`bridgeFetchEvents` 行**无 `turn_seq`**，如何锚到决策单元（45 spec §7 明确留给 S5）。
2. 候选分档（fetched / injected）+ shortlist + 全文核实 + 三道机械锚点。
3. `asset_used` 汇总与 outcome/validated 链接；`excluded` 清单形状（`citation/source.ts` 留有 `TODO(50 spec)`）。
4. 真 provider 替换 deterministic mock；`round>0` 重判路径；`task_boundary` / `manual` 触发。
5. 消费侧：tombstone（unknown + resultMissing）、双通道一致性、top-N 截断移交判定侧、F4 metadata key 统一。

## 10 决策单元锚定（fetched 行 → 决策单元；55 落地）

> 本节是 §9 第 1 项的交付。前置事实（全部复核到 `129e1e8`；出处 = `51-anchoring-decision-brief.md`
> §1.2/§2/§3 K1–K4 + `51-p0-probe-report.md` + `52` 的 e2e 哨兵）：
> ① 键已可 join —— fetched 与 units 同 `session_key`（51；`bridge-fetch-events-e2e.test.ts` 用例 12 钉死）；
> ② fetched 行 `turn_seq`/`msg_seq`/`unit_id` 一律 NULL（`src/attribution/bridge-fetch-events.ts`，"不伪造"）⇒ 锚定只能靠**序**；
> ③ 时序反直觉 —— 抓取所属单元在抓取**之后**才落行（brief §2 / K1）⇒ "取前一个单元"系统性错一轮；
> ④ 时间窗分辨率到"轮"（K2：同轮多单元同批 `appendMany` 落行，`listBySession` 同毫秒按随机 `event_id` 排）；
> ⑤ `created_at` 是墙钟可回拨（K4）；`rowid` = 真实插入序（无 `AUTOINCREMENT` + 全仓无 `DELETE FROM attribution_events`）。

### 10.1 C1 · 输入域与输出类型

纯函数（零 IO；实现于 `src/attribution/fetched-anchoring.ts`）：

```ts
anchorFetchedRows(rows: SessionEventRowLite[]): AnchoredFetchedRow[]
// rows = 事件行（须显式带 rowid，见 C4②；可含多个 session，函数内按 session_key 分组）
type FetchedAnchorVerdict =
  | { kind: "in_turn"; turnSeq: number }
  | { kind: "unresolved"; reason: "head" | "tail" | "boundary" | "non_monotonic" };
```

- 每条 `asset_fetched` 行产一个判定；**输出不得含 `unit_id`**（④：分辨率到"轮"为止；
  挂具体 unit_id = 在同轮多单元里任选一个并报成功，禁）。
- 签名相对 55 工单 C1 的"建议双参"有一处**有意偏离**：单参 `rows`（函数内按 `session_key` 分组）——
  理由：(a) 跨会话隔离（T7）由分组天然保证；(b) C2 的 `non_monotonic` 自检需要夹缝内**全部事件行**
  （不限类型），双参形状拿不到。

### 10.2 C2 · 判定真值表（按 rowid 序）

对每个 session：行按 `rowid` 升序；unit 行 = `event_type = 'decision_unit.created'` 且 `turn_seq` 非 NULL。
对每条 fetched 行 F，取 rowid 前最近的 unit 行 prev、后最近的 unit 行 next：

| # | 情形（按优先级自上而下） | 判定 |
|---|---|---|
| 1 | F 的**夹缝**（闭区间 `[prev.rowid, next.rowid]`，缺侧取会话边界）内**全部事件行**（不限类型）的 `created_at` 沿 rowid **非单调**（出现严格下降；同毫秒并列不算） | `unresolved(non_monotonic)` —— ⑤：该段时间不可信，只否决、不肯定 |
| 2 | 无 prev | `unresolved(head)` |
| 3 | 无 next | `unresolved(tail)` |
| 4 | `prev.turn_seq ≠ next.turn_seq` | `unresolved(boundary)` —— **禁猜方向**（③：取"前一个"系统性错一轮；取"后一个"在尾部甩给不存在的单元） |
| 5 | `prev.turn_seq = next.turn_seq = t` | `in_turn(t)` |

### 10.3 C3 · 定序与窗口

- **`rowid` 是唯一定序键**（插入序；允许有空洞，只要求单调，不得假设 `rowid = prev + 1`）。
- `created_at` **不参与裁决**：仅用于 (a) `non_monotonic` 自检（C2 第 1 行，K4 处置③）；
  (b) 展示/窗口宽度。候选池 = 同 session 全部 unit 行，**不做时间窗裁剪**。
- 前提声明（brief §1.2 警告段）：锚定基于**插入序**，不声称等于全局真实发生序 ——
  延后落库（缓冲 / 下一 tick / 队列）会按**确定的代码路径**错开：这是可审计的确定性偏差，
  不是墙钟回拨那种随机偏差。本节只量"边界不可判定"的占比，不用来证明"插入序 = 真序"。

### 10.4 C4 · 两条承重前提（违反即整套失效，写死）

1. **将来对 `attribution_events` 加任何删除**（保留策略/清理）⇒ `max(rowid)` 回落、rowid 被复用
   ⇒ **必须同批加 `AUTOINCREMENT`**，否则本节地基失效。
2. **新读口必须显式 `SELECT rowid`**（既有 `listBySession` 是 `SELECT *`、不含 rowid）。
   本节配套读口 = `AttributionEventRepo.listBySessionWithRowid(sessionKey)`（`SELECT rowid, * …
   ORDER BY rowid ASC`，**无 LIMIT** —— 锚定需要会话全量，截断 = 伪造夹缝）。

### 10.5 C5 · 消费方声明（防陷阱 14 死代码）

- 第一消费方 = **§9 第 2 项候选分档（下一单）**；本轮**不接** judge 队列 / worker（接上 = 扩面）。
- 本轮的消费证明 = **P-0a 复测 harness 调生产函数 `anchorFetchedRows`** 跑 51 后真库快照
  （不许 test-only 平行实现），判定分布（分母 = fetched 行数）进 55 报告。

## 11 证据供给与候选分档（漏斗②③；56 落地）

> 本节是 §9 第 2 项第一刀的交付（② 证据供给 + ③ 候选分档合并；④ shortlist + ⑤ 三道机械锚点属 57）。
> **取代登记**：brainstorm §2 ② 写于 55 之前，其 fetched 路"按 `created_at` 后向窗口切分"一句
> **被 §10 取代**（锚定以 rowid 定序 + 四态门控为准；brainstorm 不回改）。
> **D7 纪律修订**（brainstorm B1 原话，`enqueue.ts` 头注原写"worker 只读队列行，不 v1 回查"）：
> 修订为"**worker 只读队列行 + 只读证据 provider；provider 零写、不推进水位**"。`enqueue.ts` 头注
> 已 append 指针（不改其运行行为）。

### 11.1 C1 · 两路形状

单元轮次来源 = 队列 `payload_json` 的 `turnSeq`（`enqueue.ts` 入队时已带；worker 的 `safeParsePayload`
扩解该字段，**不改队列 DDL、不改 enqueue**）；缺失 ⇒ 按"永不匹配的轮"处理（两路空，不猜）。

- **injected 路** = `injection.hook.done` 行（`asset_id IS NOT NULL`，按 **`turn_seq` 列**对齐当前单元轮）
  ∪ 队列 payload `visibleAssets`（restraint 便捷路径，`decision-units/types.ts` A2 快照）。
- **fetched 路** = `asset_fetched` 行，**经 §10 锚定门控**：
  - `in_turn(t)` 且 `t ==` 当前单元轮 ⇒ **进候选**；轮次 `t` 的落点 = `detail_json.evidenceSupply.fetchedTurnSeq`
    （双源时另见 `dualSource[].fetchedTurnSeq`），**不进 `JudgeCandidate`** —— 契约零改动；
  - `head / tail / boundary / non_monotonic` ⇒ **不进**，按原因分别计数（不许"带标记进"）；
  - `in_turn` 但**非当前轮** ⇒ 不进，计入 `fetchedOtherTurn`；
  - `asset_id` 为 NULL ⇒ 不进（brainstorm A3：有抓取行为 ≠ 用了哪个资产），计入 `fetchedNoAssetId`。
- 重复行去重（brainstorm A2）：同 `assetId` 重复按 `(created_at ASC, rowid ASC)` **取首见**；
  锚定已排除 `non_monotonic` ⇒ 进候选段内该序与 rowid 序等价。

### 11.2 C2 · 合并规则（= "分档"的真实含义）

同 `assetId` 双源 ⇒ **一条候选，`fetched` 优先**（`evidenceSourceType: "fetched"`）。
双源事实**不进 `JudgeCandidate`**（契约零改动），落 worker 写 judgement 时的 `detail_json.evidenceSupply.dualSource`
（`assetId / assetType / fetchedTurnSeq / injectedVia("hook.done"|"visibleAssets")`）。
**候选顺序写死**（mock judge 按顺序取第一个命中，T7 依赖确定性）：
fetched 路按 `(created_at, rowid)` 首见序在前，injected 路新增资产在后（hook.done 按 `(created_at, rowid)`，
visibleAssets 按原数组序）；双源合并不新增位置。

### 11.3 C3 · 标注规则

`evidenceSourceType` 由**来源**决定：fetched 路 ⇒ `"fetched"`；injected 路两分支 ⇒ `"injected"`。
`worker.ts` 候选组装处的 `"injected"` 硬编码删除（B1 第二处独立缺陷）。

### 11.4 C4 · 只读边界与降级

- provider 全路径**零写**（T25 姿势：跑完后 `getAttributionWriteCounters()` 增量全 0 +
  `attribution_archive_watermark` 行数不变）；一次 `listBySessionWithRowid` 读会话全量，**不重复读库**。
- DB 降级（Null repo）⇒ 两路空、**保留 payload `visibleAssets` 便捷路径**（不失联）。
  ⇒ 无证据行时 provider 输出与旧路径（`extractJudgeCandidates`）**逐字节一致**。

### 11.5 C5 · 消费方（同单落地，防陷阱 14）

- worker `consumeRow` 候选组装**换调 provider**（`deps.evidenceSupply`；缺省回退旧路径
  `extractJudgeCandidates` —— 单测兼容；生产 `buildWorkerDeps` 总装真 provider）。
- 可观测计数落 `detail_json.evidenceSupply.stats`，**分母齐全**：
  `fetchedRows = fetchedIn + head + tail + boundary + non_monotonic + fetchedOtherTurn + fetchedNoAssetId`；
  另 `injectedInHookDone / injectedInVisibleAssets / mergedDualSource / injectedDuplicate`。
  （`fetchedOtherTurn` / `fetchedNoAssetId` / `injectedDuplicate` 三桶是对工单计数清单的**补充** ——
  无它们分母凑不齐；`injectedDuplicate` = injected 两分支互撞去重（hook.done ∩ visibleAssets，同 assetId），
  **不算**双源合并 —— `mergedDualSource` 只计 fetched ∩ injected。）

## 12 shortlist 与三道机械锚点（漏斗④⑤；57 落地）

> 本节是 §9 第 2 项第二刀的交付。**边界**：只出度量、零阈值零布尔；⑥ 裁决/阈值 = B5 标定单另开；
> DR-6 两类 golden 样本（版本漂移引用正例 / 双通道一致性抽样）**登记为 B5 标定单的交付物**
> （与 P-3 标注集 N≥20 同批；本单不做，但不许丢）。

### 12.1 C1 · shortlist（成本闸门）

- **排序键 = §11.2 已钉的顺序**（fetched 首见 → hook.done → visibleAssets），**不重排** ——
  ④ 在 ⑤ 之前 ⇒ 排序键本就不能用度量（鸡生蛋）；mock judge 按序取第一个命中（`deterministic-mock-judge.ts:77`），
  任何重排都会改 verdict。
- **K = 16（写死，非 config）**：保险丝不是常态路径（fan-out 命中集不进候选，brainstorm A4 ⇒ 候选 = 实际资产数）；
  分布依据 = 57 报告的候选计数直方图（多形态实测，含高扇出构造；若不支持 16 则改值并写理由）。
- **前 K 喂 judge；溢出 = 计数 + assetId 清单落 `detail_json.shortlist`**（"不丢弃" = 可观测，不是全喂）。
- **度量只对前 K 计算**（这才是闸门语义；全量算 = 没有闸门）。

### 12.2 C2 · 三道机械锚点（逐候选，只出度量）

**引文口径（写死，不许新造）**：引文 = `sessionWindow` 中 `turnSeq == 当前单元轮` 的 **pieces**
（档① block + 档② message，`(turn_seq, tier, seq)` 窗口序）；piece 文本 = `visibleTextOfPiece(piece)`
（`citation/visible-text.ts` 唯一口径）。**逐 piece 比对**，取最强结果（piece 序 + 级别序，确定性）。
**资产侧文本** = `sessionAssetTexts(sessionKey).get(assetId)` 的片段，各经 **c2 剥离**后按首见序拼接
（"模型看到的注入文本 ↔ 资产自身正文"对齐口径，design §4.8.3）；资产文本缺失 ⇒ 走 C3 的 `null` 路径（不猜）。

1. **引文归一化命中**：对每个 piece，按 `exact → whitespace → punctuation` 逐级
   `normalizeForMatch(piece文本, level) ⊆ normalizeForMatch(资产文本, level)` 判定；
   **命中级别 = 所有 piece × 级别中的最强级**（exact > whitespace > punctuation），全不命中 ⇒ `none`。
   **命中文段** = 首个最强命中的 piece 文本（供 ②③ 使用）。
2. **稀有度覆盖**：`gramCoverage(windowText = 命中文段, quote = 资产文本, rarityTable())` ——
   **资产文本**的 distinctive grams 被命中文段（引文）覆盖的比例（"这次引用覆盖了资产内容的多少
   独特成分"；反接则恒 1：命中 ⇒ 引文 ⊆ 资产 ⇒ 引文的 gram 全在资产里，度量失效）
   ⇒ `coverage / distinct / covered / n`；**NaN ⇒ 显式 `unknown`**（`isCoverageKnown` 门禁，绝不落 0/1）；
   无命中（`none` / `null`）⇒ `unknown`（无 quote 依据）。
3. **排他性**：命中文段在同会话**其他**资产文本（`sessionAssetTexts` 去掉本资产，c2 剥离后）中
   **exact 级**（原字节，最严 —— 归一化放大会夸大排他反证的证据等级）子串命中的**资产数**（只出数字）。

### 12.3 C3 · 输出形状（零阈值零布尔）

每候选（前 K）一份，落 `detail_json.citationMetrics[]`：

```ts
{ assetId, matchLevel: "exact"|"whitespace"|"punctuation"|"none"|null,
  matchedTier: "block"|"message"|null,          // 命中 piece 的层（审计；未命中/无文本 ⇒ null）
  coverage: number | "unknown", coverageDistinct: number, coverageCovered: number,
  exclusionCount: number, ngramTableSha256: string }
```

- `matchLevel: null` = **无资产文本可比**（fetched 资产未注入 ⇒ 档①无其文本；不知道就不写，别猜）；
  此时 `coverage="unknown"`、`exclusionCount=0`。
- `ngramTableSha256` 随每候选落（design §4.8.4 的可复算要求）。
- `detail_json.shortlist = { k, total, overflowCount, overflowAssetIds[] }`（C1 的溢出可观测）。

### 12.4 C4 · 只读边界

全路径零写（T25 姿势：写计数增量全 0 + `attribution_archive_watermark` 行数不变）；
`rarityTable` 只在内存构建（c4 懒缓存复用）；`sessionWindow/sessionAssetTexts` 只 SELECT。

### 12.5 C5 · 消费方（同单落地）

worker `consumeRow`：候选（§11 供给）→ **shortlist（前 K）→ judge**；`grading.ts` 对前 K 逐候选出度量 →
`detail_json.citationMetrics` + `detail_json.shortlist`。供给层（§11）一行不动。

## 13 裁决与阈值（漏斗⑥；58 落地）

> 本节是 §9 第 2 项收尾（⑥）的交付。**结构**：S2 标定（标注集 + 扫描表 + 指纹）先于 S3 入码；
> 阈值未标定 ⇒ `mechanical` 不上线（B5 红线：缺省关闭）。

### 13.1 C0 · 裁决 ↔ judge 的关系（定死）

- 新增**确定性 Judge 实现 `mechanical:v1`**（实现既有 `Judge` 接口；`create-judge.ts` 注册 provider id
  `"mechanical"`；`AttributionJudgeProviderId` 扩为 `"mock" | "mechanical"`）。**mock 与既有 golden 不动**。
- 度量入参接缝：`JudgeInput` 加**可选**字段 `citationMetrics?: CandidateCitationMetrics[]`
  （可选 ⇒ golden / 既有契约不破）；worker **无条件**把当次度量随调用传入（mock 不读该字段 ⇒ 行为不变）。
  mechanical 缺该字段 ⇒ **全 `unconfirmed` + 计数**（不猜）。
- **mechanical 不绕过 worker 自己重算度量**（两份度量 = 52 教训）：度量唯一来源 = §12 `grading.ts` 的产物。

### 13.2 C1 · 裁决规则（语义写死；数值 `T_COV` / `T_EXCL` 由 S2 标定填充）

**候选级结论**（逐候选，全格子枚举）：

| matchLevel | coverage | exclusionCount | 候选级结论 |
|---|---|---|---|
| `null`（无资产文本） | * | * | `unconfirmed`（不猜） |
| `none` | * | * | `unconfirmed`（缺席非反证，K3） |
| exact / whitespace / punctuation | `unknown` | * | `unconfirmed`（NaN 门禁，不进比较） |
| exact / whitespace / punctuation | `< T_COV` | * | `unconfirmed`（覆盖不足 = 证据弱，非反证） |
| exact / whitespace / punctuation | `≥ T_COV` | `≤ T_EXCL` | **confirmed 候选** |
| exact / whitespace / punctuation | `≥ T_COV` | `> T_EXCL` | **refuted 候选**（引用不排他 ⇒ 驳斥该候选） |

**汇总**（B2 改判 (a)：一次调用只出**单一最强归因**）：

1. 有 confirmed 候选 ⇒ `confirmed` + `assetId` = 最强者（全序：matchLevel 强度降序（exact > whitespace >
   punctuation）→ coverage 降序 → exclusionCount 升序 → §11.2 候选顺序）。
2. 无 confirmed、有 refuted 候选 ⇒ `refuted` + `assetId` = 最强 refuted 候选（同序）。
3. 否则 ⇒ `unconfirmed` + `assetId = null`。
4. `candidates.length === 0` ⇒ **显式 `unconfirmed`**（B5 原话：不得静默 false）。
5. 护栏断言：`verdict.assetId ∈ candidates ∪ {null}`（mechanical 按构造满足，仍写断言）。

### 13.3 C2 · "四类覆盖"定义（P-3 未指明 ⇒ 本单定死）

标注集 **N ≥ 20**，四类**每类 ≥ 5**；四类必须**同时**张成 `{injected, fetched} × {正例, 反例}` 两轴
（正例 = 期望 `confirmed`；反例 = 期望非 confirmed（`refuted` / `unconfirmed`））；
含 **≥1 条版本漂移正例**（DR-6a：注入 v1 → 库存改 v2 → 引文仍命中**档①锚版** v1 ⇒ 按锚版判；
锚版 = 会话存档窗口（档①/档②），**不得回查当前资产存储**）与 **≥1 组双通道样本**（DR-6b：
同逻辑会话 anthropic / openai 两形状 ⇒ 度量与 verdict 逐条一致）；含 **≥2 条边界类**
（空语料 / 无资产文本 / `unknown` coverage）。
**fetched 正例只能构造为双源场景**（只抓不注 ⇒ 档①无其文本 ⇒ 恒 `null` ⇒ `unconfirmed`）。

### 13.4 C3 · 阈值形态

`T_COV` / `T_EXCL` 常量**写死**在实现模块（带标定指纹 + 扫描表出处注释，照 `SHORTLIST_K` 姿势），
**不进 config**；改阈值 = 改码 + 重跑标定（S2 全套）。

### 13.5 C4 · 缺省关闭

`provider` 缺省 `"mock"` 不变；`mechanical` **显式配置**才启用（B5：未标定 ⇒ toggle 缺省关闭）。
配置类型（`types.ts` 的 judge config）扩枚举 = 最小改动 + 语义变更声明。

### 13.6 标定指纹（S2 已完成，2026-09-11）

- 标注集：`src/attribution/judge/__tests__/fixtures/verdict-calibration-cases.json`（入库）；
  **sha256 = `b92698e383379f5fef268ac613ae515d7f6c869437245e7324292a3df48a137c`**；**N = 25**
  （injected 正/反 各 5 + fetched 正/反 各 5 + DR-6a×1 + DR-6b×1 组（2 条）+ 边界×2；真链路 11 / 构造 14）。
- 阈值扫描表：`/tmp/58/scan-table.json`（探针，不入库）。网格 `T_COV ∈ {0.3…0.9}` × `T_EXCL ∈ {0,1,2}`：
  **满分组合三个（T_COV = 0.4 / 0.5 / 0.6 × T_EXCL = 0，exact 25/25，P = R = 1.000）**；
  选点 **`T_COV = 0.5`、`T_EXCL = 0`** —— 满分组合中位（上下各 0.1 余量；几何上恰是 0.38（误报临界）
  与 0.62（漏报临界）的中点）；T_EXCL ≥ 1 会误判全部 4 条排他反例（exact 21/25）。
- 可复现指纹 = 标注集 sha256（上）+ `ngramTableSha256`（随每条度量落 `detail_json.citationMetrics`）
  + 扫描参数（网格范围见上；`minIdf` 缺省 0；`n = 4`）。
- 标定驱动 / 扫描探针：`/tmp/58/scripts/zz-calib-drive.tmp.mts` / `zz-calib-scan.tmp.mts`（不入库）。

## 14 状态事件落点与 excluded 类别（§9 第 3 项；59 落地）

> 本节是 §9 第 3 项（`asset_used` 汇总与链接）的前半：判定产物第一次**落自己的表**。
> **红线 6**（再申明）：v1 `attribution_events` **只读**，判定产物走新表（B3 改判——写 v1 表 =
> P-2 确定性碰撞成因）；`attribution_audit` 抽查池属 §9.5，本单不建。

### 14.1 C1 · 表形状（命名定稿，红线 5）

`attribution_status_events`（schema.ts 纯 additive DDL，`SCHEMA_VERSION` 仍为 1）：

```sql
CREATE TABLE IF NOT EXISTS attribution_status_events (
  status_id      TEXT    PRIMARY KEY,   -- "se_" + sha1(unit_id|asset_id|round).slice(0,12)（asset_id null ⇒ "" 占位）
  unit_id        TEXT    NOT NULL,
  session_key    TEXT    NOT NULL,
  space_id       TEXT    NOT NULL DEFAULT '_default',
  asset_id       TEXT    NOT NULL,      -- 本单恒非空（仅 confirmed+非空才写）；派生期 null ⇒ "" 占位（防未来事件型）
  asset_type     TEXT,
  round          INTEGER NOT NULL DEFAULT 0,
  event_type     TEXT    NOT NULL,      -- 本单唯一值 "asset_used"（validated/corrected 属消费侧，禁写）
  outcome        TEXT,                  -- 单元自带 resultStatus 时落；否则 NULL（不猜）
  turn_seq       INTEGER,               -- 恒 NULL（F4：不伪造轮次）
  msg_seq        INTEGER,               -- 恒 NULL
  payload_json   TEXT    NOT NULL,      -- 链接字段（C4），只回指不复制判定内容（F6）
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ase_unit    ON attribution_status_events(unit_id);
CREATE INDEX IF NOT EXISTS idx_ase_session ON attribution_status_events(session_key, created_at);
CREATE INDEX IF NOT EXISTS idx_ase_asset   ON attribution_status_events(asset_id, created_at);  -- 汇总查询（C4）
```

命名定稿：表 `attribution_status_events`；主键 `status_id`（前缀 `se_`）；本单唯一 `event_type = "asset_used"`；
索引名 `idx_ase_unit` / `idx_ase_session` / `idx_ase_asset`。

### 14.2 C2 · 触发真值表（`verdict × assetId` 全格子）

| verdict | assetId | 动作 | 计数桶 |
|---|---|---|---|
| `confirmed` | 非空 | `insertIdempotent`（写 `asset_used`） | `inserted` / `duplicate` / `failures` |
| `confirmed` | `null` | **不写**（护栏违反，构造上不可能） | `guardViolations` + warn |
| `refuted` | * | **不写**（状态机无 refuted 态；不计入"使用"） | `skippedRefuted` |
| `unconfirmed` | * | **不写** | `skippedUnconfirmed` |

写/不写都有可观测计数（F5）⇒ repo counters =
`{ inserted, duplicate, failures, guardViolations, skippedRefuted, skippedUnconfirmed }`
（`getAttributionStatusEventsCounters()` 暴露；`__reset...ForTests` 清零）。

### 14.3 C3 · 幂等与 NULL 纪律

- **锚 = 派生主键**：`status_id = "se_" + sha1(unit_id|asset_id|round).slice(0,12)`；`asset_id` 为 null ⇒
  **`""` 占位**（照 `deriveJudgementId` 姿势；**不用可空列 UNIQUE** —— R2 陷阱：SQLite NULL 互不相等）。
- **判别 = 三态**（`inserted` / `duplicate` / `failed`；定向 upsert `ON CONFLICT(status_id) DO UPDATE … RETURNING created_at`
  + 严格单调 `created_at`，同 judgement repo）：**为什么没有 `anomaly`** —— 锚 = 主键全等
  （unit_id / asset_id / round 三者全同 ⇒ 同 `status_id`），不存在"同锚不同 asset"的异常面
  （与 judgement 的 `(unit_id, round)` 锚不同：那里 asset_id 不参与锚才有 anomaly）。
- `turn_seq` / `msg_seq` **恒 NULL**（F4）。
- **顺序写**（选定，写入本节）：judgement 落库成功后顺序写 status，**各自幂等**；status 写失败 ⇒
  counters.failures + warn，**不回滚 judgement**（重放可补：duplicate judgement + status inserted；
  反向不可能——先 judgement 后 status）。不做同事务：两个 repo 的事务耦合面大于收益（失败面独立且可重放）。

### 14.4 C4 · 链接与汇总形状（F6 写死）

- `payload_json` = `{ judgement_id, verdict, match_level, coverage, prompt_sha256, judge_impl }`
  （**只回指、不复制判定内容**；`match_level`/`coverage` 取 `citationMetrics` 中该 assetId 的条目，
  无度量（mock 或无 citationSource）⇒ `null` 不猜）+ `unit_id` 回指决策行。
- `outcome`：仅单元 payload 自带时落（`key_tool_call.resultStatus` ∈ success/error/unknown），否则 NULL。
- **汇总 = 查询层，不物化**（避免第二份真相）：
  - `listByAsset(assetId, opts?: { limit?, eventType? })` —— 行清单（资产维度）。
  - `rollupByAsset(opts?: { eventType? })` —— `SELECT asset_id, COUNT(*) AS used_count,
    COUNT(DISTINCT session_key) AS session_count GROUP BY asset_id ORDER BY asset_id ASC`
    （确定性排序；去重按 `(asset_id, session_key)`，口径同 §3.5 信用分聚合）。

### 14.5 C5 · excluded 类别常量 + 消费点（选定：grading 落点路径）

- 两类常量（40 spec §3a；A5 改判 = 类别常量，不做逐条枚举）：
  `EXCLUDED_CATEGORY_CLIENT_SYSTEM = "client-system"`（`body.system` 既有项 / 客户端自带 system）与
  `EXCLUDED_CATEGORY_USER_ORIGINAL = "user-original"`（非注入用户文本 / 用户原语）。
  `citation/source.ts` 的 `excludedCategories()` 返回 `[client-system, user-original]`（TODO 消除）。
- **消费点（二选一，本单选"grading 落点路径"，理由如下）**：worker 落 judgement 时把
  `citationSource.excludedCategories()` 落进 `detail_json.excludedCategories`（无 citationSource ⇒ 不落该键）；
  T5 以 worker 层实证 + 常量内容断言（常量 → provider 方法 → detail_json 全链）。
  **不选 e2e 字节级对账**：那需要 injectedBody 全文比对装置（40 spec §8.3 验收③的既有装置），
  属 40 的验收面；本节只保证"类别声明可被对账方读到"（对账材料落库），不重复造装置。
