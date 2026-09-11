# 45 spec — S4：bridge 遥测 SQLite sink（`channel: "fetched"` 硬档）

> 定位：v2 的**第 2 个正式切片**（`00-master-spec.md` §9 占位名 `45-bridge-telemetry-sink.md`，上游 §7 矩阵 v2 S4 行）。
> 上游依据：`codebuddy-scratch/v2-init/attribution-v2-boundary-scope.md` §1 S4 行 / §3 依赖顺序 / DR-7 / 红线 1–8；
> 评审链：`v2-init/attribution-v2-review.md` §2（执行顺序 P0→基座→S4→S5…）。
> 前置已闭：P0（`40-visible-text-archive.md`，head `bf8af3d`/`d0f44a6`/`22fad92`）+ 共享基座（`attribution-base-design.md`，head `7d92705`）。
> **本文即实现依据**；锚点行号以撰写时工作树（分支 `feature/attribution-v2`，head `7d92705`）为准。
> 开工前 4 处设计决策**已拍板**（§10，2026-09-10）。

## 0. 一句话

把两条 bridge（skill / memory）**已经发出**的 `kind='bridge_call'` 埋点，经一个**叠加**的 SQLite sink 落到
`attribution_events`（`event_type='asset_fetched'`、`payload.channel='fetched'`），给 S5 当"**该轮真的取了哪些资产**"的
硬档原料 —— **不改 CH 通路（逐字段不变）、17 处 reject 埋点零改动、缺省关闭零行为回归**。

> ⚠️ **勘正 4（口径修正，2026-09-10）**：原文写的"**不改埋点调用点**"**作废**。
> extractor 需要**未截断**的请求体 `skill_id` 与响应体 `data.skill_id`，而 sink 只拿得到 `row`
> （其 `requestBody` 是 `slice(0,512)` 的截断串，F3）—— 两者**互斥**，必须拍板。
> 拍板结果 **P5 = ctx 双通道**：sink 链签名升为 `(row, ctx)`，**4 处真实 emit 各 +1~2 行**传 ctx（§3.3）。
> 边界：CH 通路逐字段不变（**构造性证明** F14）、17 处 reject 零改动（F16）、ctx **绝不落库/绝不打印**（§3.3 + R9）。

## 1. 范围与边界

| 项 | 本期做 | 依据 |
|---|---|---|
| 做什么 | ① 埋点侧 **sink 链**（叠加式，§3.3）② SQLite 落点（复用 `attribution_events`，零 DDL）③ **skill 通道 asset_id 提取**（新纯函数，§3.2）④ toggle + 装配 + 单测 + 真实冒烟 ⑤ **skill-bridge 首个测试 harness**（§4 用例 7/8 必需，F11）⑥ **`(row, ctx)` 提取上下文通道**（P5 拍板，勘正 4） | 立项 §1 S4 行 |
| 一句话验收 | 一次真实 `skill_view` ⇒ 事件表**恰好 1 行**带 `asset_id` 的 fetched 行 | 同上 |
| 形态 | **观测 sink（append-only 事实行）**，不是判定 | 红线 7 |
| 不做 | 判定语义 / 阈值 / 候选分档 / shortlist → **50 spec（S5）**。S4 只记"取过哪个资产"这个事实，不出"用没用/该不该用"的结论 | 立项 §1.2、红线 7 |
| 不做 | **memory-bridge 的 asset 提取**（只落行、`asset_id` 为 NULL）→ 缺口 §8.1 | DR-7 |
| 不做 | **turn 锚定**：bridge 侧拿不到轮次（§2 F2）⇒ `turn_seq` 只能 NULL，**不伪造**。怎么锚到决策单元 = S5 决策 | 勘正 1 |
| 不做 | v1 表改动：**零 DDL**（复用既有表与索引），`SCHEMA_VERSION` 仍为 1 | 红线 6 |
| 不做 | fan-out 多资产行（`search`/`listing` 命中集）→ 缺口 §8.2 | 本期范围守卫 |
| 不做 | 在 ctx 里做脱敏/截断：ctx 传**原始** `inboundBody` 对象与**原始** `responseText` 字符串引用（sink 只读、用后即弃）。脱敏/截断是 **CH row** 的义务，不是 ctx 的 | §3.3、R9 |
| 不做 | 重构 `tryLazyPin`（**P4 拍板**：零触碰既有代码，接受两份形状知识）→ 对冲见 §3.2 + §7 R8 | §10 |

**范围守卫**：S4 **不引入任何判定分支**；`payload` 只记事实字段（endpoint / status / 耗时 / 拒绝原因 / 提取来源），
不落任何"置信/档位/结论"。

## 2. 现状事实（撰写前实读核实，含三条与立项原文/本文草稿不符者）

| # | 事实 | 证据（行号以 head `7d92705` 为准） |
|---|---|---|
| F1 | 埋点 sink **已是可注入参数**，默认 `writeToolCallRow` | `src/memory/bridge-telemetry.ts:44-46` |
| F2 | ⚠️ **`turnSeq` 是死字段**：`BridgeCallTelemetryInput.turnSeq`（`:16`）存在，但两条桥 **11 个 `emit*` 调用点无一传值** ⇒ 恒 `undefined`（CH 行同样一直是空） | 全 src grep `turnSeq` 仅命中 `bridge-telemetry.ts` 自身（勘正 1） |
| F3 | `requestBody` 已脱敏 + 截断 ≤512 ⇒ **不能**靠解析它取 asset id | `skill-bridge.ts:920`、`memory-bridge.ts:429` |
| F4 | CH 写入在未启用时 no-op；**启用环境里它是真实落点** ⇒ S4 必须**叠加**而非替换 | `clickhouse.ts` `writeToolCallRow`：`if (disabled \|\| !config) return;`（勘正 2） |
| F5 | `attribution_events` 已有 `asset_id`/`asset_type`/`payload_json`/`turn_seq`(nullable)/`msg_seq`(nullable)；幂等索引**只对 `msg_seq IS NOT NULL` 生效** | `schema.ts`：`idx_ae_unit_dedupe … WHERE msg_seq IS NOT NULL` |
| F6 | 事件 repo 有 Sqlite/Null 双实现 + get/set/`__reset` 三件套 | `attributionEventRepo.ts:250,263,271,276` |
| F7 | **asset id 已被现网代码解析出来过**：请求侧读 `inboundBody.skill_id`；响应侧 `tryLazyPin` 解析出 `{skillId, version}` | `skill-bridge.ts:845`、`tryLazyPin` `:1017-1096` |
| F8 | memory-bridge 响应 shape 两套：`atomic/search → data.items[]`、`conversation/search → data.messages[]`，且**单 target 分支是透传、不解析** | `memory-bridge.ts:431-460` |
| F9 | `emitBridgeRejectTelemetry` **不透传 sink** ⇒ reject 路径固定走默认 sink | `bridge-telemetry.ts:120-136` |
| F10 | S2 装配姿势 = "added on top, never replacing" | `injection/index.ts:414-418` |
| **F11** | ⚠️ **全仓没有任何 bridge 测试**（`grep -rln "bridge" --include="*.test.ts" --include="*.spec.ts"` 为空；测试全在 `injection/`、`attribution/` 下）⇒ 本文草稿 §5.5 的"既有测试复跑取证"**不成立** | 实测（勘正 3） |
| **F12** | ⚠️ **`pinRepo` 无 deps 注入面**：`SkillBridgeDeps = {fetcher?, now?, resolveVisibleSkillIds?, coreClient?}`；pin 侧只能经 `resolveBacking(config)` 取得（`storage.enabled → KvVersionPinRepo`，`redis.enabled → 适配器`，**两者都关 ⇒ `pinRepo: null`，lazy-pin 完全不执行**） | `skill-bridge.ts:118-134,510-512,948-949` |
| **F13** | `tryLazyPin` 的 sub 覆盖：`search` → **每个 hit** 多 pair；`get` / WRITE_LOCK_OPS → 单 pair；**`files/read` 显式不 pin**（响应无 `skill_id`）；其他 sub 不参与 | `:1040-1096`（对照表见 §3.2） |
| **F14** | CH 行是**逐列显式映射**（camel→snake，不 spread 输入对象），且全仓无 `JSON.stringify(row)` / `console.log(row)` ⇒ 给 sink 加**独立第 2 参**可**构造性证明** CH 逐字段不变 | `clickhouse.ts:1070-1093` `buildToolCallLogRow` |
| **F15** | ctx 素材在 4 个 emit 点**都已在作用域**：`inboundBody` 声明于 `:546`（函数级）；`respText` 在 `:897` 取得（先于 `:911` emit）；memory 侧 `text` 在 `:394/404` 取得（先于 `:412` emit）⇒ 每处只需 +1~2 行 | `skill-bridge.ts:546,897,911`、`memory-bridge.ts:394-412` |
| **F16** | 真实 `emitBridgeToolCallTelemetry` 调用点**只有 4 处**（`skill-bridge:606,887,911` + `memory-bridge:412`）；其余 **17 处全是 `emitBridgeRejectTelemetry`**（skill 9 + memory 8）⇒ 需考虑 ctx 的面很小，reject 侧零改动 | 全 src grep（22 命中 = 4 + 17 + 1 内部） |
| **F17** | `files/download` 是独立分支：`outbound = { ...inboundBody, user_id/team_id/agent_id }` 且上游 URL 实为 `/v3/skill/files/read` ⇒ **带 `skill_id`**、属单资产语义，应并入请求侧提取 | `skill-bridge.ts:575-591` |

