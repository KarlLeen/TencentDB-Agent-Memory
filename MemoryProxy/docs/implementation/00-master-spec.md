# Master Implementation Spec — 资产归因捕获链路（v1: S0–S3）

> 定位：这是**落地地图**，不是设计复述。设计依据与论证见
> [竞赛作业报告 §3](../../../../TencentDB-Agent-Memory-Competition-clean%20copy.md)（教师已认可思路）。
> 本文件只回答四件事：改哪个仓库、哪些先做、新东西叫什么、怎么验收没有遗漏。
> 实现仓库：`KarlLeen/TencentDB-Agent-Memory`（fork），基线上游 `TencentCloud/TencentDB-Agent-Memory`。

---

## 1. v1 范围

v1 只做**捕获链路**的最小纵向切片（教师认可思路的承重墙）：

| 切片 | 内容 | 一句话验收 |
|---|---|---|
| S1 | 事件表 schema + SQLite repo | 能落库、能按 (session_key, turn_seq) 查回 |
| S0 | 产资产 injector 附 `block.metadata.assets`（真实 `asset_id` + `asset_type`） | 一个产资产 block 能读出它内含的真实资产清单 |
| S2 | EventObserver（第 4 个 `InjectionObserver` 实现）+ 接线 + 生命周期行带真实资产维度（聚 S0） | 一次真实 CodeBuddy 请求在事件表产生带真实 `asset_id` 的生命周期行 |
| S3 | 决策单元抽取器（纯函数 + 合并 + tool_result 跨请求配对）+ 游标 | 脚本化小任务在事件表产生带 `tool_use.id` 的决策单元 |

**明确推迟到 v2**：S4（bridge 遥测 sink）、S5（归因 worker）、S6（corrected 机器规则）、
S7（MemoryPanel 回执两页）、以及设计文档 3.4/3.5 的排序反哺。
> ⚠️ **勘正（2026-09-10）**：末项「排序反哺」**以 §7 `S8 = v3` 为准** —— §7 表格明写
> 「v3：信用分→排序 / 索引行（§3.4/3.5） | S8」。本行「推迟到 v2」只统指 S4–S7，
> **排序反哺不属 v2**。两处口径冲突时以 §7 为强约束（本行按勘正惯例保留原文，勿静默回改）。
~~S0~~ 已折叠进 v1 —— 事件必须能回指真实资产，否则 asset→decision 关联在事件层就断链（见 §8.3）。

v1 通过后再铺开，验收门槛不变（每切片：单测 + 真实会话冒烟）。

## 2. 分支与文档策略

- 新分支：`feature/attribution-event-capture`（从当前 fork head `c0cf94f` 起）。
- 上游 origin 只做基线同步，不直接往上推。本实现与文档（`MemoryProxy/docs/`）是参赛交付物的一部分，随分支提交。
- 提交习惯沿用 contributor 约定（DCO 签署，`git commit -s`）。

## 3. 命名与全局契约（防语义撞车）

从源码核实到的占用情况 → 我们的命名规则：

| 上游已占用 | 用途 | 我们的规避 |
|---|---|---|
| `judge-client.ts` / "judge" | CostGuard 模型升级判定（user/agent-turn，与本方案无关） | 新 worker 一律叫 **attribution judge worker**，文件名用 `attribution-` 前缀 |
| `extraction-gate.ts` / "extraction" | L0 提取放行控制 | 决策抽取统一叫 **decision-unit extractor** / `decision-unit-` 前缀 |
| `InjectionObserver` 三实现 | Noop / Logging / Langfuse | EventObserver 无冲突，保留 |
| `metadata.source` / `metadata.cacheKey`（block 上已有键） | 日志/缓存 | block 新增资产清单走 `metadata.assets: Array<{assetId, assetType}>`，不占用既有键 |

