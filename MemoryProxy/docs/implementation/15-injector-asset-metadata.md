# S0 Spec — 产资产 block 附 `metadata.assets`（真实资产清单 + 文本锚）

> 隶属：[00-master-spec.md](./00-master-spec.md) 的切片 S0（v1，S2 前置）。
> 本 spec 只覆盖一件事：**四个产资产 injector 在产出的 block 上追加 `metadata.assets`**，
> 让每个注入块携带"它把哪些真实资产的什么文本摆到了模型面前"的结构化清单。
> 实现仓库分支：`feature/attribution-event-capture`。
>
> 前置已定：10-event-table.md §4.1 的真实资产匹配契约（事件侧消费方）、
> 00-master-spec.md §8.3（S0 折叠进 v1 的决策）。

## 1. 目标

S2（EventObserver）要写出带真实资产维度的注入事件；v2（judge/S5）要对
"决策引用句 ↔ 当时注入的资产文本"做确定性配对（三道锚点①②）。两者的共同前置：
**注入点在渲染时就把"真实资产身份 + 它在注入文本里的位置"结构化留下来**，而不是
事后从 prompt 文本反解析（后者被宿主拼装/截断/跨进程改写污染，不可靠）。

本切片为所有产资产 block 定义并实现这一结构化清单：

- 每个产资产 block 的 `metadata.assets` = 该 block 摆到模型面前的真实资产清单；
- 清单条目含可回查的 `(asset_id, asset_type)`（10-event-table §4.1 契约）+ 展示名 + 版本（有则带）；
- 能在注入器内**确定性定位**该资产渲染文本的 block 用 `spans`（方案 1 的"文本锚"）
  记下 `[start, end)` 区间，供 S5 把引用句直接切到资产；
- 定位不了的结构性场景（skill 的 listing 正文由上游预渲染、proxy 无 entry↔skill 映射契约）
  只挂身份（identity-only），并记录原因，不硬解析。

## 2. 非目标（明确不做）

- 不改 `metadata.source` / `metadata.cacheKey` 等既有键，只在现有 block 上**追加** `metadata.assets`。
- 不做 S2 事件落库、不做跨 block/prompt 的 offset 换算（相对 `block.content` 自洽即可，见 §4.3）。
- 不解析/不镜像上游渲染格式（skill listing）；不在注入侧为"版本漂移/正文变化"做快照（v2 S6）。
- 不为静态能力文档块（`skill-tools`、`tdai-tools`、asset-reflection）挂 assets —— 它们不产真实资产内容。
- 不读 `list-accessible` 补 version/status 等回查字段（那是消费端/S2 的事，避免每 block 多一次远端往返）。

## 3. 已精读的源码锚点（结论，改前不必再读整文件）