## 3. 设计

### 3.1 落表：复用 `attribution_events`（零 DDL）

| 列 | S4 取值 | 说明 |
|---|---|---|
| `event_id` | repo 生成（`randomUUID`） | 一次调用一条，**不去重**（§3.5） |
| `space_id` | 埋点 `spaceId ?? "_default"` | 与 v1 同 |
| `user_id` / `agent_source` | 埋点透传 | 身份列 |
| `session_key` | **CH 埋点键**（`row.sessionKey`）= 埋点 `sessionKey`，调用点已保证 `composite_key` 优先（**不变**）；**S4 落 `attribution_events` 的 `session_key`** = **bare 归因键** `resolveConversationId(c)`（与 `decision_unit.created` **同域**，2026-09-10 归一化） | 归一化后落库键**不再**与 `session_init_logs` 对齐（那本是 CH 埋点键的契约）；依据 `51-anchoring-decision-brief.md` §7.1 |
| `turn_seq` | **NULL** | F2：拿不到，**不猜**（勘正 1） |
| `msg_seq` | **NULL** | 非决策事件；顺带使 `idx_ae_unit_dedupe` 不约束本类行（F5） |
| `event_type` | **`asset_fetched`** | v2 词表扩展，需在 `00-master-spec.md` §3 登记（P3 拍板） |
| `asset_id` | skill 通道提取值；否则 NULL | §3.2 |
| `asset_type` | `"skill"`；否则 NULL | 身份契约：`skill` 的 `asset_id === skill_id`（00 spec §3） |
| `unit_id` | **NULL** | S4 不做 unit 关联（那是 S5） |
| `payload_json` | 见下 | 只记事实 |
| `created_at` | `Date.now()`（epoch ms） | 与 v1 一致 |

> ⚠️ **`agent_source` 口径注（2026-09-10，依据 `51-anchoring-decision-brief.md` §7.1 / §7.3 ⑥）**：
> 本表的 `agent_source` 与 `decision_unit.created` 的 `agent_source` **来源不同** —— 主链路 = **当前请求 URL 路径第一段**（缺省 `"claude-code"`，`anthropicHandler.ts:647-650`）；
> S4 = **会话身份**（L1 复合键前缀 `skill-bridge.ts:253-254` 或 L2b `binding.agentSource` `:273`，缺省同为 `"claude-code"`）。
> **正常路径恒等**，仅"**跨路径恢复**"（同一会话先用 `/claude-code/...` 建、再用 `/codebuddy/...` 续）或 L1 前缀轮询命中不同前缀时可分裂。
> ⇒ **`agent_source` 不是锚定键**：S5 只允许用 `session_key`（已归一化）+ `rowid` 定序；`agent_source` 只作**展示 / 分组**维度，**禁止**进 `WHERE` 做 join 或过滤（长期规则：将来若做"改值"，过渡期内也会新旧两种值并存）。

`payload_json`（`v` 便于将来演进）：

```json
{
  "v": 1,
  "channel": "fetched",
  "bridgeSource": "skill-bridge",
  "sub": "get",
  "executedEndpoint": "get",
  "upstreamStatus": 200,
  "elapsedMs": 42,
  "rejectReason": null,
  "assetSource": "response",
  "version": 7,
  "multiAsset": false
}
```

- `channel: "fetched"` 是**硬档标识**（与 S5 判定明细的 `evidence_source_type` 同词表；injected 通道由 P0 档① 承担）。
- `assetSource ∈ {"request","response",null}`：asset 从哪一侧解析出来（`null` = 本行无 asset）。
- `version`：仅在响应侧能取到时填，供 S5 版本锚；取不到省略。
- **不落** `requestBody`（**P1 拍板**：S5 判定只需 `asset_id` + endpoint + 时间；SQLite 是长期留存面，少一份敏感面）。
  代价已在 §7 R5 登记：失去与 CH 行逐字段对账，只能靠 `session_key` + `endpoint` + 时间对齐。

### 3.2 asset 提取：新增纯函数 `extractFetchedAssets`（独立实现，**零触碰既有代码** —— P4 拍板）

新增纯函数（可单测、无副作用）：

```ts
// src/attribution/bridge-fetch-assets.ts
// 两个 body 来自 sink 的第二参 ctx（§3.3）；**绝不是** row.requestBody（那是 512 截断串，F3）
export function extractFetchedAssets(input: {
  bridgeSource: "skill-bridge" | "memory-bridge";
  sub: string;
  inboundBody: Record<string, unknown> | undefined;
  responseText: string | null;     // 无响应（fetch 失败/未传）传 null
  upstreamStatus: number;
}): Array<{ assetId: string; assetType: string; version?: number; assetSource: "request" | "response" }>;
```

**单资产语义 sub 才提取**（"硬档"= 真的取了该资产）：

| sub | asset 来源 | 依据 |
|---|---|---|
| `get` | 响应 `data.skill_id` + `data.version`（缺则回退请求 `skill_id`） | F7 |
| `files/read` / `files/download` | 请求 `skill_id`（响应无 `skill_id`；`download` 上游实为 `/v3/skill/files/read`） | F13/F17 |
| `update` / `patch` / `files/write` / `files/remove` | 响应 `data.skill_id`（缺则回退请求） | F13 |
| `search` / `listing` / `list` / `versions` / `create` / `delete` / `extract` | **不提取**（多资产或无资产语义）→ `asset_id` NULL + `multiAsset:true` | 范围守卫 §1 |
| memory-bridge 全部 sub | **不提取**（F8：响应 shape 两套、单 target 分支透传） | 缺口 §8.1 |

**与 `tryLazyPin` 的关系（P4 = 不碰既有代码）**：`tryLazyPin`（`:1017-1096`）已有同一套响应形状知识，本期**不重构、不导出、不改签名**
⇒ 本期**零触碰既有生产逻辑**。已接受的代价：形状知识存在**两份**、无编译期约束 ⇒ 用下面的对照表 + §4 用例 3 兜住，漂移风险记 §7 R8。

**两份实现的预期差异（必须照此断言，否则假红）**：