**v1 事件类型词汇表（`event_type`）**：`injection.pipeline.start|done|error`、`injection.hook.start|done|error`（S2 产生，延续 observer.ts 现有日志命名）；`decision_unit.created`（S3 产生）。**v2 S4 已产生：`asset_fetched`**（bridge 调用"真的取了哪个 skill"的硬档行，`payload.channel='fetched'`；见 `45-bridge-telemetry-sink.md`）。v2 再扩展 `asset_used/validated/corrected` 等状态事件（对齐设计文档状态机）。

**真实资产身份契约**：事件里的 `(asset_id, asset_type)` 必须回指资产体系里的真实实体、且能被
现有 client 回查——`skill` 的 `asset_id === skill_id`；`llm_wiki`/`code_graph` 的
`asset_id === knowledge_id`；`chat_memory` 为复合 id `chat_memory-{teamId}-agt{agentId}`。
回查源：`meta/client.ts`（`/v3/meta/asset/list-accessible`，含 `version`）/ `knowledge/core-client.ts`。
细节与捕获侧做法见 10-event-table.md §4.1。

## 4. 切片依赖与执行顺序

```
S1 事件表（无依赖，一切的下游接收端）
  ↓
S0 注入资产元数据（产资产 block 附 metadata.assets；逻辑独立，喂给 S2）
  ↓
S2 EventObserver（依赖 S1 + S0；meta + hook 结果 + block 资产清单 → 带真实资产维度的生命周期事件）
  ↓
S3 抽取器（依赖 S1；消息数组在 anthropicHandler，不走 observer）
  ↓
  接缝验证：真实会话冒烟（脚本化小任务）
```

S2 与 S3 互不依赖，可并行；但**都不依赖 S1 就没意义**，先 S1。

## 5. 已核实的源码锚点（写小 spec 前再精读）

| 切片 | 锚点文件 | 现状要点 |
|---|---|---|
| S1 | `MemoryProxy/src/db/schema.ts` | 现表：`meta`/`sessions`/`hook_cache`；`SCHEMA_VERSION = 1`；全 `IF NOT EXISTS` 无迁移 |
| S1 | `MemoryProxy/src/db/index.ts`（127 行） | SQLite 打开/初始化入口，加表在此注册 |
| S2 | `MemoryProxy/src/injection/observer.ts` | 接口 + Noop/Logging/Langfuse 三实现；fire-and-forget、绝不 throw 是硬纪律 |
| S2 | `MemoryProxy/src/injection/index.ts:400-431` | observer 按 config 选型（langfuse → logging → noop），EventObserver 在此加入选择链；`InjectionPipeline` 在此构造 |
| S2 | `MemoryProxy/src/injection/types.ts` | `AgentContextMetadata`（含 sessionKey/turnSeq/agentSource/modelId）；`ContextBlock.metadata` 是自由键 |
| S0 | `MemoryProxy/src/injection/injectors/knowledge-tools-injector.ts`（360-367）、`skill-injector.ts`（289-300）、`tdai-fixed-asset.ts` | 产资产 block 现仅 `metadata.source`，无结构化资产清单；真实 id 只内嵌在文本里（`<knowledge id="KID">`、skill 名、`chat_memory-` 复合 id） |
| S0 | `MemoryProxy/src/meta/client.ts`（`AccessibleAssetItem`） | 真实资产目录记录：`asset_id` + `asset_type` + `version` 等；`list-accessible` 已做 ACL |
| S3 | `MemoryProxy/src/anthropicHandler.ts` | `body.messages` 解析 ~618 行、`sessionKey` 解析 ~648 行、`getInjectionPipeline` ~667 行；全量消息历史在此可见 |
| S3 | `MemoryProxy/src/turnSeq.ts` | turnSeq 来源（`countHumanTurns`） |

## 6. 验收总纲

每个切片的小 spec 必须自带三节：

