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

## 15 真 provider 接入（§9.4 第一半 / A6；60 落地）

> 本节是 §9 第 4 项的前半：判定来源从"永远是确定性规则"推进到"**可以是真的 LLM**"。
> `round>0` 重判 / `trigger` / `task_boundary`（A7）＝下一单；本单 enqueue 仍 `round=0`。
>
> **方向反转登记（F1）**：`create-judge.ts` 原头注理由 = "未知 provider ⇒ 降级 mock + warn；
> worker 是独立进程，配置写错就让进程起不来（crash-loop）比降级 mock 危险得多，且 mock 产出带
> `judge_impl=mock:v1` 落表可见"。**A6 推翻**：判定的消费方是人类与后续汇总，"落表可见"不足以
> 对冲"**假判定被当真实归因**"——尤其 `asset_used`（§14）已开始把 confirmed 当"使用"汇总。
> 新口径：**fail-closed**（未知/缺参 ⇒ 启动失败），crash-loop 顾虑改由
> "配置校验在 `getDb()` **之前**、一次性判死、**不重试**"处理。原理由文字保留在 create-judge 头注
> （并排新理由，不覆盖）。

### 15.1 C1 · fail-closed（启动期校验）

- `validateJudgeConfig(config)`（`create-judge.ts` 导出纯函数，不联网）：`provider ∈ {mock, mechanical, real}`；
  `real` 还需 C2 必需参数齐备。不合法 ⇒ throw `JudgeConfigError`。
- `main()` 流程调整：`parseWorkerArgs → buildConfig → **validateJudgeConfig**（此处在 `getDb()` 之前）
  → initLogger → 探库 → …`；catch `JudgeConfigError` ⇒ 明确 stderr（含 provider 名/缺哪个参数）
  + **`EXIT_CONFIG_INVALID = 3`** + **不重试**（进程退出，由外部重启策略决定，不内部重试）。
- `mock` / `mechanical` 行为不变；**`provider` 缺省仍 `"mock"`**（缺省关闭不变）。
- `createJudge` 自身同样 fail-closed（throw `JudgeConfigError`，防御 buildWorkerDeps 被其它入口调用）。

### 15.2 C2 · 配置面（命名与缺省值定稿）

```ts
// AttributionJudgeConfig 扩展（types.ts）
provider: string;            // "mock"(缺省) | "mechanical" | "real"；未知 ⇒ 启动失败（C1）
real?: {
  baseUrl: string;           // OpenAI-compatible 基址（本单请求打到 `${baseUrl}/chat/completions`）
  apiKey: string;
  model: string;
  timeoutMs?: number;        // 缺省 30000；纯本地参数，有缺省
};
```

- **缺省值口径**：`baseUrl` / `apiKey` / `model` **无缺省**（缺任一 ⇒ C1 fail-closed，**绝不**"用缺省值去连空地址"）；
  env 兜底 `TDAI_ATTRIBUTION_JUDGE_BASE_URL` / `_API_KEY` / `_MODEL`（config 优先于 env）。
- **密钥纪律**：`apiKey` 只从 config/env 读，**绝不落库、绝不进日志、绝不进 payload/detail_json**；
  报告给"全库 + 全日志 grep 零命中"证据（照 51 `attributionSessionKey` 纪律姿势）。

### 15.3 C3 · 响应白名单解析（写死）

严格解析**恰好一个** JSON 对象，字段白名单 `{asset_id, verdict, rationale_ref}`：

| 类别 | 触发 |
|---|---|
| `too_large` | 响应文本 > **65536** 字符（上限写死） |
| `not_json` | trim 后非 `{` 开头 / 非 `}` 结尾（含前后解释文字）/ `JSON.parse` 失败 / 顶层非对象（数组、null、裸标量） |
| `multiple_objects` | trim 后文本含 `}\s*{`（两个对象拼接） |
| `unknown_field` | 存在白名单外键 |
| `missing_field` | 白名单键缺失 |
| `type_error` | `asset_id` 非 `string\|null` 或 `rationale_ref` 非 `string` |
| `bad_verdict` | `verdict ∉ {confirmed, refuted, unconfirmed}` |