| 文件 | 现状要点 |
|---|---|
| `injection/types.ts` | `ContextBlock.metadata` 是 `Record<string, unknown>` 自由键；block 已占用键仅 `source`/`cacheKey`/`tool_name`，`assets` 无冲突（00-master §3 记录） |
| `db/hookCacheRepo.ts`、`db/kv-hook-cache-repo.ts`、`db/redis-hook-cache-repo.ts` | 全部是 `JSON.stringify(blocks)` 整块序列化、`get` 原样 parse —— **metadata 随 content 一起缓存/回放**，assets 能活到 S2 观测点 |
| `injectors/tdai-fixed-asset.ts` | `resolveFixedAssetCtxs` 返回 `[self, ...imported≤2]`；self 只靠 identity 构造，**绑定列表里的 chat_memory `item.asset_id` 用完即丢**；imported 用 `item.asset_id` 作绑定但没把它带回 ctx |
| `meta/client.ts` | `getAgentFixedAssets` 返回 `items: FixedAssetItem[]`（含 `asset_id`/`asset_type`/`name`）；`list-accessible` 返回 `AccessibleAssetItem`（含 `version`），ACL 已过滤，是"可回查"的权威判据 |
| `injectors/knowledge-tools-injector.ts` | `<knowledge_tools>` 一次渲染 N 个 `<knowledge type=… id="{knowledge_id}" …/>`；`KnowledgeItem` 有 `knowledge_id/type/name/service_url`；per-agent 路径经 meta 绑定（= 可访问），fallback 为 team 全量 |
| `injectors/skill-injector.ts` | `<available_skills>` 内容是 core `/v3/skill/listing` **预渲染的不透明字符串**；但 `result.hits: {skill_id, version, name}[]` 就是被列出的资产身份，当前只落 `skillCount/mode` 计数 |
| `injectors/tdai-profile-memory-injector.ts` | `<tdai_profile_memory>` 按 `resolveFixedAssetCtxs` 的 ctx 逐 agent 分段：有内容的 group 渲 `<agent …agent_id=…>` + L3（`truncate(…, 6000)`）+ L2 索引；全部为空则只注入 `MEMORY_TOOLS_GUIDE`（不产资产） |
| `injectors/tdai-l1-recall-injector.ts` | `<tdai_recalled_l1_memories>` 每轮动态：对每个 ctx `/atomic/search` → 合并 top-K → 逐条渲 `${i+1}. [type] [self|from X score=…] ${content}`；`metadata.sources = ctxs.map(agentId)` 是**被检索**的 agent，不是**实际贡献条目**的 agent |
| `MemoryPanel/src/panel/http/routes/chat-memory.ts`（self 资产权威） | self chat_memory id = `chat_memory-{teamId}-{agentId}`（agent id 以 `agt` 开头，与 `parseChatMemoryAssetId` 的 `-agt` 约定等价）；注释明确"自有记忆由 auto-mint 固定存在"，且禁止解绑 → **self 的 chat_memory 是真实存在的可回查资产，可确定性合成** |

## 4. 契约：`metadata.assets`

### 4.1 字段与类型（新文件 `src/injection/injectors/asset-refs.ts`）

```ts
export const INJECTED_ASSET_TYPES = ["skill", "llm_wiki", "code_graph", "chat_memory"] as const;
export type InjectedAssetType = (typeof INJECTED_ASSET_TYPES)[number];

/** `block.content` 上的半开区间 [start, end)。只相对该 block 自洽，不承诺 prompt 全局偏移。 */
export interface AssetTextSpan {
  start: number;   // 含
  end: number;     // 不含；<= content.length
}

export interface InjectedAssetRef {
  /** 真实资产 id（10-event-table §4.1）：skill_id / knowledge_id / chat_memory-{teamId}-{agentId}。绝不自造。 */
  assetId: string;
  assetType: InjectedAssetType;
  /** 展示名（agentName / knowledge name / skill name）。只读辅助，不作唯一键（可能重复）。 */
  name?: string;
  /** 版本：生产方手头本来就有才带（skill = hits.version）；没有就省，消费端需要时经 meta 回查当前值。 */
  version?: number;
  /**
   * 方案 1 文本锚：该资产渲染文本在 block.content 里的区间。一个资产在同 block 出现多次
   * （如 L1 召回同 agent 命中多条）合并为一条 ref、多段 spans。Tier B（见 §4.2）可为空。
   */
  spans?: AssetTextSpan[];
  /** spans 覆盖的渲染文本被注入器截断过（当前仅 profile 的 L3 `truncate(…, 6000)`）。 */
  truncated?: boolean;
}
```

### 4.2 `metadata.assets` 语义（三态，消费方据此区分）

| 状态 | 含义 | 谁产生 |
|---|---|---|
| 键不存在（`undefined`） | 本 block **不是**产资产 block（静态能力文档 / marker），S2 无需挂资产维度 | skill-tools、tdai-tools、asset-reflection 等 |
| `assets: []` | 是产资产 block，但本会话/本轮**无可解析资产**（如 profile 只注入 tools-guide） | 四个产资产 injector |
| `assets: [{…}, …]` | 产资产 block，K 条 = block 内含的真实资产清单，**assetId 不重复** | 四个产资产 injector |