| sub | `tryLazyPin` 产出（F13） | `extractFetchedAssets` 产出 | 一致性要求 |
|---|---|---|---|
| `get` | `{data.skill_id, data.version}` → `pinMany` | 同 | **完全一致**（§4 用例 3b） |
| WRITE_LOCK_OPS | `{data.skill_id, data.version}` → `upsertVersion` | 同 | **完全一致**（§4 用例 3b） |
| `search` | **每个 hit** 的 `{skill_id, version}`（多 pair） | `[]`（`multiAsset:true`） | **预期不同**：S4 不 fan-out（§8.2） |
| `files/read` | **无产出**（显式 `return`，`:1077-1082`） | 请求侧 `skill_id`（更全、无 version） | **预期不同**：S4 更强 |
| 其他 sub | 无产出 | `[]` | 一致（都空） |

### 3.3 sink 链：叠加式 + `(row, ctx)` 提取上下文（P5 拍板）

`bridge-telemetry.ts` 增模块级 sink 链，并给 sink 增加**第二个参数**（提取上下文）：

```ts
/** 提取上下文：**只给 sink 用** —— 绝不进入 row、绝不落库、绝不打印 */
export interface BridgeFetchContext {
  /** LLM 原始请求体（已 parse 的对象**引用**，未脱敏未截断） */
  inboundBody?: Record<string, unknown>;
  /** 上游响应体原文（未截断）；fetch 失败/未响应传 undefined */
  responseText?: string;
}

export function addBridgeTelemetrySink(
  sink: (row: ToolCallLogInput, ctx: BridgeFetchContext) => void,
): void;
export function clearBridgeTelemetrySinks(): void;           // 生产不用
export function __resetBridgeTelemetrySinksForTests(): void; // 照 visibleTextRepo 惯例
```

`emitBridgeToolCallTelemetry(input, sink = writeToolCallRow)` 内部：

1. 先构造 `row`（**逐字段显式赋值，不含 ctx**，F14）；
2. 再构造 `ctx = { inboundBody: input.inboundBody, responseText: input.responseText }`；
3. **默认 CH sink 先行**，然后依次调链上各 sink，每个各自 `try/catch` 吞异常（一个 sink 抛不影响另一个，**绝不 throw 回业务**）。

`BridgeCallTelemetryInput`（`:14-38`）新增两个**可选**字段：`inboundBody?: Record<string, unknown>`、`responseText?: string`，
注释写明"**仅供 sink 提取；绝不入 CH row、绝不落库**"。

**需要改动的 emit 调用点 = 4 处（每处 +1~2 行；素材均已在作用域，F15）**：

| 位置 | 加什么 | 语义 |
|---|---|---|
| `skill-bridge.ts:911`（上游已响应） | `inboundBody` + `responseText: respText` | 主路径：响应侧可解析（带 `version`） |
| `skill-bridge.ts:887`（fetch 抛错） | `inboundBody` | 无响应 ⇒ 只走请求侧；`upstreamStatus=0` 记实 |
| `skill-bridge.ts:606`（files/download fetch 抛错） | `inboundBody` | 同上的对称补齐点 |
| `memory-bridge.ts:412`（finally，成功+失败） | `inboundBody` + `responseText: text` | 本期 memory **不解析**（§8.1）；传值只为两桥同构 |

**17 处 `emitBridgeRejectTelemetry` 零改动**（F16）：它不透传 ctx ⇒ ctx 恒为 `{}` ⇒ 不提取、`asset_id` NULL（§3.6）。

**为什么 ctx 不挂在 `row` 上**：`row` 是 CH 的契约输入对象，未来任何 sink 都可能整体持有它；把未截断的 body 塞进 `row` 等于
把敏感原文混进 CH 契约（虽实测无整体打印 F14，但契约不干净、易被后人 `console.log(row)` 泄漏）⇒ 用**独立第 2 参**显式隔离（R9）。
`writeToolCallRow` 可直接作默认 sink（TS 允许少参函数赋给多参签名；CH 只看 `row`）。

- 好处：**4 处 emit + 17 处 reject 全自动覆盖**，且无需改 `emitBridgeRejectTelemetry` 签名（F9）。
- 与 F4 一致：CH 通路**原样保留**（叠加，不是替换）+ **逐字段不变**（ctx 不进 row、`buildToolCallLogRow` 逐列取值，F14）。
- 诚实记账：toggle 关闭时 `ctx` 仍会被构造（一个 2 字段对象，零拷贝、无读取者）⇒ 不构成行为差异，但**不是字面零开销**。

### 3.4 toggle 与装配

- config 新增（`config.ts` `injection` 区，照 `:89-93` 相邻登记，缺省 **false**）：
  `injection.bridgeFetchEvents: { enabled: false }`
- 装配点：进程启动、构造 bridge handler **之前**（`server.ts` skill/memory bridge 注册段，`:124-129` 附近），
  照 F10 的 "added on top" 姿势：

```ts
if (config.injection?.bridgeFetchEvents?.enabled) {
  addBridgeTelemetrySink(createBridgeFetchEventSink()); // → getAttributionEventRepo().append(...)
}
```

- 缺省关闭 ⇒ **不注册 sink = 零代码路径差异**（CH 行照常、零新表访问、零 DDL）。
- **P2 拍板**：memory-bridge 本期**照落行**（同一 sink 链、零新解析、`asset_id` NULL）⇒ 不需要按通道分开关。

### 3.5 幂等与重复语义（诚实记账）

- **每次 bridge 调用 = 一条 fetched 行**（`get` 类恰好 1 行；无 asset 的调用 1 行 `asset_id=NULL`）。
- **不设唯一索引**，理由三条：
  1. F5 的 dedupe 索引只覆盖 `msg_seq IS NOT NULL`，本类行 `msg_seq=NULL` ⇒ 天然无约束（**不改 v1 索引**）；
  2. 两次 `skill_view` 同一个 skill 是**两条真实事实**，折叠成一条是**伪造**（反例见 §4 用例 6）；
  3. 可去重的键不存在：`requestBody` 脱敏截断（F3）不能当 hash 源，`session_key`+`endpoint` 也无法区分同轮重复调用。
- 代价（登记为风险 R4）：HTTP 重试 / 重复 curl 会产生多行 ⇒ **S5 消费端需容忍**（按 `created_at` 排序取首见即可）。

### 3.6 失败语义

| 情形 | 行为 |
|---|---|
| `getAttributionEventRepo()` 是 Null 实现（无 DB） | `append` 静默降级、**不抛**（F6 既有语义） |
| sink 内构造/落库抛错 | 该 sink 的 `try/catch` 吞掉；CH sink 与业务照常 |
| 响应缺失（fetch 失败 / 4xx） | 仍落 1 行（`upstreamStatus` 记实，`asset_id` 可能 NULL）——**"打过一次"本身是事实** |
| 前置早退（**17 处 / 9 类** reject） | 落 1 行 `rejectReason` 非空、`asset_id` NULL；**ctx 恒为 `{}`（F16，调用点零改动）** |
| ctx 缺失 / 未传（reject、老调用点） | 不提取 ⇒ `asset_id` NULL，其余照落（extractor 必须容忍 `undefined`） |
| toggle 关闭 | 不注册 sink ⇒ 零新行（ctx 仍构造但不被读取，§3.3） |

## 4. 单测清单（vitest，纯函数 + fake repo/sink + **新建 harness**）

> ⚠️ 用例 7/8/3b 需要 `createSkillBridgeHandler(config, deps)` 端到端 harness，而全仓**目前没有任何 bridge 测试**（F11）
> ⇒ 本期新建 `src/skill/__tests__/bridge-fetch-events.test.ts`（`deps.fetcher` 注入假上游 + `setAttributionEventRepo` 注入 fake repo + `addBridgeTelemetrySink` 注入观测）。