**任何**畸形 ⇒ 该行判定 = `unconfirmed`（`assetId: null`、`rationaleRef: "malformed:<category>"`）
+ **按类别计数**（`getRealProviderMalformedCounters()`）；**不 throw、不猜、不"取第一个能解析的"、不取部分字段**。

**外层包装与内层的分界（写死）**：HTTP 非 200 / 响应非 OpenAI-compatible 形状
（`choices[0].message.content` 非 string）⇒ **throw**（服务契约破坏 ⇒ 走 C5 fail/重试路径）；
仅**模型自由文本**畸形 ⇒ `unconfirmed`（判定产物，重试无意义）。

### 15.4 C4 · 幻觉护栏（worker 边界，所有 provider 一律生效）

`applyHallucinationGuard(verdict, candidates)`（纯函数，`worker.ts` 导出，供直测）：

```
verdict.assetId !== null && !candidates.some(c => c.assetId === verdict.assetId)
  ⇒ { assetId: null, verdict: "unconfirmed", rationaleRef: `guard:asset_not_in_candidates:<assetId>` }
```

- 触发 ⇒ `result.guarded += 1`（cycle result 新字段 + main 退出摘要）；**不改选其它候选**（不猜）。
- **只放 worker 边界**（校验在信任边界这一侧；provider 不可信输入源，不许下放到各 provider 自证诚实）；
  对 `mock` / `mechanical` / `real` **一律生效**（T2 断言三者均过闸）。

### 15.5 C5 · 超时/失败语义

per-call timeout = `real.timeoutMs`（AbortController + abort；**不引入新依赖**）；超时 / 网络错误 /
非 200 / 包装畸形 ⇒ **throw** ⇒ 既有 `fail()` 重试/死信路径（**不新增**重试机制）；日志沿用 `judge-log`
引用式（不塞响应全文）。

### 15.6 C6 · prompt 消费

请求体（OpenAI-compatible）：`POST ${baseUrl}/chat/completions`，`{model, temperature: 0,
max_tokens: 512, messages: [{role: "user", content}]}`，其中
`content = ATTRIBUTION_JUDGE_PROMPT_V1.text + "\n\nINPUT:\n" + JSON.stringify({unit: input.unit,
candidates: input.candidates})`。`promptRef` 原样落表（链路不变）；`judge_impl = "real:" + model`
（可辨识到具体模型；落 `judgement_details.judge_impl`）。

## 16 轮次与触发（§9.4 第二半 / A7；61 落地）

> 本节是 §9 第 4 项的后半：`round` 从"恒 0"变成**可单调递增的重判轮次**。
> `task_boundary` 启发式 / 自动触发（版本漂移 / 规则升级）按 A7 **留给 S6**；本单只保证
> 人工重判入口与语义就位。前置事实（全部复核到 `2d4bd04`）：
> ① 生产路径把 `round` 焊死为 0（`enqueue.ts:73`）；② 三条幂等键/派生主键**都已含 round**
> （queue `(unit_id, round)` / `judgement_id` / `status_id`，59）⇒ 每轮各落各的行，天然支持多轮，
> 本单**不改**任何键规则；③ repo 已能收 `round`（`judge-queue-repo.ts:30`）⇒ 缺的只是"谁算下一轮"；
> ④ `trigger` 枚举值只登记未生产；⑤ 全仓零 `DELETE FROM`（三张归因表）⇒ "旧行不删"当前只是事实。

### 16.1 C1 · round 语义（写死）

- 重判 = 新轮 = **`max(该 unit 在 queue 表的 round) + 1`**；**queue 表是权威轮次账本**
  （不用内存计数、不读 judgement/status 表推断）。
- 不回退、不复用；每轮的行（queue / `judgement_details` / `status_events`）**永不删、永不改写**。
- 并发：`max+1` 的读-写窗口由 `(unit_id, round)` 幂等键兜住（两方同算 `k` ⇒ 第二方入队
  幂等命中 `false`，非错误）——**不新增锁**、不引入事务隔离级别讨论。

