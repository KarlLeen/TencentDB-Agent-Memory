# S2 Spec — EventObserver：注入生命周期事件落库（带真实资产维度）

> 隶属：[00-master-spec.md](./00-master-spec.md) 的切片 S2。
> 本 spec 只覆盖一件事：**把一次注入请求的生命周期写成 `attribution_events` 行，且产资产
> block 的生命周期行带真实 `asset_id` 维度（聚 S0 的 `metadata.assets`）**。
> 依赖：S1（事件表 + repo，10-event-table.md）+ S0（产资产 injector 附 `metadata.assets`，
> 15-injector-asset-metadata.md）。
> 实现仓库分支：`feature/attribution-event-capture`。

## 1. 目标

在 `attribution_events` 表产生带真实资产维度的注入生命周期事件：

- 每个注入请求记一行 pipeline 级 `start`、`done`/`error`；
- 每个 hook 记 `start`、`done`/`error`；
- hook `done` 的 block 带 `metadata.assets` 时，按"一个事件行只挂一个 (asset_id, asset_type)"
  （10-event-table §4 写死的取舍）**摊成多行**，事件层的 `asset_id` 可被 `idx_ae_asset` 直接查询；
- 一句话验收：**一次真实 CodeBuddy 请求在事件表产生带真实 `asset_id` 的生命周期行**。

## 2. 非目标（明确不做）

- 不做任何事件消费（v2 S5/S6/S7 才读）；不实现 S3 决策单元（`30-*.md`）。
- 不把 spans（资产↔注入文本区间）塞进事件 payload：S5 消费的是 **hook_cache 里同一份
  `metadata.assets + spans`**（S0 已保证随缓存存活），事件层只留身份维度和整块摘要
  （10-event-table §4"payload 里保留整块摘要"的上限就是摘要，不反范式堆 spans）。
- 不改变既有 observer 行为：默认关闭，config 未开 = 与现状逐字节等价。
- 不写日志降级/清理策略（v1 本地 SQLite append-only，无 TTL）。

## 3. 已精读的源码锚点（结论，改前不必再读整文件）

| 文件 | 现状要点 |
|---|---|
| `src/injection/observer.ts` | `InjectionObserver` 六个方法：pipeline start/end/error + hook start/done/error。现有三实现 Noop/Logging/Langfuse；Logging 的日志事件名 `injection.pipeline.start|done|error` / `injection.hook.start|done|error` 就是事件词汇表来源 |
| `src/injection/pipeline.ts` | `process()`：`safeCall(onPipelineStart(meta))` → executeHooks → `onPipelineEnd(meta, durationMs, hookResults)`；`executeHooks` 内每个 hook 依次 `onHookStart(hook, point)`、执行后 `onHookDone(hook, point, blocks, durationMs, cacheStrategy)`、失败 `onHookError(...)`。**hook 级回调不携带 meta**；resolveHookBlocks 的 cache 命中也会把缓存的 blocks 传进 onHookDone（S0 资产随缓存存活，能在这里被聚到） |
| `src/injection/index.ts:404-408` | observer 选型：`langfuse.enabled → Langfuse`，否则 `log.level ∈ {debug,info} → Logging`，否则 Noop；选出的 observer 传入 `InjectionPipeline`（全局缓存 bundle，`getInjectionPipeline` 复用同一实例，见下） |
| `src/types.ts` / `src/config.ts` | `ProxyConfig.injection: InjectionConfig`；yaml → 归一化的合并点在 `config.ts` ~385 行；`injection.assetReflection.markerOptIn` 是"只接受 boolean、缺省走 default"的现成姿势 |
| `src/db/attributionEventRepo.ts` | S1 五件套就位；`NewAttributionEvent`（spaceId 缺省 `_default`）/ append / appendMany / listBySession / listByAsset；写失败静默 warn |
| `src/injection/injectors/asset-refs.ts` | `metadata.assets: InjectedAssetRef[]` 类型与三态语义（15-spec §4.2：undefined=非产资产块 / `[]`=无资产可解析 / 非空=真实清单，assetId 块内不重复） |