1. **单元测试**：覆盖规则边角（S3：同 message 合并、tool_use↔tool_result 跨请求配对、克制型触发、游标推进幂等）。
2. **真实会话冒烟脚本**：S1 手插一行 → `SELECT` 断言；S0 起真实请求后断言 block 带 `metadata.assets`；S2 起任何一次真实请求自动产生行；S3 用固定脚本化小任务（读文件→Edit→跑测试→`git commit -s`），随后按 session_key 查决策单元并断言含预期 tool_use.id。
3. **回滚口径**：所有新表 `IF NOT EXISTS`、所有 observer 方法内部 catch、S0 只加不改（injector 只在现有 block 上**追加** `metadata.assets`）、默认关闭（config 未开 = Noop 行为），保证零行为回归。

**v1.1 补丁（2026-09-09，二轮评审 H1/H2/H3）**：S3 spec 增补最小观测 + 撕裂窗口
unknown tombstone、vocab 命中矩阵 corpus、开启 checklist / 组合矩阵 / DB 清理 ——
落点 = 30-*.md §4.4/§4.7/§4.10/§5.6/§6 用例 19–22/§11 与 10-event-table.md §10。
验收口径不变（单测 + 真实会话冒烟 + 回滚口径），各片 spec 自查其开启 checklist。

**v2 起的通用验收口径**（真库隔离与凭证 / 证书精度 / 行号位移 / 两级 tsc 清单 / 哨兵）**以 `s4-smoke-design.md` 54 节为准**——此处不复述。

## 7. 溯源矩阵（保持"没有遗漏"的机制）

设计文档每一节核心主张 → 切片 → 落点 → 验收。v1 部分详列，v2 先占位。

| 设计主张（报告 §） | 切片 | 落点 | 验收 |
|---|---|---|---|
| 事件表：asset→decision→outcome 最小结构（§3.2） | S1 | schema.ts 新增 `attribution_events` 表 + repo | 单测 |
| EventObserver 写注入生命周期（落地①，事件带真实资产维度） | S2 | 新 `EventObserver` + index.ts 选择链 + 聚 S0 资产清单 | 真实会话冒烟 |
| 注入内容 ↔ 真实资产映射（§3.2 表 injected 档；锚点/回执的 asset_id 链） | S0（v1，S2 前置） | 产资产 injector block `metadata.assets` | 单测 + 冒烟断言 metadata.assets |
| 决策单元抽取：全量历史 + 自建游标增量（§3.2.1①） | S3 | anthropicHandler 接缝 + 纯函数 + 游标表 | 单测 + 冒烟 |
| 合并规则：同文件+同 message / tool_result 跨请求配对 | S3 | 纯函数内部 | 单测（重点） |
| 克制型单元 + risky 词表触发（§3.2.1①-3） | S3 | 纯函数内部 | 单测 |
| v2：bridge 遥测 SQLite sink（落地③） | S4 | **叠加式** sink 链（`memory/bridge-telemetry.ts` `(row, ctx)` 通道）+ 提取器 `attribution/bridge-fetch-assets.ts` + 落点 `attribution/bridge-fetch-events.ts`；CH 通路保留（勘正 2：不是"换 sink"） | 单测 42（含 9 类 reject / 真 pin 逐字段对照 / row+CH 列键集合）+ 真实冒烟 |
| v2：attribution judge worker（落地④） | S5 | 新进程 + prompt 版本管理 | **已完成**：`50-*.md`；proxy 门 50 files / 580 passed（judge/worker 单测群 + 六跳 e2e `s5-s7-e2e-smoke.test.ts`） |
| v2：corrected 三路机器规则 + 版本链快照（§3.2.2） | S6 | 规则层 + 事件消费 | **已完成**：`60-*.md`；`corrected-rules.test.ts` 5 tests + 六跳冒烟跳⑤（真 L1 规则） |
| v2：回执 + 抽查池两页（落地⑤） | S7 | MemoryPanel（契约 = `70-panel-read-and-audit-pool.md`；docs 编号顺延 60→70） | **已完成**：`70-*.md`；proxy 门 50 files / 580 passed + panel 门 8 files / 31 passed |
| v3：信用分→排序 / 索引行（§3.4/3.5） | S8 | 排序侧 | — |
| v1.1（二轮评审 R1/R4）：最小观测 + 分级日志 + 水位上限 | S3/S1 | 30 spec §4.10/§5.6；10 spec §5.2/§10 | §6 单测 21 |
| v1.1（二轮评审 R2）：撕裂窗口 risky 动作 unknown tombstone | S3 | 30 spec §4.4/§4.7 | §6 单测 19/20 |
| v1.1（二轮评审 BP1）：vocab 命中矩阵 corpus | S3 | 30 spec §5.1/§6 用例 22 | vocab-corpus 51 用例 |
| v1.1（二轮评审 H3）：开启 checklist / 组合矩阵 / DB 清理 | S3/S1 | 30 spec §11；10 spec §10 | 评审复查 |