一个 block 含 N 条真实资产内容 → N 条 ref；同一资产多次出现（L1 合并）→ 1 条 ref 多段 spans。

### 4.3 档位：谁给 spans，谁只给身份

| injector / block | 资产类型 | ref 粒度 | spans（文本锚） | 身份来源 | 时机 |
|---|---|---|---|---|---|
| knowledge-tools（`<knowledge_tools>`） | `llm_wiki` / `code_graph` | 每资源 1 条 | **有**：整个 `<knowledge …/>` 元素区间 | `resources[].knowledge_id`；type 映射 `wiki→llm_wiki`、`code-graph→code_graph` | session_init |
| skill（`<available_skills>`） | `skill` | 每 hit 1 条 | **无**（Tier B，见下） | `result.hits[].skill_id`（name/version 同源） | session_init |
| profile（`<tdai_profile_memory>`） | `chat_memory` | 每有内容的 group 1 条 | **有**：`<agent …></agent>` 段落区间（含 L3/L2 渲染段） | group 对应 ctx 的 `memoryAssetId`（§4.4） | session_init |
| l1-recall（`<tdai_recalled_l1_memories>`） | `chat_memory` | 每贡献 agent 1 条（合并 spans） | **有**：每条命中行的区间 | 命中条目的 `fromAgentId` → ctx `memoryAssetId`（§4.4） | 每轮动态 |

**skill 为什么是 Tier B（结构性限制，不是偷懒）**：`<available_skills>` 的 listing 正文由
core/plugin 预渲染，proxy 侧 `wrapAvailableSkillsBlock` 只是"镜面拷贝"——它拿不到
entry↔skill_id 的字节级边界契约；从命中 name 反推区间等于镜像上游格式，上游一改格式就脆断。
正确做法：v1 只挂 `hits` 身份（它本来就逐条对应被列出的资产，与现有 `skillCount` 同源），
spans 空。若上游未来在 listing 里带 `skill_id`（有契约），再升 Tier A（见 §9 开放问题 1）。

### 4.4 chat_memory 资产身份：self 与 imported 统一可解析

- **imported**：`FixedAssetCtx` 对应的绑定条目 `item.asset_id` 原样带回（本就在 `detail.items` 里）。
- **self**：记忆由 auto-mint 固定存在，id 确定性合成
  `chat_memory-${teamId}-${agentId}`（MemoryPanel chat-memory.ts:840-845 明确自有记忆不许解绑/auto-mint；
  `agentId` 以 `agt` 开头，等价于 10-event-table §4.1 写的 `chat_memory-{teamId}-agt{agentId}` 形态）。
  S0 按合成 id 视为可解析；**回查验收（§7）用 meta `list-accessible` 实测确认**——若实测取不到
  （ACL/未 mint 等），回到 §9 开放问题 3 处理，绝不伪造。

### 4.5 不变式（单测逐条守）

1. **ref 的 `assetId` 在本 block 内不重复**（同资产多次注入合并 spans）。
2. **spans 互不重叠、按 start 升序**，且都在 `[0, content.length)` 内。
3. **切片一致性**：`content.slice(span.start, span.end)` 恰等于该资产渲染文本（对 Tier A 逐条断言）。
4. **同步性**：同一产资产 hook 的 prewarm 与 execute（cache self-heal）两路径产出的
   `(content, metadata.assets)` byte 级一致（与 10-event-table §4.1 的"不碎片化缓存"同纪律）。
5. **无资产不产假**：profile 空 group 不产生 ref；l1 召回 0 条 → 返回 `[]`（无 block）；
   可解析才算资产，不可解析宁缺勿造。
6. **只加不改**：`metadata.source/cacheKey` 语义与渲染文本保持不变（改前改后 content 逐字节一致，
   用 golden 断言，防重构顺手改文案）。