### 16.2 C2 · 重判触发路径（命名定稿）

- CLI：**`--rejudge <unit_id>`**（worker 进程；与 `--once` 可组合：先重判入队、再抽干消费）。
- 语义：取该 unit 的**最新轮 queue 行**（`round DESC` 首行）作为重判输入（payload/session/space
  从旧行复制 —— "旧行不删"使重判可读原始输入）；不存在 ⇒ 报错 `EXIT_REJUDGE_TARGET_MISSING = 4`
  （运维拼错 unit_id 必须知道），零入队。
- 产出 `trigger = "manual"`；**不查 `attribution.judge.enqueue` 开关**（同 `--retry-failed` 姿势：
  显式运维命令，非缺省路径）。
- 自动触发（版本漂移 / 规则升级 / 计划任务）**不属本单**（S6 corrected 规则的前置）。

### 16.3 C3 · trigger 枚举（写死；穷举 + 未来值加法）

| 值 | 状态 | 生产点 |
|---|---|---|
| `decision_unit` | 缺省（行为不变） | `enqueueUnitsForJudge`（首判） |
| `manual` | **本单开始生产** | `--rejudge` 入口 |
| `task_boundary` | **只登记枚举值**（A7 留给 S6） | **禁产**（T4 + R3 把"不可达"焊成断言） |

穷举以 `TRIGGER_*` 常量导出（名：`TRIGGER_DECISION_UNIT` / `TRIGGER_MANUAL` /
`TRIGGER_TASK_BOUNDARY`；`JudgeTrigger` 联合类型）；未来新增值 = 常量 + 联合类型 + 本节表格同行
（出现"生产点"列才可生产）。

### 16.4 C4 · 消费侧"取最新"口径（查询层，不物化）

- `AttributionJudgementDetailsRepo.latestByUnit(unitId)` 与 `AttributionStatusEventsRepo.latestByUnit(unitId)`：
  `WHERE unit_id = ? ORDER BY round DESC, <主键> ASC LIMIT 1`（tie-break 用主键：同 unit 同 round
  在主键幂等下至多一行，此处仅保证排序全序稳定）。
- **不建物化"最新轮"视图/汇总表**（避免第二份真相；照 §14.5 的 rollup 姿势）。

### 16.5 C5 · 可观测

- 重判入口回显 `unit=<id> round=<n> enqueued=<bool>`（每轮入队结果分轮计数）；
- 重判**零"改写"计数**：不产生任何行的 update/delete（旧行逐字节不变，T1 断言快照）。

## 17 判定侧边界与成本闸门（§9.5 第一半 / A8①+B4；62 落地）

> 本节是 §9 第 5 项的前半：给判定链补两个**边界语义**——"不可知"的 tombstone 单元不许被当
> "未执行"漏判、也不许被当"克制成功"伪报（A8①）；"判不完"的单元走**成本闸门**而不是数据闸门
> （B4：超限不丢弃、溢出要记账）。`attribution_audit` 池 + `asset_validated`/`asset_corrected`
> 写口属 63；metadata key 统一（A8③）不属 S5。
> 前置事实（复核到 `95c281f`）：① tombstone 语义已在 `decision-units/types.ts:74-83` 定死
> （`resultStatus` 恒 `"unknown"` 且无 `resultSnippet`；`resultMissing` = 结果**整体缺失**，
> 与"结果到达但为空文本（同样 unknown）"区分）；② worker 已在读 `resultStatus`（只喂 status 的
> `outcome`）但无专门分支；③ top-N 仓内零配置面；30 spec §2 明令**捕获侧不截断**，
> "top-N（如 30）是**送裁判**的每轮上限"、溢出文案"另有 N 个次要决策未逐一归因"。

### 17.1 C1 · tombstone 专门分支（写死）

- **判据（只读 payload 两字段，不碰数据库、不做文本启发式）**：
  `kind === "key_tool_call"` **且** `payload.resultStatus === "unknown"` **且**
  `payload.resultMissing === true`。**对照格**：`unknown` 但**无** `resultMissing`（结果到达但空文本）
  ⇒ 走**正常判定路径**（判据不误伤）。