矩阵随实现推进逐行勾掉，任何"教师认可思路里的点"不落在某行 = 明确决策推迟而非遗忘。

## 8. 开放问题（写对应小 spec 时回答）

1. **S3 接缝时机**：抽取应发生在 session-init/拦截判定**之前**还是**之后**？（拦截请求不产生决策，但 tool_result 在下一请求的 user 消息里，跨请求配对与拦截无关）→ 由 `30-*.md` 精读 anthropicHandler 后定。
2. **游标存储**：独立 `cursor` 表 vs 复用 events 表按 (session_key, turn_seq, msg_seq) 幂等去重 → `30-*.md` 定。
3. **S2 是否需要带 asset 维度**：→ **已定：需要**。事件必须能回指真实资产——`(asset_id, asset_type)`
   且经 meta/knowledge/skill/tdai client 可回查（身份契约见 10-event-table.md §4.1），否则
   asset→decision 关联在事件层即断链。实现路径：S0（产资产 injector 附 `metadata.assets`）
   折叠进 v1，作为 S2 前置。S3 决策单元的候选证据配对在 v1 之后（S5）消费同一份资产↔文本映射。

## 9. 文档清单

- `00-master-spec.md`（本文件）
- `10-event-table.md` — S1
- `15-injector-asset-metadata.md` — S0
- `20-event-observer.md` — S2
- `30-decision-unit-extractor.md` — S3
- `40-visible-text-archive.md` — **P0 已完成**（可见证据统一归档，两档 + 拼接窗口；
  闭验收 = 等价层 golden + S4 真 HTTP 冒烟，head `bf8af3d` / `d0f44a6` / `22fad92`）
- `attribution-base-design.md` + `attribution-base-checklist.md` — **共享基座（v2 前置骨架）**：
  队列表 + 独立 worker + 幂等落库（红线 8）+ 基座-c 引用验证工具（归一化 / 渲染包装剥离 /
  n-gram 稀有度 / 排他性检查输入源）。design 是任务书，checklist 是开启 checklist + 组合矩阵 + DB 清理
- `45-bridge-telemetry-sink.md` — **v2 S4 已完成**（bridge 遥测**叠加式** SQLite sink：`(row, ctx)` 双通道 +
  纯函数提取器 + 缺省关闭；产出 `event_type='asset_fetched'` 硬档行。CH 通路保留，零 DDL）
- `50-attribution-judge-worker.md` — **v2 S5 已完成**（判定主链：四态落库判别式 + worker 消费分支 + 候选分档/shortlist/裁决/状态事件 + 真 provider fail-closed + top-N 闸门）
- `60-corrected-rules.md` — **v2 S6 已完成**（corrected 三路机器规则；L1 版本漂移已落地 = `applyVersionDriftCorrections`）
- `70-panel-read-and-audit-pool.md` — **v2 S7 已完成**（回执 DTO + 池候选查询 + 状态写口；面板两页的权威契约）
- `s4-smoke-design.md` — **54 节通用口径链的权威载体**（真库隔离与凭证 / 证书精度 / 行号位移 / 两级 tsc 清单 / 哨兵；v2 起各单在此 append）
