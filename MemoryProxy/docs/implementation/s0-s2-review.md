# S0+S1+S2 评审（feature/attribution-event-capture，已完成切片）

> 评审对象：本分支**已提交并完成**的两个实现切片
> - `ead8126`（S0+S1）：asset-attribution 捕获链基础 —— schema/repo（10-event-table）+ 产资产 injector 附 `metadata.assets`（15-injector-asset-metadata）
> - `cdfca0c`（S2）：EventObserver 注入生命周期事件落库（20-event-observer）
>
> S3（`30-decision-unit-extractor.md`）尚未实现、不在评审范围。
> 日期：2026-09-08。评审方式：spec↔实现逐条对照 + 全量测试实证 + typecheck 差分。

## 0. 结论

**无 P0 / P1。** 实现与 15/20-spec 高度一致，改动干净、测试扎实。发现 1 个 P2（测试缺口）与 3 个 P3（口径/边界），均不阻塞合并，建议后续随 S3 一起处理。

实证基线（本机复跑）：
- 全套单测 **57/57 通过（5 文件）**，与 spec 声明一致：S1 repo 11/11、S2 observer 17/17、asset-metadata 17/17、smoke 4/4、既有 8/8 无回归。
- typecheck：55 个 TS 错误 **全部属于未触碰的 7 个基线文件**（anthropicHandler/codexHandler/workbuddyHandler/handler/session…/storage/factory…），S0/S1/S2 触碰的 18 个文件 **零新增错误**。
- 注：复跑前需 `npm rebuild better-sqlite3`（本机原生绑定过期导致 repo 测试误走 Null repo 全挂，属环境问题、非实现缺陷）。

## 1. Findings

### F1 [P2] fixed-asset 身份合成三路径无直接单测（spec 明文要求但缺失）

15-spec §6 / §8 要求 fake detail 单测覆盖 `resolveFixedAssetCtxs` 三路径（self 合成 / imported 绑定 item.asset_id / 无 client 兜底）；§5.2 强调 `detail.agent.team_id` 修正后用修正后 team 合成。实际**没有任何测试触碰 resolver**：

- `asset-metadata.test.ts` 与 smoke 全部用手工 `FixedAssetCtx` 字面量渲染，绕过真实身份合成：
```39:40:MemoryProxy/src/injection/injectors/__tests__/asset-metadata.test.ts
const importedCtx: FixedAssetCtx = {
```
```196:198:MemoryProxy/src/injection/injectors/__tests__/asset-metadata.test.ts
    // imported：只有 L2
    { ctx: importedCtx, l3: null, l2Entries: [{ path: "/scene/order", summary: "支付流程" }] },
```
- smoke 甚至自己调 `chatMemoryAssetId` 造 ctx（不经过 `resolveFixedAssetCtxs`）：
```123:141:MemoryProxy/src/injection/injectors/__tests__/loopx-real-assets.smoke.test.ts
function selfCtx(agentId: string, agentName: string): FixedAssetCtx {
  ...
    memoryAssetId: chatMemoryAssetId(REAL_TEAM_ID, agentId),
```
- 测试目录对 `resolveFixedAssetCtxs` 的引用为 **0**（rg 验证）。

影响：资产身份是整条归因链的源头锚点，`imported` 绑定回填、team 修正、self 合成任何一处回归，17+4 个测试仍全绿。建议补 `tdai-fixed-asset.test.ts`（fake `MetadataClient`），覆盖：无 client 兜底 self-only、detail 含 self+2 imported、items=0、`team_id` 修正四态，断言各 ctx `memoryAssetId`。

### F2 [P3] EventObserver 的 cacheStrategy 未按 `?? "none"` 归一化，事件内口径自相矛盾

`InjectionHook.cacheStrategy` 为可选（省略 = 行为等同 none）：
```348:348:MemoryProxy/src/injection/types.ts
  cacheStrategy?: CacheStrategy;
```
但 EventObserver 直接透传、不归一（Logging/Langfuse/pipeline 全做归一）：
```163:163:MemoryProxy/src/injection/attribution-event-observer.ts
        cacheStrategy: hook.cacheStrategy,
```
对照（其它消费点全部 `?? "none"`）：
```180:180:MemoryProxy/src/injection/observer.ts
        cacheStrategy: hook.cacheStrategy ?? "none",
```
```229:229:MemoryProxy/src/injection/pipeline.ts
            cacheStrategy: hook.cacheStrategy ?? "none",
```
后果：遇到未声明 cacheStrategy 的 hook 时，`hook.start` / `hook.done` 事件 payload 的键被 JSON.stringify 丢掉，而同请求 `pipeline.done` 的 `hooks[].cacheStrategy` 却写入 `"none"` —— 同一事件体系内口径漂移，未来按 cacheStrategy 过滤的消费方会漏。当前注册的 session_init hooks 均声明 cacheStrategy，现网暂不触发；L1 recall（未声明）已下线。建议两处补 `?? "none"` 并在单测加一例。

### F3 [P3] items=0 时 self 合成未走修正后 team