1. **提取器形状**：`get` 响应 → `{assetId, assetType:"skill", version}`；`get` 响应缺 `skill_id` → 回退请求 `skill_id`。
2. **提取器边界**：`files/read` 只认请求侧；`search`/`listing`/`create`/`extract` → `[]` + `multiAsset:true`；
   响应非 JSON / `code!==0` / 缺 `data` ⇒ 不抛、返回 `[]`。
3. **与 `tryLazyPin` 的一致性（P4 代价的对冲，照 §3.2 对照表）**：
   - **3a（必做，零成本）**：按 §3.2 对照表逐行 fixture 断言 `extractFetchedAssets` 产出，**含 `search`/`files/read` 的"预期不同"项**。
   - **3b（条件性）**：端到端 harness 下，断言 `get` 与 WRITE_LOCK_OPS 两 sub 上提取器产出与 pin 落库的 `{skillId, version}` **逐字段一致**。
     ⚠️ pin 侧只能经 `resolveBacking(config)` 取得（**F12：`SkillBridgeDeps` 无注入面**）：需 `config.storage.enabled=true` + 可读回的 storage；
     若测试内不可观测（或两者皆关 ⇒ `pinRepo:null` ⇒ lazy-pin 不执行）⇒ **降级为人工对照并登记 §8.4**。
4. **sink 链**：CH sink 抛 ⇒ SQLite sink 仍被调用；SQLite sink 抛 ⇒ CH 照常；两者都抛 ⇒ `emit*` 不 throw。
5. **落行形状**：`event_type='asset_fetched'`、`turn_seq===null`、`msg_seq===null`、`unit_id===null`、
   `payload.channel==='fetched'`、`payload.bridgeSource`/`sub`/`upstreamStatus` 正确；`session_key` 用 `composite_key`；
   **行与 `payload_json` 内均不含 `responseText`/`inboundBody` 原文**（ctx 绝不落库，R9）。
6. **不去重（反例 pin）**：同 session 同 skill 连续两次 `get` ⇒ **2 行**（防后人"顺手"加唯一索引/去重）。
7. **toggle off 回归**：不注册 sink ⇒ 0 新行；CH 通路调用次数与形状与关闭前**逐字段相同**。
8. **reject 分支矩阵**：逐个触发 9 类前置早退（`unknown_path`/`subpath_forbidden`/`method_not_allowed`/
   `content_type_invalid`/`missing_conversation_id`/`session_not_initialized`/`write_ops_disabled`/
   `body_not_object`/`invalid_json_body`）⇒ 各落 1 行且 `rejectReason` 正确（**防"新增早退分支漏埋点"**，本 spec 的 R6 门禁）。
9. **降级**：`setAttributionEventRepo(new NullAttributionEventRepo())` ⇒ 不抛、0 行。
10. **ctx 隔离（构造性，P5 门禁）**：sink 收到含 `responseText`/`inboundBody` 的 ctx ⇒
    ① 落库的行**不含**该内容（含 `payload_json` 逐字段检查）；② `buildToolCallLogRow(row)` 的**键集合**与 S4 之前**完全相同**
    （防后人把 ctx 字段泄进 `row`/CH）；③ ctx 三处调用点与 reject 路径（ctx=`{}`）都不抛。

## 5. 验收（真实会话冒烟，门槛不变：单测 + 真实冒烟）

1. **达标行**：真实 `skill_view`（LLM Bash curl → `POST /skill-bridge/v3/skill/get`）⇒
   `SELECT * FROM attribution_events WHERE event_type='asset_fetched'` **恰好 1 行**，且
   `asset_id = <该 skill_id>`、`asset_type='skill'`、`payload_json.channel='fetched'`、`upstreamStatus=200`。
2. **重复不折叠**：同会话再 `get` 一次同一 skill ⇒ 累计 **2 行**。
3. **无 asset 的调用照落**：一次 `search`（或任一 reject 路径）⇒ 1 行且 `asset_id IS NULL`、`multiAsset/rejectReason` 记实。
4. **缺省关闭回归**：`injection.bridgeFetchEvents.enabled=false`（默认）⇒ `asset_fetched` **0 行**，
   且 CH 侧 `bridge_call` 行数与字段与关闭前**不变**（回滚口径）。
5. **零回归证据（措辞按 F11 实测修正）**：本仓**无 skill-bridge 既有测试** ⇒ 不得拿"既有测试复跑"当证据。实际证据 =
   ① §4 用例 7 的 toggle-off 逐字段断言（CH 通路形状/次数不变）
   ② 全仓 `npm test` 结果与 S4 改动前**逐条 diff 一致**（不是只比汇总数字）
   ③ 新建 harness 的用例 8 覆盖 9 类早退；
   ④ **P5 加 ctx 后 CH 仍逐字段不变**的证据 = 用例 10 的键集合断言（4 处 emit 只多传 ctx，`row` 无新字段）。

### 5.5 真实冒烟证据（2026-09-10 实测）

> 采集方式：临时冒烟脚本（真 `createApp` 装配 + 真 loopback HTTP + 真 SQLite 文件 + 真
> core stub；`zz-s4-smoke*.tmp.test.ts`，**跑完即删、不入库**。toggle off 必须与 toggle on
> **分文件（或显式复位链）**：sink 链是模块级的（`bridge-telemetry.ts:89` `_sinks`），一个进程只装配一个 config，
> 否则 off 断言会被 on 实例注册的 sink 污染。单测 harness 内用 `__resetBridgeTelemetrySinksForTests()`
> 在 `beforeEach`/`afterEach` 双向复位即可（实测 `bridge-fetch-events.test.ts:198-207`）；冒烟脚本因两个 config 同进程才必须分文件）。

| 验收 | 输入 | 实测 |
|---|---|---|
| ④ off | `enabled=false`（缺省）下 `POST …/skill/get` | `status=200`（bridge 照常）、`SELECT count(*) FROM attribution_events` = **0** |
| ① on | `enabled=true` 下 `POST …/skill/get {skill_id:"sk-s4-smoke-0001"}` | **1 行**；`asset_id=sk-s4-smoke-0001`、`asset_type=skill`、`turn_seq/msg_seq/unit_id` 全 NULL、`session_key=codebuddy:conv-s4-smoke`；payload `channel=fetched, upstreamStatus=200, assetSource=response, version=7, rejectReason=null, multiAsset=false` |
| ② 重复 | 同会话再 `get` 同一 skill | 累计 **2 行**（`count(DISTINCT asset_id)=1`）——不去重 |
| ③ search | `POST …/skill/search {query:…}`（team-search 白名单 `A=1 B=1 merged=2`，真打到上游） | 累计 **3 行**；末行 `asset_id IS NULL`、payload `sub=search, multiAsset=true, assetSource=null` |
| ③' reject | `POST …/skill/_internal/gc` | `status=403`、累计 **4 行**；末行 `asset_id IS NULL`、payload `rejectReason=subpath_forbidden, upstreamStatus=403` |
| R9 哨兵 | 请求/响应原文植入 `SMOKE-SENTINEL-MUST-NOT-PERSIST` | 全表扫描命中 **0**（ctx 绝不落库） |

toggle off 的"0 行"是**查得到表（`getDb()` 已建 schema）却确为 0**，不是表不存在报错。
冒烟首跑即暴露 `search` 的前置短路行为 ⇒ 见**勘正 8** / §8.5。

## 6. 回滚口径

- toggle 缺省 off ⇒ 不注册 sink ⇒ **零行为回归**（不建表、不读表、不写行；CH 通路不变）。
- 零 DDL、零 `SCHEMA_VERSION` 变更、零 v1 表结构改动 ⇒ 回滚只需撤代码，无需迁移。
- §3.2 为**纯新增**（未触碰 `tryLazyPin`，P4）⇒ 撤 commit 即回到现状，无既有逻辑需回滚。
- **P5 的 4 处 emit 改动**与 sink 链同 commit（落地待办 ③）⇒ revert 该 commit 即回到 P5 之前的原状，
  **不会**留下"传了 ctx 但没人读"的悬空字段。