### 3.1 关键约束：pipeline 实例是全局缓存的，observer 不可带会话态

`getInjectionPipeline` 复用同一 `InjectionPipeline`（index.ts `cachedBundle`），即同一 observer
实例要服务**并发**请求。现有 `LangfuseInjectionObserver` 用 `onPipelineStart` 把 meta latch 进
实例字段、hook 级再取——这在并发下会串台（请求 A 的 hook 回调可能读到请求 B 的 sessionKey）。
归因事件写错会话是数据污染，**EventObserver 一律不得 latch**：

- hook 级回调需要的 meta（sessionKey / turnSeq / userId / spaceId / agentSource）由
  **管线在调用点透传**，observer 保持无状态；
- 具体做法：`InjectionObserver` 接口给三个 hook 方法**追加尾部可选参数
  `meta?: AgentContextMetadata`**（可选参数 → 不破坏现有三实现签名，TS 少参实现仍满足接口），
  pipeline 三个调用点把 `ctx.metadata` 传进去。这是对既有接口最小、纯追加的改动，
  Langfuse/Logging 语义零变化（它们仍用各自原来的输入）。

## 4. 事件形状与落库契约

### 4.1 事件词汇表与"谁写哪一行"

| event_type | 触发点 | 行数 | asset 列 |
|---|---|---|---|
| `injection.pipeline.start` | onPipelineStart | 1 | 恒空 |
| `injection.hook.start` | onHookStart | 1/请求/hook | 恒空 |
| `injection.hook.done` | onHookDone | block 无资产 → 1；K 个去重资产 → **K 行** | 每行各挂其资产 |
| `injection.hook.error` | onHookError | 1 | 恒空 |
| `injection.pipeline.done` | onPipelineEnd | 1 | 恒空 |
| `injection.pipeline.error` | onPipelineError | 1 | 恒空 |

公共列（每行）：`space_id` = meta.spaceId（缺省 `_default`）、`user_id`、`agent_source`、
`session_key` = meta.sessionKey、`turn_seq` = meta.turnSeq（可空）、`created_at` = now。

### 4.2 缺会话键即放弃（防伪造，不兜底 traceId）

`session_key` 列 NOT NULL。meta 缺 `sessionKey`（未绑定会话的 passthrough / 早期异常路径）时，
该次回调**整段放弃**（不写、不打 error），与 Langfuse 缺 sessionKey 降级 noop 同一纪律。
绝不用 traceId / 随机串顶替 session（伪造键会污染按会话的查询与未来的回执 ACL）。

### 4.3 payload 结构（事件级、约定为最小摘要）

所有 payload 不含 body 内容，只含本次生命周期调用的标识与计数：

- `injection.pipeline.start`: `{ traceId, protocol, modelId, requestPath }`
- `injection.pipeline.done`: `{ durationMs, hookCount, totalBlockCount, errorCount, hooks: [{hookId, point, blockCount, durationMs, error?}] }`
- `injection.pipeline.error`: `{ errorMsg }`
- `injection.hook.start`: `{ hookId, point, cacheStrategy }`
- `injection.hook.error`: `{ hookId, point, errorMsg, durationMs }`
- `injection.hook.done`:
  ```
  { hookId, point, blockCount, durationMs, cacheStrategy,
    blockSource,                          // 首个含 assets 的 block 的 metadata.source，无则省略
    assets: [{assetId, assetType, name?, version?}] }   // 该逻辑事件去重后的整块资产摘要
  ```
  K 行资产行的 payload **相同**（都带整块摘要），只靠 `asset_id`/`asset_type` 过滤列区分行身份。
  摘要不带 spans（理由见 §2）；name/version 只在生产方已给出时随带（asset-refs 的可选字段），
  不额外请求 meta。

### 4.4 资产摊行规则（纯函数 `collectAssets`）

对 onHookDone 的 `blocks[]`：

1. 只认 `block.metadata?.assets` 为数组的 block；逐条目取 `{assetId, assetType}`，
   并保留该条目的 `name`/`version`（有则带，无则省）。