`resolveFixedAssetCtxs` 只有 `items.length > 0` 才用 `selfTeamId`（修正后）重组 self：
```116:128:MemoryProxy/src/injection/injectors/tdai-fixed-asset.ts
    if (items.length > 0) {
      // Prepend self (skip the temporary selfCtx)
      result = [
        {
          teamId: selfTeamId,
          ...
          memoryAssetId: chatMemoryAssetId(selfTeamId, selfAgent?.agent_id ?? identity.agentId),
```
items=0（detail 存在但无 imported 记忆）时返回的仍是顶部 `identity.teamId` 合成的 selfCtx：
```70:77:MemoryProxy/src/injection/injectors/tdai-fixed-asset.ts
  const selfCtx: FixedAssetCtx = {
    teamId: identity.teamId,
    ...
    memoryAssetId: chatMemoryAssetId(identity.teamId, identity.agentId),
  };
```
15-spec §5.2 的"合成用修正后 team"只在 items>0 路径满足。低频（需 detail.agent.team_id ≠ identity.teamId 且无 imported）。建议：重组条件放宽为 detail.agent 存在即重组 self，或至少补注释说明 items=0 时沿用 identity team 是有意取舍。

### F4 [P3/info] profile metadata 双 key 不一致 —— 存量，非 S0 引入

tools-only 块用 `l2Count`、index+tools 块用 `l2IndexCount`（git 差分证实 pre-S0 基线即如此；S0 只在其上追加 assets，15-spec "metadata 只加不改" 的声明诚实）。若未来消费方统一读 key 需留意，可随清理一并统一。

### F5 [info] S0 为已下线 hook 加资产逻辑（L1 recall）

`TdaiL1RecallInjector` 已下线不注册（index.ts 注释明确），但 S0 仍为其渲染函数附 assets 并配测试。现网事件不会出现 L1 资产行；若未来复活需补注册与冒烟对账。

## 2. 契约确认（正例）

| 契约点 | 结论 | 证据 |
|---|---|---|
| S2 pipeline 改动纯增量 | ✅ 4 处调用点仅追加 `ctx.metadata`，无行为改动 | `git show cdfca0c -- pipeline.ts` 全部 diff 即 4 处 `+meta` |
| observer 无状态（并发安全） | ✅ EventObserver 零实例字段，全量消费参数 | §3.1 latch 风险规避 |
| 缺 sessionKey 整段放弃 | ✅ 防伪造，不兜底 traceId | baseOf → 不写不 throw |
| 摊行/去重规则 | ✅ 与 §4.4 逐条一致（脏条目跳过、跨 block 去重取先到、K=0 单行空资产） | `collectAssets` 实现 + 4 个纯函数用例 |
| 配置默认关、纯叠加 | ✅ DEFAULT `enabled:false`（config.ts:84）；归一化仅收 boolean（config.ts:401-404）；选型"现有链 + EventObserver 叠加"，未开=现状逐字节等价 | index.ts observer 块 |
| 幂等锚 DDL | ✅ `UNIQUE(session_key, turn_seq, msg_seq) WHERE msg_seq IS NOT NULL` 与 10-spec 一致；S2 行（msg_seq/unit_id NULL）天然不冲突 | schema.ts |
| S0 assets 三态 + span 切片 | ✅ undefined/[]/非空；span 切片与渲染文本经测试断言一致；hookCache JSON roundtrip 保留 assets（S5 前提） | asset-metadata 17 用例 |
| 资产随缓存存活 | ✅ 资产由 producer 在 execute/prewarm 公共路径附着，缓存块含 metadata.assets | 实现走读 |

## 3. 建议跟进（不阻塞）

1. F1 单测补上后再推进 S3（S3 的资产解析直接消费这些 identity 来源）。
2. F2 的口径问题建议在 S3 排期里顺手归一（一处改动 + 一个用例）。
3. S3 实现前可在 30-spec 的"依赖与假设"里补注 F3 的边界取舍，避免后续实现再踩 team 修正语义。

## 4. F1–F3 处理记录（2026-09-08，S3 前收尾）

- **F1 [P2] 已补**：新增 `src/injection/injectors/__tests__/tdai-fixed-asset.test.ts`（8 用例），
  fake `MetadataClient` 直测 resolver：无 client 兜底 self-only / detail 含 self+imported
  （修正 team、错误 team 过滤、self 镜像过滤、>2 截断）/ items=0（即 F3 回归）/ 内核抛错降级 /
  单个来源 agent 失败跳过 / ctx 级缓存不重打内核。
- **F2 [P3] 已修**：`AttributionEventObserver` 的 hook.start / hook.done 两处 cacheStrategy 归一
  `?? hook.cacheStrategy ?? "none"`（与 Logging/Langfuse/pipeline.done 同口径），observer 单测 +2
  （17→19）。
- **F3 [P3] 已修**：`resolveFixedAssetCtxs` 改为内核成功返回即用 `detail.agent` 修正重组 self
  （不再以 `items>0` 为限），items=0 也走 selfTeamId；`detail.agent = {}`（内核无 agent 段）时各
  字段回退 identity，重组结果与既有兜底等价 → 15-spec §5.2"合成用修正后 team"在全部路径成立。
- **复验**：`npm test` **67/67**（6 文件：repo 11、observer 19、asset-metadata 17、fixed-asset 8、
  smoke 4、既有 8）；typecheck 55 错仍全在基线 7 文件，本次触达文件零新增。
  （复跑前 `npm rebuild better-sqlite3` 为本机环境前置，见 §0。）
- **F4 / F5 [info]**：不改代码 —— F4 随 v2 消费方统一 metadata key 时顺带清理；F5 若未来复活
  L1 recall 需补注册与冒烟对账（已记入 15-spec 现状）。