## 5. 改动清单

### 5.1 新文件 `src/injection/injectors/asset-refs.ts`

放共享类型 + 两个纯工具 + 一个校验器：

```ts
/** 保留 join('\n') 的字节语义，同时给出每行起始 offset（供 spans 计算）。 */
export function joinLinesWithOffsets(lines: string[]): { content: string; offsets: number[] };
/** 由行区间 [first, last] 求 char 区间（offsets 来自 joinLinesWithOffsets）。 */
export function spanOfLines(offsets: number[], lines: string[], first: number, last: number): AssetTextSpan;
/** 测试用：校验 §4.5 的 1/2/3。实现期可不暴露到运行时。 */
export function validateAssets(content: string, assets: InjectedAssetRef[]): string[];
```

产资产 injector 若渲染是"逐行 push + `join('\n')`"（profile / l1-recall 现状即如此），
改走 `joinLinesWithOffsets` 即可零成本拿 span；knowledge 的元素是单段多行文本，
用 §5.3 的元素区间策略。**不管哪条路，content 必须与改前逐字节一致。**

### 5.2 `src/injection/injectors/tdai-fixed-asset.ts` — ctx 带资产身份

`FixedAssetCtx` 增加字段，返回前填充（`CACHE_KEY` 复用逻辑不变，additive）：

```ts
export interface FixedAssetCtx {
  teamId: string;
  userId: string;
  agentId: string;
  agentName: string;
  isSelf: boolean;
  /** 该 ctx 的记忆所属 chat_memory 资产 id；self = 合成，imported = 绑定 item.asset_id。 */
  memoryAssetId?: string;
}
```

改动点：
- imported 分支：`items.push({ …, memoryAssetId: item.asset_id })`。
- self 分支（两处：`selfCtx` 兜底 + 绑定存在时重组的 self 条目）：按 §4.4 合成
  `chat_memory-${teamId}-${agentId}`。注意 `detail.agent.team_id` 可能修正 team，合成用修正后的 team。
- 保留"解析不出就不设、调用方宁缺勿造"的既有纪律。

### 5.3 `src/injection/injectors/knowledge-tools-injector.ts`

`fetchBlocks` 拿到 `resources` 后（过滤能力开关之后），把渲染与资产清单一起产出：

- 抽一个纯函数从 `resources` 生成每个资源的元素文本及其在 content 的 `[start, end)`：
  现有 `resourceTags` 由元素 `.join("\n\n")` 后作为单个数组元素拼进 content，元素边界
  可按 `<knowledge type="{r.type}" id="{r.knowledge_id}"` 开头 + 到下一个 `<knowledge` /
  region 结尾（`\n## 调用方式`）之间扫描，元素文本必须与渲染完全同源（不许复制渲染逻辑）。
- 组装 block 时 `metadata` 追加：

```ts
assets: resources.map((r, i) => ({
  assetId: r.knowledge_id,
  assetType: r.type === "wiki" ? "llm_wiki" : "code_graph",
  name: r.name,
  spans: [{ start, end }],   // 第 i 个元素
})),
```

- fallback team 全量路径与 per-agent 路径同样处理（scope 只影响 cacheKey，不影响 assets 结构）。
- **只加不改**：渲染文本不动；用 golden 断言改前改后 content 一致（§6）。

### 5.4 `src/injection/injectors/skill-injector.ts` — Tier B

`renderListingBlocks` 里 `content` 组装后，metadata 追加（保留 `skillCount`/`mode` 不动）：

```ts
assets: (result.hits ?? []).map((h) => ({
  assetId: h.skill_id,
  assetType: "skill",
  name: h.name,
  version: h.version,
  // 无 spans：listing 正文由上游预渲染、无 entry↔skill 字节契约，见 §4.3。
})),
```

### 5.5 `src/injection/injectors/tdai-profile-memory-injector.ts`

