# P0 spec 复核 — 方向通过;以下须在转正式 40 spec 前收紧

- 日期：2026-09-09
- 复核对象：`codebuddy-scratch/v2-init/p0-archive-spec.md`（U 两档归档草稿）+ `p0sample-sampling.md`
- 基线：`feature/attribution-event-capture` @ `764aa35`（与 spec 声明一致）
- 结论：**通过（无 blocker）**。U 方案方向、两接缝、schema 骨架、互斥断言思路全部成立；5 条 B 级收紧 + 4 条 C 级观察，合并后即可转正式 `40-visible-text-archive.md`。

---

## 0. 代码实证——草稿的关键断言全部成立

| 草稿断言 | 代码实证 |
|---|---|
| S3 runner 在注入前、pipeline.process 在注入中 | anthropic：runner `anthropicHandler.ts:980`（import 971 邻近）< pipeline.process `:1195`；openai：runner `handler.ts:1083` < process `:1270`。**顺序事实成立**，档②天然不含本轮回注入块 |
| 档②可复用 runner 现成水位线/minIndex | `decision-unit-runner.ts` 内存 Map 水位 + `compacted` 归零语义已存在；增量推导逻辑现成 |
| 档①接缝 = observer hook.done 携全量 blocks | `injection/observer.ts` `onHookDone(hook, point, blocks, …)` 全量 `ContextBlock[]`；现实现仅取 200/300 preview，存档留白属实 |
| 装配点 = index.ts observer 列表 | `injection/index.ts:414-426`：`attributionEvents` push 段 → Composite；Noop/Composite 均存在 |
| `collectAssets(blocks)` 可复用 | `injection/attribution-event-observer.ts:49` export，identity 摊行逻辑现成 |
| repo 单例/事务/去重跳过先例 | `db/attributionEventRepo.ts:186-217` `appendMany` better-sqlite3 tx + conflict skip；`:263` `getAttributionEventRepo` 单例 |
| additive DDL 不动 SCHEMA_VERSION | `db/schema.ts:16` `SCHEMA_VERSION=1`；`:68` 注释明确"pure additive（IF NOT EXISTS）保持 1"；attribution_events 即先例 |
| 采样量级/cap 依据 | 静态注入单轮 17,456 chars / 25,190 B 逐轮恒等；长 tool_result 21.3k 单条；与 spec §3/§4 cap 数字一致 |
| L1 recall 注入器已下线、记忆走 fetched | `injection/index.ts:396-400` 下线注记 + 采样 §5，三分法②样本改落 fetched 通道合理 |

## 1. B1 — 档①的"全部渲染 block"是假设,须枚举可见正文来源（含不经过 hook.done 的路径）

草稿 §0/§3 说档① = "注入管线 observer 落全部渲染 block 全文…全覆盖"。但 `anthropicHandler.ts:935-942` 存在一条 **不经过 pipeline hook.done** 的可见正文路径：session-init 产出 `systemAppend` → `appendBlockToAnthropicSystem` **直改 `body.system`**（在 runner 之前、pipeline 之外）；openai 侧 `handler.ts:875` 有 `injectSessionContextWithToggles` 同一家族。若其文本与 pipeline 逐轮重渲染的 block 不完全同源，**init 轮的 system 内容会同时漏掉档①和档②**。

要求（落 40 spec）：
1. **枚举"模型实际收到的正文"的所有来源**（pipeline hook.done 块、systemAppend/context-injector、direct-inject 辅助路径），逐条标属档①/档②/两者皆非，不得以"未来 hook 全覆盖"带过；
2. **验收③从"可对齐"升级为硬比对**：用一次真实请求，比对**转发前 `injectedBody` 全文（含 system/首轮 session-context）的 golden 字节** vs `window()` 拼接结果——否则"看似全覆盖实则漏 system"的洞会在 S5 才爆。

## 2. B2 — 互斥断言（单测 7）有正当 false-positive 类别,会红在真实数据上

现文："档② message 原文不得整体包含档①任一 block.content"。真实链路里**fetched tool_result 可以合法地整体包含注入块文本**：

- 静态注入块每轮重注入（档①每轮都有 seen）；
- agent 先被注入某 skill 的 listing 块，随后 `skill_view` 取回该 skill **全文**（含与 listing 完全相同的描述段）；
- tool_result 在下一轮进入消息流并被档②归档 → **同轮**档① block 与档② tool_result 全文包含关系成立 → 断言红。

这不是漂移，是正常记忆工作流。要求：
1. 断言收窄到"**本回合新到、非 tool 回填**的消息 vs **本回合**发出的 blocks"，或对 tool 角色回填做显式豁免并分类记录；
2. 保留对"runner 被挪到注入后 → 注入块以新消息形式进入档②"的判别力（该场景是真漂移，不应豁免）；
3. 输出改为**违规分类**（真漂移 vs 合法回填），命中即留告警观测而非硬失败——与 v1"observer 绝不 throw / 降级留痕"同纪律。

## 3. B3 — 档②的 turn_seq 来源未定义

`runDecisionUnitExtraction` 参数里**没有 turnSeq**；`unit.turnSeq` 是 extractor 从 messages 内部推导的。而档②要在"有/无决策单元的每一轮"都给 `message_snap.turn_seq` 落值，且无单元轮没有现成 turnSeq。§8 测试 8 又要求档①②与 `attribution_events` 同口径对齐。