## 7. 风险与诚实说明

| # | 风险 | 处置 |
|---|---|---|
| R1 | **fetched 行无法锚到决策单元**（F2：无 `turn_seq`）⇒ S5 只能按 `session_key + created_at` 时间窗/排他性锚定 | 如实登记；S4 只保证"事实行 + 精确 `created_at`"。锚定策略 = **S5 决策**（若 S5 要求精确轮次，需另开捕获点，不在 S4 假造） |
| R2 | 一次调用两份事实（CH + SQLite） | 分工：**SQLite = 判定用（S5 读）**，CH = dashboard 用；两 sink 同构输入（同一 `ToolCallLogInput`） |
| R3 | memory-bridge 通道无 `asset_id` ⇒ L1 召回的候选证据仍缺 | 缺口 §8.1；S5 若需要再评估（需先冻结 hit 的 id 字段） |
| R4 | 无唯一索引 ⇒ 重试/重复 curl 产生多行 | 预期行为（§3.5 反例 6）；S5 消费端按 `created_at` 取首见 |
| R5 | 隐私面：**P1 决定不落 `requestBody`** | 与 CH 行对账能力下降（R2 只能靠 `session_key`+`endpoint`+时间）；若日后需要，按"扩大敏感面"另行评审（含清理 SQL） |
| R6 | **新增早退分支漏埋点**（本 spec 的门禁空洞等价物） | §4 用例 8 的分支矩阵：9 类 reject 逐个触发并断言行数；代价 = 需先建 harness（F11） |
| R7 | 行只增不减 | 清理 SQL 随 50 spec/运营口径；本 spec 只声明"fetched 行与 v1 事件同表 ⇒ 沿用同一档清理" |
| **R8** | **形状知识两份**（P4 的直接代价）：`extractFetchedAssets` 与 `tryLazyPin` 各自读 `data.skill_id`/`data.version`，无编译期约束 ⇒ 上游响应 shape 变更时可能只改一处（F31 类漂移） | 对冲：§3.2 对照表 + §4 用例 3a（人工对照项）；**若未来出现一次漂移，唯一实现纪律（F31）应在下一轮重新提出**，把 §3.2 收敛为唯一实现 |
| **R9** | **ctx 携带未脱敏原文**（请求体 + 响应体，内存引用）⇒ 若被 sink 误落库/误打印，就成为**新的长期敏感面** | 边界：ctx 只由 SQLite sink 在内存中读**当次**提取、用后即弃；§4 用例 5/10 断言"不落库 + CH 键集合不变"。P1 的"payload 不含任何 body"承诺**不变**（ctx ≠ payload） |

## 8. 缺口登记（不扩范围，仅钉住）

### 8.1 memory-bridge 的 asset 提取未落地

`atomic/search` → `data.items[]`、`conversation/search → data.messages[]`（F8），且单 target 分支**透传不解析** ⇒
本期只落"调用事实行"（`asset_id` NULL，P2 拍板）。若 S5 需要 L1 召回的 fetched 候选，需先冻结 hit 的 id 字段名与 multi-target 语义。

### 8.2 多资产 sub 的命中集未落行

`search`/`listing` 的命中 skill 集（`data.items[].skill_id`）本期**不 fan-out**（一次调用一行）。
若 S5 需要"搜索命中过"作为弱 fetched 证据，按响应 items 追加行即可（形状已在 §3.2 表内，低成本；
注意 `search` 的 lazy-pin 已是多 pair，F13）。

### 8.3 `turn_seq` 的来源缺失

见 R1 / 勘正 1。若 v3/S5 需要精确轮次，唯一精确点是主对话链路（S2/S3 已有 `turnSeq`），
bridge 侧（LLM curl）需要新增传递机制 ⇒ 属新接缝，不在 S4 假装解决。

### 8.4 两份形状知识的一致性可能只剩人工对照

§4 用例 3b 依赖"测试内能观测 pin 侧"，而 pin 侧无 deps 注入面（F12）⇒ 若 `config.storage.enabled=true` + 可读回 storage 不可行，
则一致性只能靠 §3.2 人工对照表 + 用例 3a（extractor 侧）。**不接受**为测试而改 `tryLazyPin`/`SkillBridgeDeps`（违反 P4 与本期零触碰约束）。

### 8.5 `search` 前置短路不落行（冒烟实测暴露，勘正 8）

`search` 在真正 `emit*` 之前有**三处短路**（均在 `skill-bridge.ts`）：① 缺 `user_key` → 500；
② 白名单 resolver A fail-closed → `{items:[]}` 200；③ 白名单空 → `{items:[]}` 200。
三者**都不发任何埋点** ⇒ 该次 search **既无 fetched 行也无 reject 行（0 行）**。
影响：S5 无法从 fetched 行看到"LLM 发起过 search，但白名单为空 / 解析失败"。
本期按范围守卫**不新增埋点**（S4 只做"取过哪个资产"的观测 sink）；若 S5 需要该事实，
应在这三处补 `emitBridgeRejectTelemetry`（改动小，但需先定义 rejectReason 词表）。

## 9. 锚点文件（实现前精读）

| 用途 | 文件 / 符号 |
|---|---|
| 埋点入口 + sink 参数 | `src/memory/bridge-telemetry.ts:44-46,120-136` |
| **ctx 通道（P5 新增）** | `src/memory/bridge-telemetry.ts:14-38,44-66`（`BridgeCallTelemetryInput` + row 逐字段构造） |
| **CH 逐列映射（不变性证明）** | `src/clickhouse.ts:1070-1093` `buildToolCallLogRow`（camel→snake 逐列，无 spread） |
| CH sink 与 row 形状 | `src/clickhouse.ts` `ToolCallLogInput:985-1017`、`writeToolCallRow:1265-1278` |
| skill 桥埋点（9 reject + 3 emit） | `src/skill/skill-bridge.ts:458,465,473,483,496,521,535,554,565`（reject）/ `606,887,911`（emit） |
| **ctx 素材点（F15）** | `skill-bridge.ts:546`（`inboundBody` 作用域）、`:897`（`respText`）、`:911`（主 emit）、`memory-bridge.ts:394-412` |
| skill 桥已解析点 + lazy-pin | `src/skill/skill-bridge.ts:845`、`tryLazyPin :1017-1096`、调用点 `:948-949` |
| **注入面（F12：无 pinRepo）** | `src/skill/skill-bridge.ts` `SkillBridgeDeps`、`resolveBacking :118-134`、`:510-512` |
| memory 桥（响应 shape + emit） | `src/memory/memory-bridge.ts:412,431-460` |
| `files/download` 分支（F17） | `src/skill/skill-bridge.ts:575-591` |
| 事件表与索引 | `src/db/schema.ts`（`attribution_events` + `idx_ae_unit_dedupe`） |
| repo 三件套 + Null | `src/db/attributionEventRepo.ts:28-40,250,263,271,276` |
| 装配姿势（照 S2） | `src/injection/index.ts:414-418` |
| config 登记区 | `src/config.ts:89-93,327-360` |
| bridge 注册点 | `src/server.ts:124-129` |
| 降级/装配测试范式 | `src/attribution/__tests__/db-degraded-singletons.test.ts`（基座新增，本 spec §4 用例 9 照它） |
| 新建 harness 落位 | `src/skill/__tests__/bridge-fetch-events.test.ts`（全仓无 bridge 测试，F11） |

## 10. 设计决策（**已拍板** 2026-09-10）

