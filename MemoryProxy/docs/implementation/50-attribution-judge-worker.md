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