要求：40 spec 定义 `message_snap.turn_seq` 的取值来源（建议与 extractor 共用同一"轮次推导 helper"，而非各算各的），否则对齐测试只能测出"碰巧一致"而非"同一语义"。

## 4. B4 — 水位线缺 compaction/reset 语义;"窗口=完整可见正文"在 compaction 下不成立

1. **DB 水位**：runner 内存水位已有 `compacted`（消息数 < 水位 → 归零重放）语义，`attribution_archive_watermark` 表无对应处理。会话剪枝/重置后档②会停更或错位。§4 需继承同款归零口径（加一行）。
2. **窗口语义诚实标注**：拼接后 ≠"该轮模型实际可见正文"的两种情形要写明——
   - 档①（注入）**按轮精确**：静态块每轮服务端重注入，剪枝不影响；
   - 档②（消息流）是 **append-only 归档超集**：compaction 后旧消息仍在档里，而模型本轮已看不到 → `window()` 会高估。
   这直接影响 S5 引用验证的语义（"文本在窗口内"只能证"出现过"，不能证"本轮可见"）。P0 不解决 S5，但 §5 的"拼接…才等于完整可见正文"这句要改口为**分侧诚实**（档①按轮精确 + 档②为归档超集），并把 compaction 后的保守语义显式交接给 S5。

## 5. B5 — schema/契约自洽四小点

1. **去重键矛盾**：§3/采样建议 `(source, content_hash)`，但 SQL 只 `content_hash TEXT UNIQUE`。若 source 进键（跨 source 同文视为两条），约束要改成 `UNIQUE(source, content_hash)`；二选一定死。
2. **§5"同 content_hash 跨档重复时只保留一条"不可实现**：`message_snap` 无 hash 列，查询期算全文 hash 不可取；且互斥断言下跨档整文重复本不应发生。删掉该句，改为"结构性防重：档①文本行按 hash 去重 + 档② `(session_key, message_index)` 唯一 + 互斥断言"。
3. **排序键缺失**：§5 承诺"按 (turn_seq, order) 排序"，schema 里没有 `order` 列（档①只有 `block_idx`（hook 内）、档②只有 `message_index`，且两档跨档没有统一序）。引用验证其实**不需要全局严格序**；建议 API 只承诺"每档内部有序 + union 幂等"，或明确给出跨档序定义。
4. **`source` 取值来源未定义**：schema `source` 列没写取 `hook.id` 还是 `block.metadata.source`（采样按 hook.id 归类）。去重键一旦含 source，取值必须定死，否则跨会话去重语义漂移。

## 6. C 级观察（不阻塞，随 40 spec 消化）

- **C1 命名冻结时机**：P0 草稿本身就是首份定义 DDL 的切片 spec，而 §0 仍写"新表命名在落正式 spec 前最终确认"。与立项"首个定义 DDL 的切片 spec 前一次性确认"矛盾——**建议本草稿即冻结四表命名**（`attribution_block_text` / `attribution_block_seen` / `attribution_message_snap` / `attribution_archive_watermark`），并同步立项 §4 命名锚点。
- **C2 tool role content 结构**：OpenAI 协议 tool/assistant content 可能是**数组（content blocks）**而非纯 string。`content_json` 存原文 JSON 没问题，但 cap/chars 计数要对"展开文本"定义口径，否则 cap 失效。
- **C3 行号锚点防漂移**：实测 runner 980/1083（草稿 ~971/1073）、pipeline.process 1195/1270（anthropic 一处 ~1189）。§9 锚点表建议改为"符号 + 相对位置注释"，行号仅作当日参考。
- **C4 schema 无条件建表 vs 运行时零访问**：4 张新表走 `IF NOT EXISTS` 每次启动即建（先例 attribution_events 一致）。"无 config → 模块不 import"的承诺应明确为**运行时零访问**（表存在但空），避免误读为"表不建"。

## 7. 建议落点表

| 项 | 草稿位置 | 改法 |
|---|---|---|
| B1 来源枚举 + 验收③硬比对 | §0/§3、§8 验收 3 | 加"可见正文来源→接缝"表；golden 比对含 system/init 内容 |
| B2 互斥断言收窄+豁免分类 | §7 测试 7 | 收窄到本回合非 tool 新消息；违规分类输出 |
| B3 turn_seq 来源 | §4、§7 测试 8 | 定义取值来源（与 extractor 共用推导） |
| B4 compaction + 窗口诚实 | §4、§5 | 水位归零语义；窗口改分侧诚实描述，compaction 语义交接 S5 |
| B5 schema 自洽 | §3/§5/§6 | 去重键定一、删跨档去重句、序承诺改每档内有序、source 取值定死 |
| C1 命名冻结 | §0 | 本草稿冻结四表名 + 同步立项 §4 |
| C2/C3/C4 | §4/§9/§7-9 | 随正式 spec 消化 |

## 8. 结论

无阻塞项。B1/B2/B4 是**正确性/防红**性质（漏 system 源、断言误红、窗口高估），B3/B5 是**契约自洽**性质。按上表收紧后即可转正式 40 spec，仍走"小 spec + 单测 + 真实冒烟"门槛；量级采样已把 cap/去重/留存数字的基础做实，正式 spec 不必重采。