| # | 问题 | 拍板结果 | 记账 |
|---|---|---|---|
| **P1** | `payload_json` 要不要落 `requestBody`（512 截断、已脱敏）？ | **不落**（设计侧倾向采纳） | 少一份长期敏感面；对账能力下降记 R5 |
| **P2** | memory-bridge 本期要不要落 fetched 行？ | **落**（设计侧倾向采纳，`asset_id` NULL） | 与 skill 通道对称；见 §3.4/§8.1 |
| **P3** | 新 `event_type` 词名 | **`asset_fetched`**（设计侧倾向采纳） | 与 v2 承诺的 `asset_used/validated/corrected` 同构；待登记 00 spec §3 |
| **P4** | 是否把 `tryLazyPin` 形状知识收敛到纯函数（唯一实现）？ | **不碰既有代码**（**采纳反方**，设计侧倾向被否） | 本期零触碰既有生产逻辑；代价 = 两份形状知识，对冲见 §3.2 对照表 + §4 用例 3 + **R8**（若漂移则下一轮重提唯一实现） |
| **P5** | §3.2（要响应侧原文）与 §3.3（sink 只收 `row`）**互斥**，走哪条？ | **B 扩展版 = `(row, ctx)` 双通道**（**否决 A**） | 理由：A 的"生产恒走请求侧回退"**也不成立**——请求侧同样只能拿 `row.requestBody`（512 截断串，F3）⇒ 会得到 NULL 或**静默错误**的 asset_id，硬档变假档，比不落更坏。成本 = 1 个可选 ctx + **4 处 emit 各 +1~2 行**（F15/F16），CH 逐字段不变有构造性证明（F14），17 处 reject 零改动。本文 §0"不改埋点调用点"作废 → **勘正 4** |

## 落地待办（文档侧）

- `00-master-spec.md` 登记（**已回填**，2026-09-10）：§9 文档清单把 `45-bridge-telemetry-sink.md`（L143 的"（v2 起）"行）改标**已完成**；
  §7 溯源矩阵补 v2 S4 行（叠加式 sink + 提取器 + 落点 + 验收口径）；§3 事件词汇表（L47）增 `asset_fetched`。
- 提交分组建议（DCO `git commit -s`，**4 组**；原 5 组映射经勘正 9 修正）：
  ① docs：本 spec（含 §5.5 冒烟证据 + 勘正 1–9）+ `00-master-spec.md` §3/§7/§9 登记
  —— spec 是**新增文件**，"① 设计版 / ⑤ 证据回填"拆开会在 ① 留下指向尚不存在的 §5.5 的悬空引用（F11 行、勘正 3 均提及 §5.5）⇒ 合并为一组
  ② 提取器纯函数 + 15 单测（`attribution/bridge-fetch-assets.ts` + `attribution/__tests__/bridge-fetch-assets.test.ts`）
  ③ **`(row, ctx)` 通道 + sink 链 + toggle**（`memory/bridge-telemetry.ts`、`types.ts`、`config.ts`、`skill-bridge.ts`、`memory-bridge.ts`）
  —— 本组只铺管道：ctx 字段在 ③ 结束时**暂无读者**（不构成行为差异）；**装配不在本组**
  ④ **SQLite sink 落点 + 装配 + harness 27 单测**（`attribution/bridge-fetch-events.ts`、`server.ts`、`skill/__tests__/bridge-fetch-events.test.ts`）
  —— `server.ts` 必须与本组同提交（`server.ts:12` import 本组的 `createBridgeFetchEventSink`，放 ③ 会 typecheck 红）；
  harness 同时 import ②③④ 三方产物 ⇒ **整文件不可拆**，原"② 含用例 4/7/10"落空，实际随 ④ 落地。

---

## 勘正记录

（锚点/口径错误在此追加，勿静默回改正文。格式：日期 — 原文 → 实际 + 证据。）

- 2026-09-10 **勘正 1（立项 §5 S4 行口径）**：原文"S4 遥测 `bridge-telemetry.ts`：executedEndpoint/teamId/agentId/sessionKey/**turnSeq**"
  → 实际 `turnSeq` **恒为 `undefined`**：字段虽在 `BridgeCallTelemetryInput`（`:16`）且有透传（`:52`），
  但两条桥 11 个 `emit*` 调用点**无一传值**（全 src grep 仅命中该文件自身）。
  证据：`skill-bridge.ts:458…911`、`memory-bridge.ts:263…412`（无一处含 `turnSeq:`）。**影响**：fetched 行的 `turn_seq` 只能 NULL，
  S5 的单元锚定不能建立在它之上（R1/§8.3）。
- 2026-09-10 **勘正 2（立项 §1/§3 "替代 ClickHouse no-op"口径）**：原文"sink 落 SQLite（**替代** ClickHouse no-op）"
  → 实际 `writeToolCallRow` 的 no-op **只在 CH 未启用时成立**（`if (disabled || !config) return;`）；
  CH 启用环境里它是**真实落点** ⇒ 正确姿势是**叠加**（新增 SQLite sink，保留 CH）而非替换，
  否则会静默丢掉既有 dashboard 数据（违反零行为回归）。证据：`clickhouse.ts` `writeToolCallRow`、`config.clickhouse.enabled`（缺省 false）。
- 2026-09-10 **勘正 3（本文草稿 §5.5/§3.2，同日自查修正）**：草稿写"既有 skill-bridge 测试复跑取证"+"形状知识收敛到唯一实现"
  → 实际 ①**全仓无任何 bridge 测试**（F11，grep `*.test.ts`/`*.spec.ts` 为空）⇒ 该证据不存在，改为 §5.5 的三条实际证据 +
  本期**新建 harness**；②`pinRepo` **无 deps 注入面**（F12）且 `tryLazyPin` 在 `search` 是多 pair、`files/read` 显式不 pin（F13）
  ⇒ "断言两边一致"会**假红**，改为 §3.2 对照表 + §4 用例 3a/3b 两段（预期差异显式列出）。
  证据：`SkillBridgeDeps` 定义、`resolveBacking :118-134`、`tryLazyPin :1040-1096`、全仓 grep 结果。
- 2026-09-10 **勘正 4（本文 §0/§1 承诺，互斥口径拍板 → P5）**：原文"**不改 CH 通路、不改埋点调用点**"
  → 实际二者**互斥**：extractor 需要请求体 `skill_id` 与响应体 `data.skill_id`（均需**未截断原文**），
  而 sink 只拿得到 `row`，其 `requestBody` 已被 `slice(0,512)`（F3）⇒ 坚持"零调用点改动"的后果是：
  **响应侧在生产永不执行**（死代码 + 假绿），**请求侧也只能拿截断串撞运气**（长 body 静默取不到 ⇒ 硬档变假档）。
  实测否决"严格零触碰"路线：**现有 sink 注入者 0 个**（sink 链是本期新建）⇒ 升级签名**迁移成本为 0**，
  真实代价只有 4 处 emit 各 +1~2 行（F15/F16）。
  **拍板 = P5**：sink 链签名 `(row, ctx)`，ctx = `{ inboundBody, responseText }`（**独立第 2 参**：不进 row、不落库、不打印）；
  §0 的"不改埋点调用点"**作废**，改为"**不改 CH 通路（逐字段不变）+ 17 处 reject 零改动 + 缺省关闭零行为回归**"。
  **未采纳 C（先做不冲突部分）**：口径现已唯一确定，拆轮次只会拉长窗口；且 sink 链与 ctx 必须**同 commit**（否则留下悬空字段）。
  证据：F14/F15/F16/F17 + `buildToolCallLogRow:1070-1093` + `bridge-telemetry.ts:44-66`。
  附带发现：立项文档 `codebuddy-scratch/v2-init/attribution-v2-boundary-scope.md` 在当前工作树 `find` **无命中**
  （本文 §1/§9 的引用保留；红线 6/7、DR-7 以本文引文为准，待确认归档位置）。
