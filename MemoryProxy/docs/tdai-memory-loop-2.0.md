# TDAI 记忆链路分析（2.0.x 修正版）

> 本文档修正此前"第一份报告"中的错误认知——**资产聚合（`resolveFixedAssetCtxs`）并非在"选定团队"时一次性完成**，而是**每次请求**（每次注入渲染 / 每次 memory-bridge 调用）时通过内核动态解析。
>
> 同时纠正另一处偏差：`TdaiL1RecallInjector`（L1 自动召回注入器）**已在 2.0.x 下线**，L0/L1 记忆不再自动注入 user prompt，改为 **system 静态注入 `<tdai_memory_tools>` 工具 + LLM 主动调用 memory-bridge** 的方式召回。

---

## 0. 结论速览（修正前后对比）

| 维度 | 第一份报告的认知（❌） | 2.0.x 代码事实（✅） |
|---|---|---|
| 资产聚合①时机 | "选定团队后资产聚合已完成，之后不再变化" | `resolveFixedAssetCtxs` 在 **每次请求** 时通过内核 `/v3/meta/agent-fixed-asset/list-with-detail` 动态解析（单请求缓存 `ctx.metadata.custom`） |
| L0/L1 召回方式 | 每轮 user prompt 自动注入（`TdaiL1RecallInjector`） | L1 recall injector **已下线**；改为 system 注入 `<tdai_memory_tools>` curl 配方，LLM 主动调 memory-bridge |
| L2 注入 | 全量注入场景正文 | 只注入 `<l2_scene_index>` 路径索引（path + summary ≤200），正文按需用工具读 |
| L3 注入 | 注入 persona 全文 | 注入 persona 全文（≤6000），并剥除尾部内嵌 Scene Navigation 避免与 L2 索引重复 |
| used 追踪 | 有显式 used 钩子 | 无显式 used 追踪；仅 `/analyse` marker 触发 `<asset_reflection>` 自评块 + Langfuse observer 观测 |
| validated | 有显式 validated | 无显式 validated 机制 |

---

## 1. 链路总览