2. 条目不满足 `assetId`/`assetType` 为非空 string 时跳过（防脏数据，不 throw）。
3. 去重键 `assetType:assetId`（同一 block 内 S0 不变式已保证不重复，跨 block 仍可能重复，
   防御性去重取先到者）。
4. 去重后 K=0 → 写 1 行（asset 列空、payload.assets=[]）；K≥1 → 每资产写 1 行。

### 4.5 失败语义（沿用 repo 与 observer 纪律）

- 所有方法体外层 `try/catch`，绝不 throw（observer 必须 fire-and-forget）；
- repo 内部写失败已静默 warn（S1），EventObserver 不再二次打点；
- 单行写失败不影响同批其它行（repo.append 逐行独立）。

### 4.6 observer 无状态 + 接线方式（相对 §5 锚点的决策记录）

- **不加实例字段**。全部方法只消费参数里的 meta / hook / blocks / error。
- `buildPipelineBundle` 的选型改为"**现有链保持不变 + EventObserver 可选叠加**"：

  ```ts
  // 伪代码 —— 实现见 §5.4
  observers = [];
  if (config.injection.attributionEvents.enabled) observers.push(new AttributionEventObserver());
  if (langfuse.enabled)        observers.push(new LangfuseInjectionObserver());
  else if (log.level ∈ {debug, info}) observers.push(new LoggingInjectionObserver());
  if (observers.length === 0)  observers.push(new NoopInjectionObserver());
  observer = observers.length === 1 ? observers[0] : new CompositeInjectionObserver(observers);
  ```

  为什么是**叠加**而不是"进原选择链替换"：全局缓存 pipeline + 默认关闭意味着必须满足
  "config 未开 = 与现状逐字节等价"；若 EventObserver 参与替换式选择，开了归因的人会静默丢掉
  原本的 langfuse/logging 观测——那不是"加功能"而是"换行为"。叠加（Composite）后：
  langfuse 开启 → langfuse 语义不变；归因开启 → 两者并行；都不开 → 与现状完全一致。
- `CompositeInjectionObserver`：纯转发器，逐个 child 调用并各自 try/catch（一个 child 抛
  不影响其它 child），放 `observer.ts`，实现同一接口。

## 5. 改动清单

### 5.1 `src/injection/observer.ts`

- `InjectionObserver` 接口：`onHookStart` / `onHookDone` / `onHookError` **尾部追加可选参数
  `meta?: AgentContextMetadata`**，注释写明由 pipeline 透传（并发安全，见 §3.1）。
- 文件尾追加 `CompositeInjectionObserver`（§4.6）。`Noop/Logging/Langfuse` 三实现**不改**
  （TS 方法少参实现仍满足接口；它们的语义本来就来自各自既有参数）。

### 5.2 新文件 `src/injection/attribution-event-observer.ts`

`export class AttributionEventObserver implements InjectionObserver`：

- 构造器 `(repo: AttributionEventRepo = getAttributionEventRepo())`——可注入便于单测；
  不加状态。
- 六个方法与 §4 契约一一对应；内部私有 helper：`eventBase(meta)`（§4.2 缺 sessionKey 返回
  null）、`emit(...)`（组装 NewAttributionEvent 调 repo.append）、`collectAssets(blocks)`
  （§4.4 纯函数，export 供单测）。

### 5.3 `src/injection/pipeline.ts`

三个调用点透传 meta：`onHookStart(hook, point, ctx.metadata)`、
`onHookDone(hook, point, blocks, durationMs, hook.cacheStrategy, ctx.metadata)`、
`onHookError(hook, point, error, durationMs, ctx.metadata)`。其余不动。

### 5.4 `src/injection/index.ts`

- import 两个新类；`buildPipelineBundle` 的 observer 块按 §4.6 改造；
- 模块导出追加 `AttributionEventObserver` / `CompositeInjectionObserver`（公共 API）。

### 5.5 配置开关 `src/types.ts` + `src/config.ts`

- `InjectionConfig` 追加：
  ```ts
  /** v1 S2 归因事件捕获（EventObserver）。默认关闭：未配 = 与现状逐字节等价（零回归）。
   *  true → 注入生命周期写入本地 attribution_events 表，产资产 hook 带真实 asset_id。 */
  attributionEvents?: { enabled: boolean };
  ```