- 2026-09-10 **勘正 5（本文 §4 用例 2 措辞 vs §3.2 表，实现期发现，二者在一种输入上互斥）**：
  §4 用例 2 写"响应非 JSON / `code!==0` / 缺 `data` ⇒ 不抛、**返回 `[]`**"，而 §3.2 表对
  `get`/`WRITE_LOCK_OPS` 写"响应 `data.skill_id` **（缺则回退请求 `skill_id`）**"。当"响应不可用**且**请求侧有
  `skill_id`"时两者结论相反（`[]` vs 请求侧 asset）。
  → 实际按 **§3.2 表**实现（响应不可用一律回退请求侧）。**依据不是偏好，是 §3.3 的调用点表**：
  `skill-bridge.ts:887`（fetch 抛错）明确写"**无响应 ⇒ 只走请求侧**"——若响应不可用就返回 `[]`，
  那一行 `inboundBody` 传值将**没有任何读取者**，F15 的 4 处 emit 素材表会自相矛盾。
  即"响应不可用"与"响应合法但缺 id"在本期**同属"缺"**，统一走回退；`[]` 仅在两**侧**都取不到 id、或
  多资产/非单资产 sub 时产生（§3.2 表其余三列）。
  证据：`src/attribution/__tests__/bridge-fetch-assets.test.ts` 用例 2 把两条读法**分别显式钉住**
  （"两侧都无 id ⇒ `[]`" 与 "响应不可用但请求侧有 id ⇒ 回退请求侧"），不留隐式分歧。
- 2026-09-10 **勘正 6（本文 §3.1/§3.2/§3.4 两处口径留白，实现期补齐）**：
  ① `payload.multiAsset`：§3.1 只给了字段名与示例 `false`，未定义 memory 通道取什么。实际**仅当
  `bridgeSource === 'skill-bridge'` 且 `sub ∈ {search,listing,list,versions,create,delete,extract}`**
  才为 `true`；**memory-bridge 恒 `false`**（本期不解析其响应，`data.items[]` 的 multi 语义未冻结，§8.1 明令不猜）。
  ② `extractFetchedAssets` 的入参 `upstreamStatus`（§3.2 签名内含）**本期不参与判定**：响应侧由信封
  `code === 0` 拦非成功体（4xx/5xx 的 body 天然不是合法信封），请求侧按 §3.2 表**不设状态门**
  （单资产 sub 的请求 id 就是 LLM 点名要取的那个资产）。若日后要改成"仅 2xx 才算取过"，该函数是唯一改动点。
  证据：`src/attribution/bridge-fetch-assets.ts`（`MULTI_ASSET_SUBS`/`isMultiAssetSub`/`extractFetchedAssets`）、
  `src/attribution/bridge-fetch-events.ts`（`multiAsset` 组装处）。
- 2026-09-10 **勘正 7（本文 §8.4 的条件对冲**未触发**，3b 已做成真断言，无需降级）**：
  §8.4 预设"pin 侧无 deps 注入面（F12）⇒ 3b 可能只能人工对照"。实际**可行**：`config.storage.enabled=true`
  + `backend: "memory"` + 真 `KvVersionPinRepo` 从**同一 storage 读回**，即可在**不碰 `tryLazyPin`/`SkillBridgeDeps`**
  （P4 零触碰）的前提下断言一致性 ⇒ §8.4 的降级分支**不需要启用**。
  证据：`src/skill/__tests__/bridge-fetch-events.test.ts` 用例 3b 两个 it（`get` 走 `putTextIfAbsent`、
  `update` 走 `putText`，vitest 原始输出可见 `[storage/memory] ... (latest: putTextIfAbsent|putText)`
  ⇒ 真落盘发生，断言非空转）；读回口径 = `(space_id, user_id, agent_source, sessionKey, skill_id)`，
  其中 `sessionKey` 是**裸 conversation id**（`tryLazyPin` 调用点 `:948-949` 传的是 `sessionKey`，
  不是 emit 用的 `composite_key`）。
- 2026-09-10 **勘正 8（§4 用例 3 / §5 验收 #3 的隐含前提，冒烟实测暴露）**：
  `search` 有**三处前置短路**在 `emit*` 之前 `return`（`skill-bridge.ts`：缺 `user_key` → 500 /
  白名单 resolver A fail-closed → `{items:[]}` 200 / 白名单空 → `{items:[]}` 200），三者**都不发埋点**
  ⇒ 该次 search **既无 fetched 行也无 reject 行（0 行）**。
  → 实际口径：§5 验收 #3"一次 search ⇒ 1 行"**仅当白名单非空、真的打到上游**时成立；
  白名单空的 search 落 0 行。属**既有行为**（S4 未改这三处），非回归，但属 §7 R6 同类门禁空洞 ⇒
  登记为缺口 **§8.5**，本期不扩范围。
  证据：首次冒烟（core stub 未实现 `list-accessible` / `skill/list` 信封 ⇒ A 失败）时同一
  `search` 请求落 **0 行**；补齐两个信封后同一请求落 **1 行**（§5.5 ③，白名单 `A=1 B=1 merged=2`）。
- 2026-09-10 **勘正 9（落地待办"提交分组建议"的映射错误，切 commit 前实测修正 → 5 组收敛为 4 组）**：
  原建议"② 含**装配** + **用例 4/7/10**"**两处均不成立**：
  ① `server.ts:12` import `createBridgeFetchEventSink`（④ 的产物）、`:130` 调它 ⇒ 装配**必须与 ④ 同提交**，
  否则 ② 独立 checkout 时 `Cannot find module './attribution/bridge-fetch-events.js'`（typecheck 红）；
  ② `skill/__tests__/bridge-fetch-events.test.ts` 同时 import **三方产物**（`:34-36` ② 的 `addBridgeTelemetrySink`/
  `emitBridgeToolCallTelemetry`、`:43` ③ 的 `extractFetchedAssets`、`:44` ④ 的 `createBridgeFetchEventSink`）
  ⇒ **整文件不可按 ②/④ 拆**，② 的用例 4/7/10 实际随 ④ 落地，② 成为"只铺管道、无测试"的提交（已在该组说明里写明）。
  另：spec 为**新增文件**，①/⑤ 拆分会留下指向 §5.5 的悬空引用（F11 行、勘正 3 均提前引用 §5.5）⇒ ①⑤ 合并。
  证据：上述 import 行 + `git diff --stat`（7 改 / 4 增）+ 独立复跑 `npx vitest run bridge-fetch-events.test.ts
  bridge-fetch-assets.test.ts` = **27 + 15 = 42 passed**（与 §5.5 / 00-master-spec §7 的"单测 42"一致）。
