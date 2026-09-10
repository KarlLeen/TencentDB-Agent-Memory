# V2 立项评审（attribution-v2-boundary-scope.md）

> 评审对象：`codebuddy-scratch/v2-init/attribution-v2-boundary-scope.md`（REVIEW-PENDING）
> 日期：2026-09-09。方式：通读 + 与方案 V2 文档 §3.1–3.6、master spec §1/§3/§7、
> 30/10/15 spec（§4.7/§9/§10/§11）、v1 progress handoff 逐条对照 + 锚点代码抽样核实。
> 本 session 零改动仓库代码。

## 0. 结论 TL;DR

**建议：通过，带必改小项。** 事实核验总体准确（锚点抽样多数命中）；范围钉死、边界判定、
消费红线、执行顺序的判断我基本同意。需要改的不是大方向，是三处**会让下游 spec 走偏的口径**：

1. **DR-2 的"injected 锚重建"不能一概成立**（见 §3）：只有静态 session_init 块可锚重建，
   逐轮动态注入（L1 recall）与 fetched tool_result 必须落文本。叠加 15 spec 已交付的
   `metadata.assets` spans 事实后，P0 的真实增量是"**切片文本/可重建锚持久化 + skill Tier B
   文本锚补齐 + 版本锚入事件**"，不是笼统的"修 assetId 丢弃"。
2. **master spec §1 与 §7 自相矛盾**（§1 把 3.4/3.5 列为 v2、§7 标 S8=v3）——DR-1 只勘 progress 不够。
3. **S7 锚点行 `checkAclOrDeny` 位置勘正**：该函数在 `MemoryProxy/src/tdai/client.ts:381`，
   不在 MemoryPanel（§5 S7 行会误导 70 spec 撰写者）。

## 1. 事实核验（抽样，结论）

| V2 立项 spec 声明 | 核验 | 证据 |
|---|---|---|
| v1 head `764aa35` 全闭环 | ✅ | git log 顶部 = `764aa35`（R6 golden harness + BP2 tsc gate） |
| master §7 S8 = v3（排序反哺） | ✅ | 00 spec L111 `v3：信用分→排序/索引行（§3.4/3.5）S8` |
| **master §1 无矛盾** | ⚠️ **否** | 00 spec L21-22 把"以及设计文档 3.4/3.5 的排序反哺"列在"明确推迟到 **v2**"段 → 与 §7 冲突；progress §2 同源。DR-1 只勘 progress 不彻底 |
| S4 sink：`clickhouse.ts` `writeToolCallRow` no-op | ✅ | L1265-1266 `if (disabled || !config) return;` |
| bridge telemetry 字段（executedEndpoint/teamId/agentId/sessionKey/turnSeq） | ✅ | `memory/bridge-telemetry.ts` L15-55 |
| server.ts `skill-bridge/*` 注册 | ✅ | `src/server.ts` L124-127（`app.post("/skill-bridge/*", …)`） |
| MemoryCore `source_message_ids` 硬编码空数组"四处" | ✅≈ | `record/l1-reader.ts:80`（注释"not stored in SQLite"）、`l1-dedup.ts:242/291`（claim 241 偏差 1 行）；auto-recall 未抽查（低风险） |
| code-graph.ts 8 类查询 | ✅ | `routes/code-graph.ts` L5 `Query (8): search/explore/callers/callees/impact/node/status/files` |
| **S7 `checkAclOrDeny` 在 MemoryPanel** | ⚠️ **否** | 全仓唯一实现在 `MemoryProxy/src/tdai/client.ts:381`；MemoryPanel 无此符号。Panel 侧等价 ACL 落点须 70 spec 精读时确认（可能走 MemoryCore gateway scope 校验） |
| **P0 前置事实：metadata.assets"已有两级"** | ✅（关键） | 15 spec §4.1-4.3：Tier A（knowledge/profile/l1-recall）已带 **spans = block.content 字节区间**，切片即 `content.slice(span)`；Tier B（skill listing）只身份、无 spans（结构性：上游预渲染 opaque listing） |

## 2. 范围/边界评审