`renderBlocksForContext` 重构 lines 组装为记录"每个 group 的行区间"：

- 遍历 `groups` 时，对每个**实际写了内容**（有 L3 或有 L2 条目）的 group 记下行号区间
  `[firstLine, lastLine]`（`<agent …>` 到 `</agent>` 之间的所有行，含两端；`MEMORY_TOOLS_GUIDE` 行不属于任何 group）。
- `lines.join("\n")` 换成 `joinLinesWithOffsets`，按行区间转 `spans`。
- metadata 追加：

```ts
assets: renderedGroups.map((g) => ({
  assetId: g.ctx.memoryAssetId,       // §4.4：self=合成、imported=绑定 item.asset_id
  assetType: "chat_memory",
  name: g.ctx.agentName,
  spans: [spanOfLines(offsets, lines, first, last)],
  truncated: didTruncateL3(g),        // 仅 L3 被 truncate(…, 6000) 时 true
})),
```

- `hasAnything === false`（tools-only）分支：metadata 追加 `assets: []`（产资产 block 但空清单，
  语义见 §4.2），内容不变。

### 5.6 `src/injection/injectors/tdai-l1-recall-injector.ts`

- 保留 `metadata.sources`（被检索的 agent，含 0 命中 —— 语义不变，S2 不要误读成已注入）。
- 新增从 `ctxs` 建 `agentId → memoryAssetId/name` 的映射；逐条渲染命中行时记录
  `merged[i].fromAgentId`，按贡献 agent 聚成 ref，每条的 `<行号区间>` 转 `spans`：

```ts
assets: Object.entries(contributorByAgent).map(([agentId, { itemLines, ctx }]) => ({
  assetId: ctx.memoryAssetId,
  assetType: "chat_memory",
  name: ctx.agentName,
  spans: itemLines.map((lineNo) => spanOfLines(offsets, lines, lineNo, lineNo)),
})),
```

- 0 命中 → 现路径已返回 `[]`（无 block），无需 assets。
- 每轮动态执行，无缓存问题。

### 5.7 不需要改的（记录为什么）

- **hook-cache 三实现**：`JSON.stringify(blocks)` 整块序列化，metadata（含新 assets）自动随
  content 缓存/回放；旧进程写的缓存缺 assets → 该会话冷启动一次没有资产维度，下一轮 prewarm
  覆盖后自愈（与现有"缓存 miss 自愈"同路径，不需主动失效）。
- **pipeline / observer / injectors 装配**：assets 只是 block 自带数据，S2 消费在 20-*.md 里定。

## 6. 测试（单测）

- **asset-refs 纯工具**：`joinLinesWithOffsets` 与 `join("\n")` 结果一致 + offsets 正确；`spanOfLines` 边界。
- **每 injector 的"清单正确"测试**（fake 数据驱动）：
  - knowledge：fake N 个 wiki/code-graph 资源 → block 有 N 条 ref，assetId/type/name 对、
    `content.slice(span)` 恰等于该元素、按 §4.5 校验器过；
  - profile：self（有 L3）+ imported（只有 L2）+ 空 group（跳过）→ refs 只含前两者、
    spans 覆盖各自 `<agent>` 段、L3 截断场景 `truncated: true`、tools-only 分支 `assets: []`；
  - l1：两个 agent 各命中多条 → refs 按 agent 合并、spans 逐行且不重叠；一个 agent 被检索但
    0 命中 → 它出现在 `sources` 但**不出现**在 `assets`（语义区分测试）；
  - skill：fake `ListingResult` → refs = hits 的 identity（无 spans），`skillCount/mode` 保留。
- **fixed-asset ctx**：fake detail 含 self chat_memory 绑定 + 两个 imported → 各 ctx
  `memoryAssetId` 正确（self=合成、imported=item.asset_id）；无 client 兜底 self-only 路径也合成。
  ✅ 2026-09-08（s0-s2-review F1 关闭）：直测落地为 `__tests__/tdai-fixed-asset.test.ts`（8 用例，
  覆盖无 client / self+imported / items=0 修正 team / 降级与缓存），见 s0-s2-review.md §4。