- **处置**：**不调用 judge**（"不可知"无需 LLM，也不该花这个钱）⇒ 直接
  `{ assetId: null, verdict: "unconfirmed", rationaleRef: "tombstone:result_missing" }`；
  **不写 `asset_used`**（59 触发真值表：unconfirmed ⇒ 零 status 行）；**judgement 行照落**
  （unconfirmed，审计需要）；`result.tombstoned` 分项计数。
- **不许**：当"未执行"（漏判）、当"克制成功"（伪报）、改选其它候选。

### 17.2 C2 · top-N 成本闸门（写死）

- **计量单位 = 每 cycle 的「送 judge 单元数」**（三选一，理由：闸门的目的是**单次运行的成本上限**，
  运维可控"一次 `--once` 最多花 N 次 LLM 调用"；tombstone 不送 judge ⇒ **不占额度**；batchSize 是
  单批并发面，与本闸门正交）。
- **cycle 边界（写死）**：drain（`--once`）= 每进程（额度耗尽 ⇒ 结束本轮、退出）；常驻 =
  **每节流拍**（额度耗尽 ⇒ sleep `pollIntervalMs`、重置额度 ⇒ **节流而非冷停**，队列不会
  被"一次性配额"饿死）。
- **config 键名 = `attribution.judge.worker.topNPerCycle`**；**缺省 30**（30 spec 口径）。
  **行为变更登记**：此前单轮无上限 ⇒ 自 62 起 `--once`/每轮最多送 30 个新判定（超限**不丢弃**，
  见 C3；见 62 报告语义变更声明与实测）。
- **超出上限的排序/优先级口径**：**FIFO（既有 `queue_id ASC` 认领序）**，无加权、无跳过——
  上轮溢出者即队头，**下轮最先**被处理。
- 实现口径：claim 的 `batchSize` 钳制为 `min(batchSize, 剩余额度)`；额度耗尽 ⇒ 结束本轮
  （**不去 claim** 溢出者——比"认领前排除"更强：无活锁、attempts 零污染；`excludeQueueIds`
  仍只服务既有 drain 内失败重排面，不新造排除集）。

### 17.3 C3 · "不丢弃"的落实

- 溢出单元**保持 pending**（未 claim ⇒ `attempts` 不变、状态不变）；
- **溢出记账**（落点二选一，选定 **cycle 摘要**）：`result.overflowed`（本轮结束时 pending 总数）
  + stderr 摘要行 `另有 N 个次要决策未逐一归因`（30 spec 原文文案；N = 实际待定数）。

### 17.4 C4 · 饿死问题（B4 自列攻击点）——正面回答（机制，非安抚）

**机制（三条，全部可断言）：**
1. **FIFO 队头优先**：`claimBatch` 的 `ORDER BY queue_id ASC` ⇒ 每轮从**最老的** pending 开始；
   上轮溢出者位于队头 ⇒ **下一轮最先**被处理（顺序前进，无永久滞留）。
2. **闸门是 cycle 级、每轮重置**：额度不是"每单元一次性配额"；`excludeQueueIds`
   （`alreadyAttempted`）只活在**单个 cycle 内** ⇒ **不存在跨轮永久排除**。
3. **无丢弃**：溢出者未被 claim（状态/attempts 零改动）⇒ 其"被处理的机会"仅被**延后**，不被消灭。

**剩余风险（如实登记，不藏）**：**持续涌入率 > N/轮**时，积压（pending 数）单调增长、
**延迟无界**——这是**吞吐不匹配**，不是饿死（无永久排除；FIFO 保证每个单元按序前进）。
**观测方式**：`result.overflowed` + `queueRepo.countByStatus().pending`（运维看积压曲线）；
**边界**：到达率 ≤ N/轮 时积压单调下降至 0。R3 反证：把溢出改为"永久排除"（例如把溢出行
标记为不可再选/持久化进排除集）⇒ T4 必红。