- **V2 定位句**（接上"被推迟的后半截"）与 §2 三箱划分（in/v3/上游）判断正确；
  "v1 表只读、判定产物走新表、不碰无迁移纪律"（红线 6/DR-3）同意——这是零成本正确选项。
- **v1 遗留 → V2 映射表**逐行核对 30 spec §9 / 15 spec §9，映射准确，无错位。
- **执行顺序**（P0→基座→S4→S5→S6→S7）合理；S5 承重墙的评审倾斜判断同意。
- **红线 7 条**基本成立。缺一条 v2 特有的幂等纪律 → 建议补为**红线 8**（见 §4）。
- 一处 mapping 提示：30§9.5（OpenAI 结构解析）映射到"S5 全通道覆盖清单"是**验收项而非设计项**——
  双通道判定一致性要落成 golden/冒烟样本，否则只是口号（已并入 DR-6）。

## 3. DR 逐条建议

| # | 建议 | 理由（压缩） |
|---|---|---|
| **DR-1** | **认**，附勘正 | 排序/信用/提升度留 v3 正确（master §7 已定）。但 master §1 与 progress §2 同源模糊——正式 40..70 spec 落地时，在 00 spec §1 同步加一句勘正（或注"3.4/3.5 以 §7 S8 为准"），否则读者扫 §1 仍会把排序反哺当 v2 |
| **DR-2** | **改**（见下） | 需实质化的三分法 + 采样纪律 |
| **DR-3** | **认**（命名初稿见 §5） | 新表 = additive `IF NOT EXISTS`，不动 `SCHEMA_VERSION=1`，与 v1 纪律天然一致，无需迁移 runner。三表粒度（状态行/判定明细/抽查池）建议 50 spec 前定稿 |
| **DR-4** | **认**，补两前置 | proxy 同库队列表 + 独立轮询 worker 单机最简正确。前置：(a) 基座验收要含"入队→worker 消费→幂等落库"三跳骨架（含任务边界触发事件源/水位占位），否则基座无验收物；(b) 多 worker/多 proxy 共享同库时 SQLite 争锁靠 WAL+busy_timeout+唯一键（v1 已实证跨进程重放），单实例先够 |
| **DR-5** | **认**，补冒烟通路 | fail-closed 正确。补：fork 本地若无"本地小模型端点"，S5/S6 真实冒烟会永远卡 → 基座必须含 **deterministic mock judge**（可注入），单测/golden/骨架冒烟走 mock，真实小模型 = 可选加分冒烟；冒烟语料全部非 restricted。restricted 判定默认关后"未评估"如何呈现留给 70 spec |
| **DR-6** | **认**，补两类样本 | golden 集除方案三类负例外补：(a) **版本漂移引用正例**（引用命中注入时旧版、当前存储已改 → 按锚版判定），锁 DR-2 的版本锚语义；(b) **双通道一致性抽样**（30§9.5 落点，anthropic/openai 同输入不同形状 → 判定一致） |
| **DR-7** | **认** | S4 只做 skill/memory 硬桥、curl 软通路不抗改写，正确。 |
| **DR-8** | **认**（不阻塞立项） | 并入 V2 最终验收预检合理；注意它是 fork 上会背书的前置项，别在最终验收窗口才发现缺 v1 证据 |
| **DR-9** | **认** | `764aa35` 冻结 v1 分支、切 `feature/attribution-v2` 依序提交，正确。 |

### DR-2 修改建议（实质内容）

现文把 injected 渲染块统一写成"按 注入点 + 版本锚点可重建、不全文入事件"。**这与动态注入的事实不符**：

- **可锚重建只对静态 session_init 块成立**：profile（固定资产 L3/L2 段落）、knowledge 元素、
  skill listing（若 listing API 带结构化 id/description + 版本）——给定注入时刻的资产版本，
  渲染是确定性函数，可重建。
- **逐轮动态注入不可重建**：`l1-recall` 每轮按检索结果渲染 top-K（含 `[self|from X score=…]`
  包装、截断），渲染内容取决于当轮 query，事后无法从资产存储重建——必须落文本。
- **fetched tool_result**：原文在消息流内、抽取时可见，落文本（有界截断）是唯一可靠路径，
  与 DR-2 现文一致。

**建议把 DR-2 改为三分法**：