- **只加不改回归（golden）**：每个产资产 injector 在改动前把典型输入的渲染结果存 golden 字面量，
  改动后断言 content 逐字节不变（防止拼 span 时顺手改文案/换行）。
  - 2026-09-09 落地：`render-golden.snap.json` 快照 + `render-golden.test.ts`（§8 golden 行已勾，
    刷新命令 `npm run record:render-golden`）。
- **roundtrip**：把带 `metadata.assets` 的 block 走一遍 `hookCacheRepo.put/get` 的 JSON 序列化，
  读回后 assets 完整。

## 7. 真实会话冒烟

起代理跑一次真实 CodeBuddy 请求（会话注册 + 脚本化小任务）后：

1. 查 `hook_cache` 里 `knowledge-tools-injector` / `skill-injector` /
   `tdai-profile-memory-injector` 的 `blocks_json`：各自 `metadata.assets` 非空、
   元素 `content.slice(span)` 能取到对应资产渲染文本、assetId 不重复。
2. **回查验收**：每个 ref 的 `assetId` 经 `list-accessible` / skill / knowledge client 取回
   真实记录（self chat_memory 用 §4.4 合成 id 查）—— 全通过才说明身份契约成立；self 查不到
   即触发 §9 开放问题 3。
3. 脚本化任务某轮触发 l1 召回：该轮注入日志/DB 里该 turn 的召回块带 `metadata.assets`，
   且与 `sources` 不同时为空（区分被检索/被注入）。
4. 改前改后同一会话的 system prompt 字节 diff 为空（只加 metadata，不改文本）。

## 8. 验收清单（全部通过 = S0 完成）

- [x] `asset-refs.ts` 类型/工具/校验器就位，`validateAssets` 过所有产资产 block 的不变式。
  - 2026-09-08 回填：直测背书 `src/injection/injectors/__tests__/asset-metadata.test.ts` ——
    joinLinesWithOffsets/spanOfLines 纯工具用例 + validateAssets 检出重复/越界/重叠/空切片用例 +
    knowledge/profile/l1 三处产资产路径 `validateAssets(content, assets)` 返回 [] 的不变式断言。
- [x] `tdai-fixed-asset.ts`：`FixedAssetCtx.memoryAssetId` 三路径正确（self 合成 / imported 绑定 / 兜底）。
  - 2026-09-08（s0-s2-review F1 关闭）：直测落地 `__tests__/tdai-fixed-asset.test.ts`（8 用例）；
    F3 修复使"修正后 team 合成 self"在 items=0 路径也成立（review F3 已修）。
- [x] 四个产资产 injector 全部带 `metadata.assets`；静态能力文档块不带（三态语义成立）。
  - 2026-09-08 回填：直测背书每个产资产路径（knowledge 渲染产出 spans / profile 三态 / l1 命中态 /
    skill execute 后 `md.assets` == identity），单测中空态/未命中态不出资产；
    "静态能力文档块不带"由非产资产 injector 保持原 block（无 assets 维度）的默认路径 +
    S2 真实冒烟佐证：24 条 hook.done 中仅四种产资产类型带 asset_id，其余（含静态能力类块）无资产维度。
- [x] Tier A（knowledge / profile / l1）spans 通过切片一致性单测；Tier B（skill）身份正确且原因已文档化。
  - 2026-09-08 回填：asset-metadata.test.ts 的 Tier A 切片一致性用例（三类 producer 全过）；
    Tier B 身份由 skill 用例断言（identity 与 listing 一致）+ skill-injector.ts 行内注释与
    spec §4.1"skill 只产 identity、不产 spans"的既有决策文档化。