- `config.ts`：DEFAULT 注入 `attributionEvents: { enabled: false }`；归一化照抄
  `assetReflection.markerOptIn` 的"只接受 boolean、缺省走 default"姿势。

## 6. 测试（单测）

新建 `src/injection/__tests__/attribution-event-observer.test.ts`，用内存 fake repo 直测 observer：

- pipeline start / done / error 各 1 行，公共列与 payload 断言（session/turn/space/user 落列）；
- hook start / error 行；
- hook done 无资产 → 1 行（asset 列空、payload.assets=[]）；
- hook done 多 block 资产重叠 → 去重摊成 K 行，每行 asset 列正确、payload 摘要一致；
- hook done `assets: []`（产资产块但无可解析资产）→ 1 行空资产；
- meta 缺 sessionKey / hook 回调无 meta → 整段不写（不 throw）；
- repo.append 抛错 → observer 方法不 throw（错误隔离）；
- composite：两个 child 都收到事件；child1 抛错不影响 child2（转发器错误隔离）。

## 7. 真实会话冒烟

复用 codebuddy-scratch/s0-smoke 的编排姿势（源码实例 + 本机 docker 栈 + 真实 CodeBuddy 协议
`/codebuddy/default/v1/chat/completions`），scratch 配置额外开
`injection.attributionEvents.enabled: true`，独立 `PROXY_DB_PATH`：

1. 发一次真实请求（会话注册 + 注入 + 上游一次真实生成）；
2. `SELECT event_type, count(*), asset_id ... FROM attribution_events WHERE session_key=…`
   → 断言出现 `injection.pipeline.start` / `.done`、产资产 hook 的 `injection.hook.done`
   行数 ≥ 其 `metadata.assets` 去重数，且 `asset_id` 为真实 id（skill_/wiki_/chat_memory-）；
3. 与 S0 冒烟对账过的内核资产集合做 `asset_id` 子集核对；
4. 第二请求（cache 命中路径）后行数增长、首次请求已写入的行未被改写（append-only）。

证据写入 `codebuddy-scratch/s2-smoke/`（不进 git）。

## 8. 验收清单（全部通过 = S2 完成）—— 2026-09-08 全部 ✓

- [x] observer.ts 接口 hook 级追加 meta（可选参数）；三实现零改动；Composite 就位。
- [x] EventObserver 无状态、六方法与 §4 契约一致；repo 可注入。
- [x] 资产摊行/去重纯函数单测通过（含脏条目跳过、重叠去重、K=0 单行）。
- [x] 缺 sessionKey / 无 meta / repo 抛错均不 throw（静默降级）。
- [x] pipeline 三调用点透传 meta；index.ts 叠加式接线；config 默认关、yaml 布尔开关生效。
- [x] §6 单测全绿（17/17 新增）；`npm test` 既有用例无回归（57/57，5 文件）；typecheck 无新增错误。
- [x] §7 真实会话冒烟通过（证据 `codebuddy-scratch/s2-smoke/S2-smoke-evidence.md`）：
      请求 #1 → 24 事件行、13 行带真实 asset_id（skill/llm_wiki/code_graph/chat_memory 全类型）；
      请求 #2 → 48 事件行，纯追加无改写。
- [x] 默认 config（开关未开）→ observer 选择链与现状一致（零行为回归，代码走读 + 57/57 回归确认）。

## 9. 开放问题

1. **行体积上限**：v1 每请求固定 2 + 2·Nhook 行左右，本地 SQLite 无压力；若未来接入
   S4 bridge sink / 高并发网关，生命周期行是否需要采样/降频 → 与 S4 一起定，本切片不预判。
2. **hook.done 摊行的时序排序**：同 ms 多行由随机 uuid `event_id` 决定顺序，消费端若需
   稳定的"同事件行邻接"，可加 `batch_id`（uuid）列并排 `created_at` 前缀索引 —— v1 不需要
   （按 session+type 查询即可），随 S5/S7 需要再加，不在本切片为未验证的需求改表。