```
┌──────────────────────────────────────────────────────────────────────┐
│ System Prompt（session_init 缓存）                                    │
│  ├─ <tdai_profile_memory>  ← TdaiProfileMemoryInjector               │
│  │     ├─ <l3_core_memory>（自有 + 借入 ≤2 agents 的 persona 全文）  │
│  │     └─ <l2_scene_index>（仅 path + summary 索引）                 │
│  └─ <tdai_memory_tools>  ← TdaiMemoryToolsInjector                   │
│        （6 个只读 curl 配方，指向 <proxy>/memory-bridge/v3/*）        │
└──────────────────────────────────────────────────────────────────────┘
                              │  LLM 主动 curl（recalled）
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ memory-bridge（MemoryProxy）                                          │
│  ├─ 强制注入身份（session IdFields，覆盖 body）                      │
│  ├─ allowlist 校验（仅放行 6 个只读 subpath）                         │
│  └─ 多 agent 合并：resolveMemoryCtxs → resolveFixedAssetCtxs          │
│        （self + 借入 ≤2 agents 逐次解析，非 session 级固化）          │
└──────────────────────────────────────────────────────────────────────┘
                              │  转发
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 内核 tdai gateway（MemoryCore）                                       │
│  /v3/atomic/search → handleAtomicSearch（selected）                   │
│       filter = { teamId, userId, agentId, taskId }                   │
│       **不带 sessionId**（L1 为 agent 维度跨 session 召回）           │
│       → executeMemorySearch（hybrid 双路 + RRF）                      │
│  /v3/conversation/search → 类似（L0 消息检索，默认 target=l1）        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. recalled（召回）—— 2.0.x 已重写

### 2.1 关键变更：`TdaiL1RecallInjector` 已下线

`MemoryProxy/src/injection/index.ts` 中注册逻辑已注释（见 `injection/index.ts` 文件内注释）：

> L0/L1 不再每轮自动召回注入到 user prompt（会破坏 KV/prompt cache）。改为只在 system prompt 暴露只读工具（见 TdaiToolsInjector），借助 system prompt cache 复用。L1 recall injector 已下线，recallL1 配置保留但不再注册。

即：`tdai-l1-recall-injector.ts` 仍保留 export（`injection/index.ts:76`），但 **factory 不再注册**，`recallL1` 配置项名存实亡。

### 2.2 当前召回 = 静态工具 + LLM 主动调用

| 层级 | 召回方式 | 代码 |
|---|---|---|
| L3 persona | 直接注入 system（session_init 缓存） | `TdaiProfileMemoryInjector.renderBlocksForContext` → `client.readL3ForCtx` |
| L2 场景 | 注入索引（path + summary），正文按需读 | `client.listL2ForCtx` → `<l2_scene_index>` |
| L0/L1 | system 注入 `<tdai_memory_tools>`（6 个 curl 配方），LLM 通过 Bash curl 主动调 memory-bridge | `TdaiMemoryToolsInjector`（`tdai-tools-injector.ts`） |

`tdai-tools-injector.ts` 注入的 6 个只读工具（映射到 memory-bridge 的 `MEMORY_TOOLS`）：

1. `atomic/search` — 检索原子记忆（L1）
2. `atomic/query` — 精确查询原子记忆
3. `conversation/search` — 检索会话消息（L0）
4. `conversation/query` — 精确查询会话消息
5. `scenario/ls` — 列出 L2 场景索引
6. `scenario/read` — 读取 L2 场景正文

### 2.3 资产聚合①（recalled 的"召回目标集合"）—— 核心修正点

**第一份报告的偏差**：认为"选定团队（session/space 绑定）后，资产聚合（self + 借入 agents 的上下文集合）已经完成，之后不再变化"。

**2.0.x 代码事实**（`tdai-fixed-asset.ts` 的 `resolveFixedAssetCtxs`）：

```ts
// 每次调用都动态解析；结果仅缓存在单请求 ctx.metadata.custom 内
export async function resolveFixedAssetCtxs(client, ctx): Promise<MemoryCtx[]> {
  // 1. 调内核 /v3/meta/agent-fixed-asset/list-with-detail（force=true 时跳过缓存）
  // 2. 返回 self ctx + 借入的 ≤2 个 agents ctx
  // 3. 写 ctx.metadata.custom（仅当前请求生命周期）
}
```

要点：
- **不是 session-init 时一次性固化**，而是 `TdaiProfileMemoryInjector.renderBlocksForContext` 与 `memory-bridge.resolveMemoryCtxs` **每次执行时都会调用**。
- 借入的 agent 集合随时可能变化（团队/技能绑定变动后，下一次请求即可感知）。
- 因此"召回目标集合"是**动态的**，文档写作时应表述为"每次请求解析"，而非"选定团队时完成"。

### 2.4 memory-bridge 的强制身份注入与多 agent 合并

`MemoryProxy/src/memory/memory-bridge.ts`：

- 所有 `/memory-bridge/v3/*` 请求都会用当前 session 的 `IdFields` **覆盖 body 里的身份字段**（防伪造）。
- 仅放行 `MEMORY_TOOLS` 中 6 个只读 subpath（写操作一律拒绝）。
- 无 `agent_id` 时走 **multi-search 分支**（`MULTI_SEARCH_SUBPATHS = ["atomic/search", "conversation/search"]`）：
  - 对 self + 借入的 ≤2 个 agents **全部并发**调用 upstream；
  - 按 sub 分派 items（atomic）或 messages（conversation）；
  - 按 `score` 降序排序 → `slice(0, limit)`；
  - 每条结果附加 `source_agent_id / source_agent_name / source_agent_role`，并返回 `searched_agents` 数组。

---

## 3. selected（选择）—— 内核检索与二次筛选

### 3.1 入口：`handleAtomicSearch`（MemoryCore `src/gateway/v2-router.ts`）

```ts
// L1 召回为 agent 维度（跨 session）：filter 只取 team/user/agent/task，
// **不带 sessionId**，否则会把其它 session 写入的 L1 记忆过滤掉
const searchFilter = {
  ...(iso.teamId ? { teamId } : {}),
  ...(iso.userId ? { userId } : {}),
  ...(iso.agentId ? { agentId } : {}),
  ...(iso.taskId ? { taskId } : {}),
  // 不传 sessionId
};
const result = await executeMemorySearch({ query, limit, type, filter: searchFilter, ... });
```

- 检索结果按 `score` 排序输出；同时非侵入式上报召回指标（`reportRecallMetrics`）并写 OTel span 属性（`tdai.recall.*`）。

### 3.2 `executeMemorySearch`（MemoryCore `src/core/tools/memory-search.ts`）

- **过度检索**：`candidateK = limit * 3`（先多召回，再做 type/scene 二次过滤）。
- **native hybrid short-circuit**：若 store 支持 `nativeHybridSearch && searchL1Hybrid`（TCVDB），单次调用完成 dense+sparse+RRF，跳过 SQLite 双路逻辑。
- **SQLite 双路并行**：
  - FTS5 路：`buildFtsQuery(query)`（jieba `cutForSearch` + 去停用词 + `"tok" OR "tok"`）→ `searchL1Fts`（BM25 rank → `bm25RankToScore` 归一化到 0–1）；
  - Vector 路：`embeddingService.embed(query)` → `searchL1Vector`（sqlite-vec KNN，距离转 score，跳过零向量/NULL distance）。
  - 双路结果用 **RRF 融合**（`rrfMergeL1`）。
- **策略降级**：`hybrid`（双路均有）→ `embedding` → `fts` → `none`（空 query / 无能力时）。
- **二次过滤**：`type` 精确匹配、`scene` 子串包含（lowercase），最后 `slice(0, limit)`。

### 3.3 L0 检索（conversation/search）

走 `handleConversationSearch`，默认 `target=l1`，同样支持 type/scene 过滤；`typeFilter=l0` 时检索 L0 会话消息（`searchL0Fts`）。

---

## 4. injected（注入）—— 分层差异

| 层级 | 注入内容 | 注入位置 | 缓存策略 |
|---|---|---|---|
| L3 | persona 全文（≤6000，剥除内嵌 Scene Navigation） | system.suffix | session_init（注册后注入一次） |
| L2 | `<l2_scene_index>` 路径 + summary（≤200），正文不注入 | system.suffix | session_init |
| L1 | **不注入**；由 LLM 主动 curl memory-bridge 获取 | — | —（工具输出，进 tool-use 上下文） |
| L0 | **不注入**；同上 | — | — |
| 工具 | `<tdai_memory_tools>`（6 个 curl 配方）+ `<tdai_profile_memory>` 后跟 `MEMORY_TOOLS_GUIDE` | system.suffix | session_init |

> 关键：L0/L1 检索结果作为 **curl 工具的输出** 进入上下文，不属于 system prompt 静态注入，因此不会破坏 prompt cache。

---

## 5. used（使用）

- **无显式 used 追踪代码**（不维护"哪条记忆被模型引用"的反馈回路）。
- `AssetReflectionInjector`（`asset-reflection-injector.ts`）：当请求 URL 带 `/analyse` marker 时注入 `<asset_reflection>` 块，引导 LLM 在回复末尾自评工具调用效果（近似 used 信号，但为 marker 触发、非持续）。
- `LangfuseInjectionObserver`（`observer.ts`）：将每次 hook 执行作为 span 挂到当前 turn trace 下，仅观测、不影响业务。

---

## 6. validated（验证）

- **无显式 validated 阶段**（无召回质量/一致性校验钩子）。
- 召回质量观测仅依赖 `reportRecallMetrics`（非侵入式上报）与 OTel span 属性。

---

## 7. contributed（贡献/写回）

| 层级 | 写入路径 | 说明 |
|---|---|---|
| L0 | `POST /v3/conversation/add`（proxy → 内核） | 会话消息落库；proxy 侧 `TdaiRecorder`/`recordTdaiTurn` 每轮记录 |
| L1 | L0 落库后**异步 extract**（`conversation/add` → `notifyPipeline` → 定时/阈值触发 L1 提取任务） | 从会话蒸馏原子记忆（场景分割 + 记忆提取 + 冲突消解）；`skill-core-sink.ts`（`SkillConversationExtractWorker`）将 L1 提取结果兜底登记为 skill 资产 |
| L2 | `POST /v3/scenario/write` | 场景记忆写入 |
| L3 | `POST /v3/core/write` | persona 写入 |

> 注意：所有写入走**主链路（proxy → 内核 v3 API）**，不经 memory-bridge（bridge 仅放行 6 个只读 subpath）。

### 7.1 L0 写入细节（proxy → 内核）

**触发点（`MemoryProxy/src/handler.ts`）**——每轮对话结束后记录一轮（user + assistant）：

| 分支 | 调用方式 | 代码 |
|---|---|---|
| streaming（`/v1/messages` SSE） | `trackWrite(withL0Retry(() => recordTdaiTurn(...)))` **非阻塞**，防拖慢 SSE；SIGTERM 时 `flushPendingWrites` 兜底 | `handler.ts:2191–2204` |
| 非 streaming | `await recordTdaiTurn(...)` 阻塞等待 | `handler.ts:1721–1725` |
| `/mem` 命令 | `await recordTdaiTurn(...)` | `handler.ts:1160–1167` |

入口统一带 `isExtractionAllowed(config, "tdai-memory")` 开关。

**`recordTdaiTurn`（`tdai/recorder.ts`）**：
1. `extractLatestUserMessage` 只取**最后一条真实 user query**（经 `extractUserQueryText` 剥离 `<additional_data>`/`<system_reminder>`/`current_time` 等 harness 噪声）——避免噪声进 L0 污染检索；
2. 组装 `[user, assistant]`（assistant 内容为空则跳过）；
3. 调 `client.addConversation(identity, messages)`。

**`client.addConversation`（`tdai/client.ts`）**：
- 检查 `isEnabled()` 且 `writeL0` 开关；
- `chunkConversationMessages` 按 `TDAI_CONVERSATION_MAX_MESSAGES` 分块（超长一轮拆多请求）；
- 每块 `POST /v3/conversation/add`（body 含 team_id / user_id / agent_id / session_id / task_id）。

**内核 `handleConversationAdd`（`MemoryCore/src/gateway/v2-router.ts:664–810`）**：
1. schema 校验（`conversationAddRequestSchema`）；
2. **isolation 强制**：`isolationConfig.enforce && legacy_compat_mode=false` 时缺 team/user/agent → 422；
3. **配额检查**：`quotaManager.checkMemoryQuota` → 超限返回 `4291`；
4. **资产自动登记**：`metaSvc.ensureChatMemoryAsset({team_id, agent_id})` —— 首次写某 (team,agent) 时自动 create `chat_memory` 资产 + append 绑定（进程内 LRU 短路），失败仅 warn 不阻塞写入（记忆可用性 > 资产一致性，下次调用自动重试）；
5. **逐条落库**：生成 `msg-{12hex}` id → 构造 `L0Record`（含 isolation tuple + recordedAt/timestamp）→ `embedding.embed(content)`（失败降级为无向量）→ `store.upsertL0(record, emb)`；
6. **触发 L1**：`notifyPipeline(serviceId, session_id, rounds, teamId, agentId)`（rounds = user 消息数，非致命，失败下次补跑）；
7. **standalone 模式镜像**：L0 追加写 `<dataDir>/conversations/<date>.jsonl`（grep 审计用，失败非致命）；
8. `quotaManager.reportMemoryAdded` 上报后返回 `accepted_ids`。

### 7.2 L1 提取细节（内核异步）

**任务触发（`MemoryCore/src/utils/stateful-pipeline-manager.ts:175–239`）**：
- `notifyPipeline` → `StatefulPipelineManager.notifyConversation`：
  - `sessionFilter.shouldSkip` 白名单/黑名单过滤；
  - service 模式要求 `effectiveInstanceId` 显式（standalone 走本地 backend）；
  - `getSessionState` 读 warmup 阈值 → 构造 L1 `taskPayload`（含 isolation tuple）→ `captureAtomic`。

**`captureAtomic`（`core/state/local-backend.ts:226–252`）**：
- 进程内计数 `count += rounds`；
- 达阈值（或 warmup 后首个会话）→ `enqueueTask(L1)` + reset；
- 否则设置 **idle timer**（`l1IdleTimeoutMs`），到点补触发——保证低频会话也能收敛。

**Worker 执行（`gateway/server.ts:2686–2758`）**：`executeL1` → `resolveStore`/`resolveStorage`（服务模式 COS / standalone JSONL）→ `core.runL1WithStore(sessionId, store, embedding, storage, checkpointLock)`。

**`createL1Runner`（`utils/pipeline-factory.ts:371–659`）**：
1. **Step 0 checkpoint**：`CheckpointManager.read` 读 `l1_cursor`（每 session 独立游标，防重复提取）；
2. **Step 1 over-fetch**：`queryL0GroupedBySessionId(sessionKey, cursor, L1_BATCH_QUERY=2N)`（DB 或 JSONL 兜底）取待提取消息；
3. **Step 2 切片**：取 `L1_BATCH_PROCESS=N` 条 + **same-ms 边界对齐**（同一毫秒的消息整组消费，避免把同一轮对话切散）；
4. **Step 3 分组**：按 isolation tuple（userId + agentId + sessionId）分组，保证隔离；
5. **Step 4 backlog 检测**：`hasFullBacklog`/`hasMore` 判定是否还要续跑；
6. **LLM 蒸馏**（每组）：`extractL1Memories`：
   - 质量门 `shouldExtractL1`（文本长度、符号密度、prompt-injection 关键词过滤）；
   - newMessages + backgroundMessages 拆分；
   - **Step 1 单次 LLM 调用**：scene segmentation（场景切分）+ memory extraction（记忆抽取），JSON-mode；
   - flatten + type 规范化 + `priority` 默认 50 + `maxMemoriesPerSession` 截断；
   - **Step 2 冲突消解**：`enableDedup` 时 `batchDedup`（冲突召回 `conflictRecallTopK=5` + LLM 决策 `store / update / merge / skip`）→ `applyDecisions`；否则 `storeAllDirectly`；
7. **`writeMemory`（`core/record/l1-writer.ts:163–292`）**：
   - `skip` → 丢弃；
   - `update/merge` → 查现有记录 `nextVersion` 递增 + 合并 content/type/priority/timestamps；
   - JSONL 追加（`records/<date>.jsonl`，storage 或 fs）；
   - vectorStore 可选 dual-write：update/merge 先 `deleteL1Batch(target_ids)` 再 `upsertL1`；
8. `checkpoint.markL1ExtractionComplete(sessionKey, storedCount, maxRecordedAtMs, lastSceneName)` 推进游标；
9. 返回 `profileScopes` → 触发 **L2 profile 构建**（L2 场景聚合的输入）。

---

## 8. 完整时序图（读取 + 写入）

### 8.1 读取链路（recalled → selected → injected → used）

```
用户提问
  │
  ▼
┌─ MemoryProxy: handler.ts ─────────────────────────────────────────────┐
│ 1. injectSystemAssets（session_init 已缓存 system prompt）            │
│    ├─ TdaiProfileMemoryInjector → <tdai_profile_memory>（L2 索引+L3） │
│    └─ TdaiToolsInjector → <tdai_memory_tools>（6 个 curl 配方）       │
│ 2. 组装 messages 调用上游 LLM                                          │
└────────────────────────────────────────────────────────────────────────┘
  │  LLM 决定需要记忆 → 执行 curl（Bash tool）
  ▼
┌─ MemoryProxy: memory-bridge.ts ────────────────────────────────────────┐
│ 3. extractSubpath + ALLOWED_SUBPATHS 校验（只读 6 个）                 │
│ 4. 强制身份：用 session IdFields 覆盖 body（防伪造）                   │
│ 5. resolveMemoryCtxs → resolveFixedAssetCtxs（资产聚合①：             │
│    self + 借入 ≤2 agents，user_key → 内核 meta 动态解析）              │
│ 6. multi-search 分支（无 agent_id 时）：并发查所有目标 agent 的 upstream│
│    内核 → 按 score 降序 → slice(0, limit) → 附加 source_agent_*       │
└────────────────────────────────────────────────────────────────────────┘
  │  POST /v3/atomic/search（Bearer + service-id）
  ▼
┌─ MemoryCore: v2-router.ts ────────────────────────────────────────────┐
│ 7. handleAtomicSearch（1192）：                                        │
│    filter = { teamId, userId, agentId, taskId } ← **不带 sessionId**   │
│    → executeMemorySearch（hybrid 双路 + RRF + type/scene 过滤）        │
│ 8. reportRecallMetrics + OTel span（tdai.recall.*）                    │
└────────────────────────────────────────────────────────────────────────┘
  │  items[]（L1 命中）
  ▼
LLM 结合结果生成回复 → 响应流回用户（used：无显式追踪，/analyse 可选自评）
```

### 8.2 写入链路（contributed → L0 → L1 异步提取）

```
每轮对话结束（streaming 不阻塞 / 非 streaming 阻塞）
  │
  ▼
┌─ MemoryProxy: handler.ts ─────────────────────────────────────────────┐
│ recordTdaiTurn（stream: trackWrite+retry 非阻塞；mem/非stream: await） │
│   → extractLatestUserMessage（剥离 harness 噪声）                     │
│   → client.addConversation(identity, [user, assistant])               │
│     → chunk 分块 → POST /v3/conversation/add                          │
└────────────────────────────────────────────────────────────────────────┘
  │
  ▼
┌─ MemoryCore: v2-router.ts handleConversationAdd (664) ────────────────┐
│ 1. schema 校验 → isolation 强制（422）→ quota（4291）                 │
│ 2. ensureChatMemoryAsset（资产自动登记，LRU，失败降级）                │
│ 3. 逐条: L0Record + embedding（失败降级）→ store.upsertL0             │
│ 4. notifyPipeline(serviceId, session_id, rounds, team, agent)         │
│ 5. standalone 镜像 JSONL（conversations/<date>.jsonl）                │
└────────────────────────────────────────────────────────────────────────┘
  │  rounds = user 消息数
  ▼
┌─ MemoryCore: stateful-pipeline-manager.ts ────────────────────────────┐
│ notifyConversation → sessionFilter 过滤 → captureAtomic：             │
│   count += rounds；达阈值 → enqueueTask(L1)；否则 idle timer 兜底      │
└────────────────────────────────────────────────────────────────────────┘
  │  L1 任务
  ▼
┌─ MemoryCore: pipeline-worker / runL1WithStore ────────────────────────┐
│ createL1Runner：                                                     │
│   1. checkpoint 读 l1_cursor                                         │
│   2. over-fetch L0（queryL0GroupedBySessionId, 2N 条）                │
│   3. slice N + same-ms 边界对齐 → 按 isolation tuple 分组             │
│   4. LLM 蒸馏：scene segmentation + memory extraction                │
│   5. 冲突消解：batchDedup（topK=5 冲突召回 + LLM 决策 store/update/   │
│      merge/skip）→ applyDecisions / storeAllDirectly                 │
│   6. writeMemory：JSONL + vectorStore（update/merge 先 delete 再 upsert）│
│   7. checkpoint 推进游标 → 返回 profileScopes → L2 触发               │
└────────────────────────────────────────────────────────────────────────┘
```

### 8.3 时序结论

1. **团队选定（session/space 绑定）** 只决定"允许借入哪些 agent"的**候选范围**；
2. 真正的**资产聚合①（`resolveFixedAssetCtxs`）在每次请求时执行**——渲染 `<tdai_profile_memory>` 时、以及每次 memory-bridge 调用时；
3. **L1 召回 = LLM 主动 curl**（system 里只有工具配方，没有记忆内容），因此**不存在"选定团队后自动聚合完成"的时点**；
4. 检索在**内核侧**完成（hybrid + RRF + type/scene 过滤），proxy 侧 memory-bridge 只做身份强制、allowlist 与多 agent 结果合并；
5. **L0 写入是同步主链路**（每轮 1 次 `conversation/add`），**L1 提取是异步副链路**（阈值/定时触发，游标增量，不阻塞对话）；
6. L1 从 L0 蒸馏而非独立写入：`atomic/write` 仅为显式 API，TDAI 主链路走 `conversation/add → notifyPipeline → extract`。

---

## 9. 相关代码索引

| 能力 | 文件 |
|---|---|
| 注入器注册（L1 recall 下线注释） | `MemoryProxy/src/injection/index.ts`（约 76、346–355 行） |
| L2/L3 注入 | `MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts` |
| 工具注入 | `MemoryProxy/src/injection/injectors/tdai-tools-injector.ts` |
| 资产聚合①（动态解析） | `MemoryProxy/src/injection/injectors/tdai-fixed-asset.ts` |
| memory-bridge（身份+allowlist+multi-search） | `MemoryProxy/src/memory/memory-bridge.ts` |
| used 自评（/analyse marker） | `MemoryProxy/src/injection/injectors/asset-reflection-injector.ts` |
| 观测 | `MemoryProxy/src/injection/observer.ts` |
| 内核检索入口 | `MemoryCore/src/gateway/v2-router.ts`（`handleAtomicSearch` ~1192–1279、`handleConversationAdd` 664–810） |
| 混合检索 | `MemoryCore/src/core/tools/memory-search.ts`（`executeMemorySearch` 87–315） |
| SQLite FTS/向量检索 | `MemoryCore/src/core/store/sqlite.ts`（`buildFtsQuery` 223、`bm25RankToScore` 315、`searchL1Fts` 3149、`searchL1Vector` 1470） |
| L1 提取兜底登记 | `MemoryCore/src/core/skill/conversation-add/skill-core-sink.ts` |
| L1 触发（阈值/定时） | `MemoryCore/src/utils/stateful-pipeline-manager.ts`（`notifyConversation` 175–239）、`core/state/local-backend.ts`（`captureAtomic` 226–252） |
| L1 提取执行 | `MemoryCore/src/utils/pipeline-factory.ts`（`createL1Runner` 371–659）、`core/tdai-core.ts`（`runL1WithStore`） |
| LLM 蒸馏 + 冲突消解 | `MemoryCore/src/core/record/l1-extractor.ts`（`extractL1Memories` 93、`applyDecisions` 608）、`core/record/l1-dedup.ts`（`batchDedup`） |
| L1 落库 | `MemoryCore/src/core/record/l1-writer.ts`（`writeMemory` 163–292） |
| L1 worker | `MemoryCore/src/gateway/server.ts`（`executeL1` 2686–2758） |
| L0 记录器 | `MemoryProxy/src/tdai/recorder.ts`（`recordTdaiTurn` 32）、`tdai/client.ts`（`addConversation`） |