| 来源 | 持久化策略 |
|---|---|
| 静态 session_init 注入（profile/knowledge/skill listing） | 版本锚（asset 版本/content_hash）+ spans 重建；重建函数单测覆盖 |
| 逐轮动态注入（L1 recall） | 捕获时落有界文本切片（沿用 v1 4000/16000 截断纪律 + chars 诚实标注） |
| fetched tool_result | 抽取时落有界文本切片（同截断纪律） |

连带影响（写进 DR-2 影响段）：
- **P0 验收样本要补动态类**：现文"一条 skill_view + 一个 session_init 块"只覆盖 fetched + 静态
  injected 两条路径，会把 L1 recall 这类动态 injected 排除在验证外。加一条"一次 l1-recall
  注入块在事件侧还原可见文本"（或等价的动态注入路径样本）。
- **文本量级先采样再定 schema**：P0 spec 起草前跑一次真实会话，统计每轮注入/拉取文本字节量，
  给 retention/截断数字，而不是拍脑袋（方案里的 16k 上限是给 payload 的，不是给可见文本库的）。
- **可见文本自足，不依赖 hook_cache**：hook_cache 是缓存（redis 有 TTL、按 hook 覆盖），
  不能作为判定期引用验证的存储底座；切片要进事件侧自足结构（延续 v1"payload 自足"纪律）。

## 4. 建议补进文档的内容（非 DR，但值得入档）

1. **红线补第 8 条：judge 判定幂等**。一次 (unit_id/候选 × round) 只能落一条 confirmed 判定；
   worker 重试、多进程并发不得双记。沿用 v1 纪律：append-only + 唯一索引兜底 + 冲突静默跳。
2. **v2 toggles 默认关闭逐字节回归 + 组合矩阵**：V2 每片 toggle 缺省 off，未配 = 零行为回归；
   组合矩阵照 30 spec §11.2 扩展到 v2 toggles × v1 toggles；新表清理 SQL 照 10 spec §10 姿势。
3. **触达服务 tsc 基线**：V2 若触碰 MemoryPanel/MemoryCore/MemoryKnowledge，各仓立 typecheck
   基线（BP2 姿势）；只动 MemoryProxy 的切片保持现状。
4. **task 边界触发的前移决策**：S5 worker 的触发（"任务结束"启发式的落点/水位）目前只存在于
   方案叙述，基座骨架需要一个可测最小闭环（触发事件 → 入队 → mock judge 消费 → 幂等落库），
   具体规则留给 50 spec，但基座验收物必须能证明三跳连通。

## 5. 命名初稿（红线 5 的"开会审后再定"——先给一版供拍板）

- 事件表（DR-3 三表初稿）：
  - `attribution_status_events`：状态机行，`event_type` = `asset_used` / `asset_validated` /
    `asset_corrected`（沿用 00 spec §3 已承诺词汇），按 unit_id/asset 关联 v1 决策行；
  - `attribution_judgement_details`：每 decision-unit 的判定明细（verdict、引用、三道机械锚点
    结果、evidence_source_type、置信档），`judgement_id` 幂等锚 = 消费端唯一；
  - `attribution_audit`：抽查/分歧池（含 `unconfirmed_suspect`，只服务展示层）。
- 队列表：`attribution_judge_queue`（proxy 同库），落 base 命名清单，避免与上游 `judge`/CostGuard 撞车。
- 上述仅为初稿；定稿仍按红线 5 在首个 slice spec（P0/40）撰写前确认一次。

## 6. 必改清单（按优先级）

1. DR-2 三分法落定 + P0 验收补动态路径样本（这是 P0 schema 与量级的前提）。
2. DR-1 勘正范围扩到 master §1（随 V2 正式 spec 落地同步）。
3. §5 S7 锚点行 `checkAclOrDeny` 位置改正，70 spec 撰写前精读 Panel 侧等价 ACL。
4. 红线补第 8 条（judge 幂等）。
5. DR-5 补 mock-judge 冒烟通路；DR-6 补版本漂移正例 + 双通道一致性样本。

其余（DR-3/4/7/8/9、基座顺序、范围三箱、映射表、红线 1–7）**无需改动**，按建议执行即可开始
P0 的切片 spec 撰写。