- [x] `l1-recall` 的 `sources`（被检索）与 `assets`（被注入）语义可区分且有单测。
  - 2026-09-08 回填：asset-metadata.test.ts 的 l1 用例（命中 agent 进 assets；
    "0 命中的 agent 不进入 assets，sources 语义保留在其调用方"）背书区分成立。
- [x] golden 回归：四个 injector 改前改后渲染文本逐字节一致。
  - 2026-09-09 勾回：`__tests__/render-golden-cases.ts`（4 组 canonical case：knowledge/
    profile/l1/skill）+ `__tests__/render-golden.test.ts`（content 逐字节 == `render-golden.snap.json`，
    9 用例）+ `scripts/qa/record-render-golden.ts`（`npm run record:render-golden` 刷新快照）。
    只锁 content 字节，metadata.assets 是合法增量不进比对。
  - 双版本字节背书：knowledge/skill 在 pre-S0（`c0cf94f` worktree）以同签名纯函数实测
    content 与快照逐字节一致（2720 / 1577 chars）；profile/l1 的 S0 改前组装内联于类方法
    （无独立纯函数出口），以 S0 diff 走读 + `joinLinesWithOffsets`≡`lines.join("\n")`（asset-refs.ts）
    论证搬迁等价；快照再锁死最终字节，任何未来 drift 即红。
  - 历史注记（2026-09-08）：当时为留白，旁证 = 渲染框架/行格式断言 + S0 diff 走读。
- [x] hook-cache roundtrip 单测通过（assets 随缓存存活）。
  - 2026-09-08 回填：asset-metadata.test.ts 的整块 JSON roundtrip 用例（hook-cache 同款
    JSON.stringify 序列化后 metadata.assets 不丢）；roundtrip 机制对任意 block payload 统一，
    故以 knowledge 块整块用例背书。
- [ ] §7 真实会话冒烟 1–4 全过（含 self chat_memory 回查）。
  - 2026-09-08 复查：S2 冒烟已实证真实会话里四种产资产类型全部带真实 asset_id（含 self
    chat_memory 合成 id 存在），但 hook_cache.blocks_json 逐块冒烟 / l1 召回轮 / system prompt
    字节 diff 三项未逐一执行 → 保留未勾，完整 1–4 属可选加分（勿重复造轮子）。
- [x] 未接 S2 → 运行行为与改前完全一致（assets 只是数据，无消费方，零行为回归）。
  - 2026-09-08 回填（时点性结论）：S0 落地提交 `ead8126` 先于 S2 接线（`cdfca0c`），当时 assets
    无消费方（纯数据）；随后每步提交均有 vitest 104/104 + tsc 恒定门控，S2 §8 默认 config 勾项
    亦背书零行为回归；S3 冒烟 noop 轮再次实测 feature 开关默认关时 decision 0 行、注入侧足迹照常。

## 9. 开放问题

1. **skill 升 Tier A 的时机**：若上游 listing 未来在文本里带 `skill_id`（或有 entry↔skill
   的稳定格式契约），skill 从 identity-only 升 spans；在那之前不镜像、不解析。
2. **self chat_memory 的实证**：合成 id 依赖"自有记忆 auto-mint 固定存在"（MemoryPanel 注释），
   v1 用 §7.2 实测确认；若某空间确实无 self 资产，self 的注入内容不可回指 → 由 20-*.md（S2）定
   事件侧 `asset_id NULL + asset_unresolved` 的表示，S0 不伪造。
3. **spans 与"模型真看到"的距离**：spans 只表达管线注入了（injection.performed）；宿主若按
   char budget 整块裁掉/改写 prompt，尾部 block 的文本未必真进上下文 —— S3 用实际消息数组做
   最终可见性确认，S0 不承诺全局 offset（与 S3 抽取器吃全量消息的架构一致）。
4. **是否需要 `contentSha256`**：v1 不做（S2 payload 保持轻量）；若 v2 judge 要离线
   版本对比/快照，随 S6 一起设计，不在注入侧堆字段。