- 2026-09-11 **勘正 10（本 spec 代码锚点坐标族在 51/52 两轮后过期 → 逐点实测重新登记；按 `:400` 规则 append-only，正文旧坐标不回改）**：
  根因是**基准错位**，不是笔误 —— §2 表头（`:42`）声明"行号以 head `7d92705` 为准"，而 `7d92705` 早于 **51 轮 ctx 改造**。
  此后 51 的插入（ctx 通道 + sink 链）与 52 的删除（`deriveSessionId` 收敛等）**叠加**在同一族文件上
  ⇒ 位移**逐点不同、无统一增量**（`skill-bridge.ts` 实测同时存在 +1 / +5 / +9 三种偏移）
  ⇒ 本 spec 的锚点一律"**先 grep 符号、再抄行号**"，**不能算**。
  受影响文件只有 3 个（51/52 均改过）：`src/skill/skill-bridge.ts`、`src/memory/memory-bridge.ts`、`src/memory/bridge-telemetry.ts`。

  **仍有效的锚点（两轮均未触碰，`git diff --name-only` 实测 = 0 行）**：
  `clickhouse.ts:1070-1093`（`buildToolCallLogRow`，F14 不变性证明的唯一来源）、`db/schema.ts`（`attribution_events` + `idx_ae_unit_dedupe`）、
  `db/attributionEventRepo.ts:28-40,250,263,271,276`、`config.ts:89-93,327-360`、`server.ts:124-129`（勘正 9 已另给 `:12`/`:130`）、
  `injection/index.ts:414-418`、`anthropicHandler.ts:647-650`。

  **52 后实测真值表（旧 → 新）**：

  | # | 文档位置 | 原锚点 | 52 后实测 |
  |---|---|---|---|
  | 1 | §2 F1、§9「埋点入口 + sink 参数」 | `bridge-telemetry.ts:44-46` | `:128-131`（emit + 默认 `sink` 参数） |
  | 2 | §2 F9、§9「埋点入口 + sink 参数」 | `bridge-telemetry.ts:120-136` | `:219`（`emitBridgeRejectTelemetry`） |
  | 3 | §9「ctx 通道（P5 新增）」 | `bridge-telemetry.ts:14-38` | `:14-64`（`BridgeCallTelemetryInput` 接口） |
  | 4 | §9「ctx 通道」、勘正 4 | `bridge-telemetry.ts:44-66` | `:134-151`（`const row: ToolCallLogInput = {` 逐字段构造） |
  | 5 | §5.5 | `bridge-telemetry.ts:89`（`_sinks`） | `:107` |
  | 6 | §2 F3 | `skill-bridge.ts:920` | `:894`（fetch 抛错）/ `:922`（主路径） |
  | 7 | §2 F7、§9「skill 桥已解析点 + lazy-pin」 | `skill-bridge.ts:845` | `:843` |
  | 8 | §2 F7、§2 F13、§9「skill 桥已解析点 + lazy-pin」 | `tryLazyPin :1017-1096`（F13 记 `:1040-1096`） | `:1024-1100` |
  | 9 | §2 F12、§9「注入面（F12）」 | `skill-bridge.ts:118-134` | `:119`（`resolveBacking`） |
  | 10 | §2 F12、§9「注入面（F12）」 | `skill-bridge.ts:510-512` | `:505-506`（`resolveBacking(config)` / `pinRepoInline`） |
  | 11 | §2 F12、§9「skill 桥已解析点 + lazy-pin」 | `skill-bridge.ts:948-949` | `:956`（`await tryLazyPin(...)`） |
  | 12 | §2 F15、§9「ctx 素材点（F15）」 | `skill-bridge.ts:546` / `:897` / `:911` | `:540` / `:905` / `:913` |
  | 13 | §2 F17、§9「files/download 分支（F17）」 | `skill-bridge.ts:575-591` | `:569-597` |
  | 14 | §3.1 口径注 | `skill-bridge.ts:253-254` / `:273` | `:245-248` / `:267`（`binding.agentSource`） |
  | 15 | §3.3 表（3 行） | `:606` / `:887` / `:911` | `:600`（新增 `:614`）/ `:885`（新增 `:899`）/ `:913`（新增 `:927`、`:929`） |
  | 16 | §9「skill 桥埋点（9 reject + 3 emit）」 | reject `458,465,473,483,496,521,535,554,565`；emit `606,887,911` | reject `452,459,467,477,490,515,529,548,559`；emit `600,885,913` |
  | 17 | 勘正 1 | `skill-bridge.ts:458…911` | `:452…913` |
  | 18 | 勘正 5 | `skill-bridge.ts:887` | `:885` |
  | 19 | §2 F3 | `memory-bridge.ts:429` | `:414` |
  | 20 | §2 F8、§9「memory 桥（响应 shape + emit）」 | `memory-bridge.ts:431-460` | `:423-452` |
  | 21 | §2 F15、§9「ctx 素材点（F15）」 | `memory-bridge.ts:394-412` | `:386-405` |
  | 22 | §3.3 表、§9「memory 桥」 | `memory-bridge.ts:412` | `:405`（新增 `:419`、`:421`） |
  | 23 | 勘正 1 | `memory-bridge.ts:263…412` | `:256…405` |

  **唯一未实测锚点（登记时现取，勿抄旧值）**：§5.5 引 `bridge-fetch-events.test.ts:198-207` —— 该测试文件本身是 51/52 两轮共 7 项 `M` 之一，
  行号同样漂移；用符号 `__resetBridgeTelemetrySinksForTests` 现取。

  **注**：§3.3 表改写后写的是"`skill-bridge.ts:614`"等**内容坐标**（该处应传什么），不是 emit 调用起始行 ——
  两者已不同（起始行 `:600`/`:885`/`:913`，新增行 `:614`/`:899`/`:927`,`:929`），阅读时以"新增行"为准。

  证据：2026-09-11 工作树逐点 `grep -n`（符号 → 行号）实测；`git diff --name-only` 对上述"仍有效"7 文件输出 0 行；
  §2 F16 的"4 + 17 + 1"分母复核为 `skill` 9 reject + `memory` 8 reject = 17 ✅、emit 4 处 ✅。
- 2026-09-11 **勘正 11（勘正 10 的两处收尾；append-only，正文不回改）**：
  ① `clickhouse.ts:1070-1093` 补全为 `src/clickhouse.ts:1070-1093` —— 真身不在 `src/attribution/`（同族 `bridge-fetch-*.ts` 才在该目录），勘正 10 那份"仍有效"清单里只有它会被按就近目录误读；`:356` 原本已写全路径。现取：`:1070` = `export function buildToolCallLogRow(input: ToolCallLogInput): ToolCallLogRow {`、`:1093` = 函数收尾 `}`（范围 24 行，与旧引一致）。
  ② 勘正 10 的"唯一未实测锚点"已实测：§5.5（`:282`）引的 `bridge-fetch-events.test.ts:198-207`（"beforeEach/afterEach 双向复位"）**已过期**；现取符号 `__resetBridgeTelemetrySinksForTests` = `:38`（import）、`:223`（`beforeEach` 体，`:222` 起）、`:230`（`afterEach` 体，`:228` 起）、`:913`（用例内复位）。旧 `:198-207` 现值 = session-init fixture 尾部（`:198-203`）+ 空行（`:204`）+ `baseInput` 辅助函数起头（`:205-207`），与复位无关。
  证据：2026-09-11 工作树 `grep -n` / `awk` 逐点实测；`git diff --name-only` 仍为 6 项、无新增文件。
- 2026-09-11 **勘正 12（§7 R1 的锚定策略已定；append-only，R1 原行不回改）**：
  §7 表 R1 行（当时 `:308`）写"S5 只能按 `session_key + created_at` 时间窗/排他性锚定"——**两处表述已过时**：
  ① `session_key` 连接条件：P-0 发现 A（fetched 落 `claude-code:<sid>`、units 落 `<sid>`，永不相等）已由 **51 键归一**修掉
  （e2e `bridge-fetch-events-e2e.test.ts` 用例 12 钉死；P-0a 真库复测：同会话 fetched 与 units 同 bare 键、composite 前缀行数 = 0）；
  ② `created_at` 定序：K4（墙钟可回拨）⇒ 定序键已定为 **`rowid`**（插入序），`created_at` 只做 `non_monotonic` 自检与展示。
  **锚定策略本体 = `50-attribution-judge-worker.md` §10**（55 交付：契约 C1–C5 + 纯函数 `src/attribution/fetched-anchoring.ts`
  + 读口 `AttributionEventRepo.listBySessionWithRowid` + T1–T7 红绿 + P-0a 真库复测）。
  R1 行的"若 S5 要求精确轮次，需另开捕获点，不在 S4 假造"结论**不受影响**（§10 C2 跨轮边界仍 `unresolved`，禁猜方向）。
