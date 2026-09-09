# S3 Spec — 决策单元抽取器（decision-unit extractor）

> 隶属：[00-master-spec.md](./00-master-spec.md) 的切片 S3。
> 本 spec 只覆盖一件事：**在两条 handler 的注入前接缝上，把消息流里"实际发生的决策"
> 按纯函数规则切成决策单元，写 `attribution_events`（事件类型 `decision_unit.created`）**。
> 依赖：S1（事件表 + repo，10-event-table.md）。**不**依赖 S0/S2 的代码与注入块：
> 捕获规则与 S2 完全独立。唯一例外（2026-09-08 brainstorm 收编 A2）是 restraint
> 密封时**可选读取同表 S2 已产出的 `injection.hook.done` 行**做可见资产快照
> （§4.9）——S2 未开 = 空快照，零影响。
> 实现仓库分支：`feature/attribution-event-capture`（当前 head `8b0b8f5` = S2 F1–F3 修复 + S3 实现完成态）。
> 2026-09-08 实现落点核对：本文件 §4.2/§4.4/§5.1 已在实现完成后回填三处口径（restraint
> 密封边界的 +1 过滤、pending restraint 的"隐式"实现、`deriveDecisionUnits` 的
> `minIndex` 参数），见对应小节标注。
> 2026-09-08 二轮评审收编：命令面门控 + 解码串匹配（N1/N2）、链撕裂不产 restraint
> （N3）、超 16k 钳制保留每次 edit 身份（F2）——见 §4.4 与 §4.7 对应标注，§6 补 16/17。
> 2026-09-08 深挖收编（vocab 正则级命中表）：curl_pipe_sh 词法不认 curl 选项形态 → 全漏记
> （最危险的 curl|sh 形态既不产 key、B3 链扫也失明），已修为选项容错（§6 16(v)）。
> 2026-09-08 拍板①/②落地：git.merge 排除 `merge-*` plumbing（merge-base/merge-file/
> merge-tree/merge-index 等只读诊断/文本合并，非"并入当前线"）；rm 危险形态扩展为"同一
> 命令段内 recursive+force 双旗标并存"的 JS 判定（`rm -r -f`/`--recursive --force` 补中，
> `rm -f x`/`rm -r x` 单旗标与 `rm -r a && rm -f b` 跨段不命中）—— 均见 §4.4 末注与
> §6 用例 18。命令面内 echo/heredoc 写文件文本仍按命令串命中 = v1 词法残余边界
> （§4.4 末注），结构性解析留 v2。
> 本文件回答 00-master-spec §8 的 S3 开放问题 ①②（③为 S0/S2 已决项，不在此列）。

## 1. 目标

一句话验收（00-master §1 引用）：**脚本化小任务在事件表产生带 `tool_use.id` 的决策单元**。

更具体地说，在一次真实 CodeBuddy（OpenAI 协议）请求流上，消息历史里出现过的
"实际发生的决策"会被切成三类单元（报告 §3.2.1① 表）：

| 单元类型 | 捕获对象 | 证据 |
|---|---|---|
| `code_change` | 编辑类工具入参原文（Edit 的 old/new、Write 的 content） | 硬（`tool_param`） |
| `key_tool_call` | 关键工具调用（`git push`、`git commit -s`、跑测试等） | 硬（`tool_param`，执行确认靠配对） |
| `restraint` | 克制型行为决策：有 risky 机会但被克制（没做 / 先追问确认） | 软（`rationale_text` + 结构证据） |

## 2. 非目标（明确不做）

- 不做任何事件消费（v2 S5 归因 worker / S7 回执才读）。本切片只负责"捕获即存"。
- **不设抽取侧 top-N 截断**：捕获行是本地 SQLite append-only，成本近零；宁滥勿缺
  是报告第 1 条硬规则，漏抽 = 永久丢失归因机会。报告里的 top-N（如 30）是**送裁判
  的每轮上限**，属 v2 S5 消费侧（按事件查询时排序取前 N，溢出在回执标注"另有 N 个
  次要决策未逐一归因"）。把截断放在捕获侧会让数据一出生就不完整，与宁滥勿缺直接
  冲突 —— 此为 v1 的明确决策（见 §9 开放问题 1）。
- 不做 risky 词表的零维护来源（instruction L1 落库切词提取、记来源 asset_id、被
  corrected 时撤销）：报告说那是"提取绑定入库时机"的活，v1 用**内置种子词表常量**，
  提取绑定留 v2（见 §9 开放问题 2）。
- 不消费注入块 / 不做**行级** asset 维度：S3 的决策单元行不带 `asset_id`（asset→decision
  行级关联是 v2 S5 消费端拿"注入可见切片"与本表决策单元配对的事，本切片不预做）。
  例外（A2，§4.9）：restraint 密封时把锚点轮的可见资产 id 集合快照进 **payload**
  `visibleAssets` —— 这只读同表 S2 已落行、不摊行、不改行级 asset 列，见 §4.9。
- 不做"跨文件其实同一重构"的语义层合并：只认两条结构硬规则，拿不准宁碎勿并。
- 不追"上游最后一条 assistant 且此后无请求"的场景：该 turn 的单元等到下一请求
  才落库，会话终止即丢失 —— 与报告"增量切片 + 不等待任务结束"同源的边界，接受。

## 3. 已精读的源码锚点（结论，head `cdfca0c`，改前不必再读整文件）

| 文件 | 现状要点（S3 落点） |
|---|---|
| `src/anthropicHandler.ts` | `messages` 取自 `body.messages`（L618）；`requestKind`（main/fork/sidequery）L568 已定；session-init L732–969（**注意：`initResult.messages` 可能改写 `messages`，L932**）；`_resetFlowResult` 确认 return L971–1000；mem-command intercept L1002–1141（命中 return ~L1140）；注入 L1143–1191（pipeline 返回后**重写 `messages`**，L1184）。**S3 接缝 = session-init if 块结束后（L970 附近）、L971 之前**（见 §5.2） |
| `src/handler.ts`（OpenAI / 真实 CodeBuddy 路径） | 对称结构：`isAuxiliary` L702、`_dshHeadless` L721、session-init L814–1071、`_resetFlowResult` 确认 return L1073–1096、mem intercept L1098–1221（命中 return ~L1219）、注入 ~L1234–1266（pipeline 返回后**重写 `messages`**，L1263）。**S3 接缝 = session-init if 块结束后（L1072 附近）、L1073 之前** |
| `src/common/cc-request-classifier.ts` | `CcRequestKind = "main" \| "fork" \| "sidequery"`。codebuddy adapter `classifyRequest` 恒 `"main"`；claude-code 走 `classifyCcRequest` |
| `src/turnSeq.ts` | `countHumanTurns(messages, protocol)`：只计含非 `<system-reminder>` 文本的 user 消息。`isHumanUserContent` 目前私有 —— S3 需要按消息前缀复用同一语义 |
| `src/db/schema.ts` | `attribution_events` 落库点 + `idx_ae_unit_dedupe (session_key, turn_seq, msg_seq) WHERE msg_seq IS NOT NULL`（S1，不新增表）。`msg_seq` 注释"决策单元首条消息下标"由本 spec 拍板语义（§4.5） |
| `src/db/attributionEventRepo.ts` | `appendMany`（事务、冲突行静默跳过）+ Null 降级。S3 每请求一轮多单元一次 `appendMany` 落库 |
| `src/types.ts` | `InjectionConfig`（L576–630，`attributionEvents?` L627–629）已有 S2 字段；`RawYamlConfig.injection?`（L829–840，`attributionEvents?` L837–839）。S3 config 在此追加（§5.3） |
| `src/config.ts` | DEFAULT injection（assetReflection L82 / attributionEvents L84，段 L77–85）+ 归一化（attributionEvents L400–405）：S2 的"只接受 boolean、缺省走 default"姿势照抄（§5.3） |
| 命名契约（00-master §3） | 决策抽取统一叫 decision-unit extractor / `decision-unit-` 前缀；worker 一律 attribution- 前缀 —— S3 模块与类名照此规避 |

### 3.1 两条 handler 必须都接，不能只接 Anthropic

master-spec §5 锚点只写了 `anthropicHandler.ts`，但真实 CodeBuddy 流量走 **OpenAI
协议命中 `handler.ts`**（S2 冒烟即实证），Claude Code 才走 `anthropicHandler.ts`。
master-spec §6 要求 S3 冒烟脚本用小任务走真实路径 —— 因此 **S3 抽取器是双协议模块
（同一份纯函数，两个归一化入口）**，两条 handler 在同一对称位置各插一段同样的
守卫调用（§5.2）。OpenAI/Anthropic 只差消息形状归一化与请求守卫变量，业务规则零差异。

## 4. 核心决策（回应 master-spec §8 开放问题 ① ②，外加 msg_seq/幂等）

### 4.1 接缝时机与守卫（回答开放问题 ①）

**结论：session-init 完成后、`_resetFlowResult` / mem-command intercept 的任何
return **之前**、injection 重写 messages **之前**。** 守卫：

- anthropic：`requestKind === "main" && conversationId`（fork/sidequery 是 CC
  后台维护请求，与 L0/skill 同一口径地不视为真对话轮；跳过它们不漏任何东西 ——
  期间追加的消息由下一次 MAIN 的尾部重放覆盖）；
- openai：`!isAuxiliary && !_dshHeadless && conversationId`（与 skill/L0 写侧同一套
  "真对话轮"守卫，codebuddy 恒 main 因而等效"所有有会话的普通请求"）；
- 两者都必须 `config.injection?.decisionUnitExtractor?.enabled === true`，且 runner
  内部**再次自检开关**（防调用点写漏导致默认开启）。

为什么放在 intercept return **之前**而不是之后：

- 拦截请求（mem 命令 / session-reset form 确认）**不产生新决策**，但本请求窗口里
  可能恰好躺着"上一个工具循环的 `tool_result` 刚随本请求到达"的未落库配对（跨请求
  配对与拦截无关，master-spec §8 原话）。放在 return 之前让这类请求也跑抽取，
  不依赖"拦截后再来一个 MAIN"补抽；
- 拦截请求零上游成本，多一次纯函数扫描（不转发、不注入）可忽略；
- 放在 session-init 之后是为了复用其已定型的会话信号（`conversationId`/
  `injectedSkipped`/sessionKey 均已稳定）。session-init 偶发改写 `messages`
  （anthropic L932 `initResult.messages`，仅 form/初始化弹层场景）发生在抽取**之前**，
  属该请求实际对话流的一部分，不违反约束；抽取必须躲开的唯一改写是 **injection
  的资产块追加**（anthropic L1184 / handler.ts L1263，位于更后面）。

时序不变量：**抽取永远消费注入前的原始 `messages`**。若把抽取挪到注入后，注入改写
会污染锚点（消息数、内容都变），破坏 msg_seq 稳定与 tool_result 配对。此条写死。

### 4.2 游标与幂等（回答开放问题 ②）

**结论：不新增 cursor 表**。采用"进程内水位线 + DB partial unique index 兜底重放"：

- **进程内水位线**：runner 为每个 `sessionKey` 记 `watermark = 已处理的消息条数`
  （`messages.length`）。每请求只重放 `messages[max(0, watermark-1) .. ]` 的尾部
  （回看 1 条，见下），推导出**已密封单元**后 `appendMany` 落库，再把水位线推进到
  当前 `messages.length`。这正是报告原文"记一个'已见消息下标'，每来一轮把新消息
  相对下标多出的那部分切片、切完推进下标"，但**挂在进程内而非落盘**；
- **DB 唯一索引兜底**：进程重启水位线清零 → 下一请求全窗口重放 → 已落库单元由
  `idx_ae_unit_dedupe` 静默跳过、未落库单元照常补落（"进程重启也不丢，下一请求即可
  重建"，报告原话）。`appendMany` 已是事务 + 冲突行单行跳过（S1），不会因重放把
  整批回滚；
- **compaction 收缩**：若窗口 `messages.length < watermark`（客户端把历史重写/截短），
  水位线清零、全窗口重放。此时历史消息的 turn 计数可能漂移（Langfuse 同源已知漂移，
  turnSeq.ts 头注），极个别旧单元会以新 key 重落 → 靠 **`unit_id` 内容哈希**（§4.6）
  让消费端可按单元去重；DB 侧多几行同 unit_id 的行是已知可接受毛刺，不污染（见
  §9 开放问题 3）。

为什么回看 1 条：严格协议要求消息角色交替，工具循环里 `tool_use` 在 assistant
消息（下标 i）、它的 `tool_result` 在**下一个请求**的 user/tool 消息（下标 i+1）。
assistant 首次出现在请求尾时（恰是窗口最后一条），配对物还没到，单元**未密封**
→ 不落库；下一请求的水位线从 `i` 回看，配对上后补落。code 单元的 file-run 同理：
run 悬在窗口末尾也视为未密封，等后续消息把它闭合，下请求经回看一并闭合补落。
回看 1 条即覆盖所有跨请求配对；克制型单元另靠"pending 候选 + 密封后才落"（§4.4），
不依赖窗口长度。restraint 的幂等边界与 code/key 不同：其闭合消息可能恰好是上一轮
窗口的末条（那轮已落库），故 runner 过滤条件不是 `>= minIndex` 而是
`closureIndex >= minIndex + 1`（闭合必须本轮新到达），见 §4.4 末注。

### 4.3 合并规则（纯函数内部，报告规则 2 的落地）

对归一化后的消息序列，编辑器类工具（`Edit` / `Write` / `MultiEdit` / `NotebookEdit`
等，`vocab.ts` 常量 `EDIT_TOOL_NAMES`）的连续使用按两条硬规则合并：

1. **同文件**：连续的文件改动落在同一 `file_path`；
2. **连续**：同一条 assistant message 内 **没有非文件工具中断**（text block 不算
   中断，且**紧邻前置 text 就是该单元的理由陈述**，随单元留存）；或横跨相邻
   assistant message 且**中间没有任何 user/tool 消息**（协议上 Anthropic 严格交替
   使此情形几乎不可能出现，OpenAI 相邻纯 assistant 亦罕见 —— 实现为同一段
   "canonical 序列"合并逻辑的自然结果，单测用合成消息覆盖）。

满足则捏成一个 `code_change` 单元，否则各自成单元。不同文件、或被非文件工具
（Bash/Read 等）隔开的同文件改动，一律不并（宁碎勿并，防把两个意图捏一起污染
归因）。合并单元的证据保留**每次改动的 `tool_use.id` + 工具名 + 参数节选**，
不丢任何一次 `tool_use` 的身份（冒烟断言即查这些 id）。

### 4.4 三类单元 + 触发与密封条件

每个单元只有**密封（sealed）后**才落库；密封 = 该单元的证据在当次请求窗口内已
完整、且不会再被后续消息改变。密封条件按类型：

| 单元 | 锚点消息 | 密封条件 | 触发/捕获 |
|---|---|---|---|
| `code_change` | 改动所在的 assistant 消息 | file-run **已不可能再被扩展**：run 末尾之后已出现消息、且该消息不是同文件相邻 assistant 的延续（run 若悬在窗口末尾 = 未密封，等下一请求闭合） | 合并规则（§4.3）命中，证据 = tool_param |
| `key_tool_call` | 发起调用的 assistant 消息 | 该 `tool_use` 的配对结果已出现在窗口内（按 `tool_use.id` 配对，**只看 id 不看语义**，报告原文） | 工具名 / 命令文本命中 `KEY_TOOL_MATCHERS`（git push/commit/merge、deploy 动词、测试命令正则，v1 内置常量） |
| `restraint` | 触发 risky 机会的**人类 user 消息** | 该候选消息之后已出现**下一条人类消息**（响应链关闭）；且响应链非空 | 候选消息文本命中 risky 触发面（§4.4，两源并集）；且其后的响应链（到下一条人类消息为止）**没有**任何 risky 工具成功执行（B3 用同轮密封结果机械校验，见 §4.4） |

restraint 判定细节（报告规则 3 落地；2026-09-08 brainstorm 收编 B1/B3）：

- **risky 触发面 = 两源并集**（命中做宽，噪声单向 —— 过宽只是多送裁判几次"无归因"，
  见报告 §3.2.1-3）：
  1. **口语种子**：`RISKY_HUMAN_SEEDS`（push/publish/delete/deploy/force/drop/release/
     merge/rebase/overwrite 等动词，v1 常量）。词表提取绑定 instruction L1 入库 = v2。
  2. **命令形命中 risky matcher（B1，2026-09-08 收编）**：人类消息文本直接命中
     `KEY_TOOL_MATCHERS` 里 **`risky: true` 的那部分 matcher**（`git push` /
     `git commit --amend` / `rm -rf` / `git reset --hard` / 危险 deploy / drop 等，
     v1 常量内把 risky 与非 risky 分开标注，见 §5.1）也视为一次 risky 机会。这解决
     真实 CodeBuddy/CC 流量里种子词表盖不住的命令形机会：种子是**动词白名单**
     （push/delete/deploy…），而不少危险操作的字面量不含任何种子词（`rm -rf`、
     `git reset --hard`、`curl … | sh`），只有命令 matcher 能认出它们是破坏性操作。
     命中来源记入 payload 的 `matchedCommands`，与种子命中**互不排斥、可叠加**
     （如 `git push -f` 同时命中种子 push 与 matcher，两数组各记；为幂等稳定，
     单元 essence 只取排序去重后的 label 并集）。实现上复用同一张 matcher 表的
     risky 子集（`RISKY_KEY_TOOL_MATCHERS`），不另立人类口语词表；
     `git commit -s` / 跑测试这类 `risky: false` matcher **不当** restraint 触发面
     （那是 key_tool_call 的捕获面，不是克制机会面）。
- **响应链 = (候选消息, 下一条人类消息) 之间的全部消息**。链内任意 risky 工具执行
  （含其配对结果确认成功）→ 克制**未发生** → 不产 restraint（那次执行本身会作为
  `key_tool_call` 落库）。
- **B3 同轮机械一致性（2026-09-08 收编）**：restraint 的"链内无 risky 成功执行"检查
  不与 key_tool_call 的推导各自为政 —— 两者共享同一轮 `deriveDecisionUnits` 的中间
  结果：runner 在同一轮推导里先算出链内密封的 risky `key_tool_call`（带各自
  `resultStatus`），把明细列表传给 `classifyRestraint`；restraint 密封条件里"链内
  risky 执行未发生"直接以"该列表里不存在 `resultStatus="success"` 的条目"为准，
  而不是再对链重扫一遍。好处：跨单元一致性由数据流保证（同一份 tool_use.id 配对
  结论），杜绝"restraint 说没执行、key_tool_call 说执行了"的同一链双重结论。
  实现 = `classifyRestraint` 增加入参
  `sealedRiskyKeyToolCalls: Array<{ toolUseId: string; resultStatus: "success"|"error"|"unknown" }>`
  （本轮已密封的 risky tool 明细），函数内部只看 `resultStatus==="success"` 的条目，
  存在即不产 restraint（`error`/`unknown` 不算"已执行成功"，克制仍成立，见 §6 7b(iii)）。
  **语义零变化**：原来"链内扫出 risky 执行"会被密封逻辑先一步拒掉 —— 若执行已发生，
  其 tool_use.id 必已配对密封成 key_tool_call，两法结论一致；B3 只是把同结论收拢到
  一处，避免两条代码路径各自扫一遍而漂移。
- **命令面门控 + 解码串匹配（2026-09-08 二轮评审 N1/N2 收编）**：key_tool_call 候选
  与 B3 的"链内已执行"扫描只开在**命令面**上 —— 工具名属于执行类工具
  （Bash/Shell/Terminal/…，`COMMAND_TOOL_NAMES` 常量）**或**入参含命令承载字段
  （`command`/`cmd`/…，`COMMAND_ARG_KEYS` 常量）。文件工具（Edit/Write/Read…）的
  入参内容/读面整段不进命令面：文档里写一句 `git push origin main` 不是"push 已
  执行"（N1），也不会反向抑制同链 restraint。匹配与证据一律取**解码后的命令串**
  （入参对象的字符串值，真换行），绝不在 `JSON.stringify` 转义串上做 `\b` 正则：
  转义串把换行写成字面 `"\n"`（`n` 是词字符），行首命令的词边界失效会整段漏记
  （N2）。实现 = `vocab.commandSurfaceTextOf`；key payload 的 `toolParamText`/`chars`
  同取解码串。
  **词法精度与残余边界（2026-09-08 深挖 + 拍板①/② 落地）**：
  - 已收紧（拍板①）：`git.merge` 词法 = `\bgit\s+merge\b(?!-)` —— 排除 `merge-base` /
    `merge-file` / `merge-tree` / `merge-index` 等 `merge-*` plumbing（只读诊断/文本合并，
    不是"并入当前线"的危险合并）；普通 `git merge` 与 `--no-ff` / `-X theirs` / 旗标换行
    后续不受影响。label 与数组优先级序不变。
  - 已扩展（拍板②）：`shell.rm_rf` 从"单 token 内双字母"改为 JS 判定 = **同一命令段内**
    recursive 与 force 旗标并存才命中（段 = 以 `;` / `&&` / `||` / `|` / 换行 切分）。
    `rm -rf` 回归命中；`rm -r -f`、`rm --recursive --force` 补中；`rm -f x` / `rm -r x`
    单旗标、`rm -r a && rm -f b` 跨段均不命中（两条精度约束）。
  - 剩余残余（v1 明示）：命令面内 Bash 用 echo/printf/heredoc 把 `drop table`/`rm -rf`
    等字面量写进文件时，纯正则无法与"真执行"区分，方向 = 只在命令面内偏多记（不再有
    Edit/Write 整内容误判）；结构性解析（理解 shell 语义 / git 子命令表）留 v2
    （§9 开放问题 2）。
- **链撕裂（torn）宁缺不伪造（2026-09-08 二轮评审 N3 收编）**：B3 链扫时若链内出现
  risky 命令工具但其配对结果缺失/未达（撕裂窗口/丢结果），则"是否真执行"未知 ——
  本轮**不产 restraint**，结果补上后由 key_tool_call 记录真实执行（与 key 侧"无配对
  不落"同一口径，防"伪克制"与真实执行并存的双结论）。
- **未关闭不落（pending 语义）**：候选是窗口最后消息、或其响应链尚未被下一条人类
  消息关闭 → 本轮不产。后续请求带新窗口时，该候选仍在窗口内（水位线只回看 1 条，
  候选在窗口深处也一样被全窗口推导重评估），一旦闭合即补落。**实现选择 = 不设显式
  pending 表**（spec 早期设想的"进程内 pending 注册表"被推翻）：extractor 纯函数每次
  全窗口推导、未闭合候选自然不产；runner 只维护水位线 Map。pending 语义由
  "候选未闭合不产 + 后续轮全窗口重推导"隐式等价实现，进程重启后水位线清零 + 全窗口
  重放自然重建，无任何需落盘的 pending 状态。
- 守卫"响应链非空"防把"用户刚说完 risky 请求、agent 还没回话"就落成克制。
- **跨窗口幂等边界（2026-09-08 实现落点核对，§4.2 末注的落地）**：restraint 的密封
  边界 = 链闭合的人类消息下标。runner 过滤传 `minIndex = watermark - 1` 时，restraint
  判定条件是 `closureIndex ≥ minIndex + 1`（闭合必须本轮新到达才落库）。若按 code/key
  的 `sealMessageIndex ≥ minIndex` 处理，上一轮窗口末条恰好是闭合点时，后续每一轮回看
  都会把已落库的 restraint 当"新密封"重复落。code/key 天然无此问题：run/tool 悬在
  窗口末尾 = 未密封，其闭合消息必然晚于上一轮末条出现，只密封一次。

**静默 vs 诚实**：抽取器永远不 throw、不因推导异常中断请求；但"同一消息单元数
超过 `DECISION_SLOTS_PER_MESSAGE`（16）被钳制"这类**稀有异常**用 `console.warn`
显式暴露，不做静默丢弃（见 §4.5 钳制说明）。

### 4.5 msg_seq 精确语义与编码（回应 10-event-table §9.1、schema 注释）

`idx_ae_unit_dedupe` 唯一键是 `(session_key, turn_seq, msg_seq)`，而一条 assistant
消息可产出多个单元（报告示例：Edit main.go + Write utils.go 同消息成两个单元），
所以 **msg_seq 不能是裸消息下标**。定义：

```
msg_seq = anchorMessageIndex × DECISION_SLOTS_PER_MESSAGE + unitSlot
DECISION_SLOTS_PER_MESSAGE = 16        // 单条消息可锚定的单元数上限（现实中远小于）
```

- `anchorMessageIndex`：单元锚点消息在**原始 `messages` 数组**里的 0 基下标
  （assistant 消息 → code/key 单元；人类 user 消息 → restraint 单元）。
- `unitSlot`：同一锚点消息内单元的确定性序号 —— 推导顺序固定（code_change 按
  file-run 出现顺序，随后 key_tool_call 按 tool_use 出现顺序），同窗口重放必得
  同一 slot，保证幂等键稳定。restraint 锚在人类消息上，天然不与 assistant 锚冲突，
  slot 恒 0。
- 消息内单元超过 16（病态长回答）：按固定顺序保前 16、第 16 个 payload 置
  `overflowed: true` 并 `console.warn`（诚实钳制，见 §9 开放问题 4）。正常 CC/CB
  会话单条 assistant 消息的实际决策单元数远小于 16，此分支为纯防御。
- 该编码保留了"首条消息下标"的可读性（`floor(msg_seq/16)` 即锚点下标），但注释
  需随之更新：`schema.ts` 的 `msg_seq` 列注释从"决策单元首条消息下标（S3 幂等用）"
  改为"决策单元锚点消息下标×16 + 消息内单元序号（S3 幂等键）"（纯注释改动，
  `IF NOT EXISTS` 下对新库生效、对已建库无影响）。

`turn_seq`（行级）：锚点消息**所在的人类轮次** = `countHumanTurns(messages.slice(0, anchorIndex+1), protocol)`
（对 restraint 锚点人类消息即含其自身）。与 langfuse/observer 的 turnSeq 同一口径
来源（turnSeq.ts），一条单元所在轮次在整条工具循环中稳定。

### 4.6 unit_id：确定性内容哈希（不是随机 uuid）

`unit_id = "du_" + sha1(canonical essence).slice(0,12)`，essence 是**不含会话身份、
不含下标**的协议归一化单元内容（文件路径、工具名、tool_use.id、参数文本节选、
restraint 种子命中 + 命令命中 label 等）。作用：

1. 进程重启重放、compaction 重放时，同一条消息推导出的同单元必得同 `unit_id`
   —— 即使 `(turn_seq, msg_seq)` 因历史截断漂移而换了 key，消费端仍可按 `unit_id`
   合并（`idx_ae_unit` 非唯一索引 + 冒烟/调试查询用）；
2. v2 S5 worker / S7 回执的 `decision_ref.unit_id` 用同一值即可跨事件定位，不再需要
   "du_017" 式编序。

### 4.7 单元 payload（`payload_json`，v1 契约 = 自足证据，非指针）

所有 `payload_json` 是**自足的最小摘要**（不引用外部存储；S5 消费时直接可用，
与 10-event-table §4"payload 保留整块摘要"一致）。公共字段 + 类型专属：

```ts
{
  version: 1,
  unitType: "code_change" | "key_tool_call" | "restraint",
  unitId: string,                 // §4.6
  protocol: "anthropic" | "openai",
  anchorMessageIndex: number,     // 原始 messages[] 下标（与 msg_seq 同源）
  turnSeq: number,                // 行级 turn_seq 的冗余（payload 自足）
  overflowed?: boolean,           // §4.5 钳制标记：该单元是同一锚点被保住的最后一个、
                                  //   同锚点还有因超 16 上限被丢弃的单元时为 true

  // code_change:
  filePath: string,
  rationaleText?: string,         // 单元内首个 file-run 前最近的 assistant 文本（截断）
  edits: Array<{
    toolUseId: string; toolName: string;
    paramKey: string;             // old_string / new_string / content …
    text: string;                 // 截断节选
    chars: number;                // 原文长度（截断痕迹，诚实标注）
  }>,

  // key_tool_call:
  toolUseId: string; toolName: string;
  toolParamText: string;          // 命令/入参节选
  chars: number;
  matchedBy: string;              // 命中的 matcher label（确定性可审计）
  resultStatus: "success" | "error" | "unknown",   // 只按配对的 is_error/粗字段判，不看语义
  resultSnippet?: string,         // 截断

  // restraint:
  matchedSeeds: string[],         // 命中的口语种子
  matchedCommands: string[],      // B1：命中的 RISKY_KEY_TOOL_MATCHERS label（人类消息含
                                  //   命令字面量；risky:false matcher 不进此面）
  visibleAssets?: Array<{         // A2（§4.9）：密封时刻该锚点轮"注入可见切片"的真实资产
    assetId: string;              //   快照（去重）；S2 未开 / 无注入行 → 字段省略
    assetType: string;
  }>,
  riskyCandidateText: string,     // 截断的人类 risky 请求原文
  responseEvidence: {
    rationaleText?: string,       // 链内 assistant 文本节选
    clarifyingQuestion: boolean,  // 追问（先经用户确认）
    safeAlternativeTools: string[],
    riskyExecuted: false,         // 恒 false —— 为真时此单元不成立
  },
}
```

文本节选上限常量（`types.ts`）：单段 4000 字符、单元内多段合计 ≤ 16000 字符；
超限截断并保留 `chars` 记原文长度（诚实标注截断，同 S2 不丢证据语义的纪律）。
合计超预算只截断 `text` 内容预算，**每次 edit 的 `tool_use.id`/工具名/`paramKey`
不因超预算丢弃**（F2，2026-09-08 收编：超预算条目 `text=""` + `chars`=原文长度，
保身份痕迹，见 §6 用例 17）。2026-09-08 复核：run 内 edit 数量超出预算容量时同样
全量保留（6 edit × 4k 用例下第 5/6 条以 `text=""` + `chars`=4000 入列）——
"不丢任何一次 edit 的 `tool_use.id`"在 >预算场景成立并有测试背书。

行级映射（`NewAttributionEvent`）：`eventType="decision_unit.created"`、`msgSeq`/
`turnSeq`/`unitId` 如上，`assetId/assetType` **恒缺省**（v1 不挂资产，理由见 §2），
`spaceId` 缺省 `_default`。一个单元 = 一行（无摊行需求）。

### 4.8 事件词汇表与"谁写哪一行"

- 生产者为抽取 runner（每请求 ≤ 1 次 `appendMany`，N 个新密封单元一次落库）；
- S3 **不写** `injection.*` 生命周期事件（那是 S2 的活，互不重叠）；
- 事件词汇表维持 00-master §3 不变：本切片只新增 `decision_unit.created` 的写入方。

### 4.9 决策单元 ↔ 真实资产的关联契约（A1/A2，2026-09-08 brainstorm 收编）

本切片仍**不做归因判定**（那是 v2 S5 的活），但要在数据层把
"asset → decision" 的最小 join 路径立起来，且**复用 S2 已落库的行、不新增存储、
不读注入块内容**。两条原则：

- **A1（零捕获侧改动，join 契约）**：S2 的 `injection.hook.done` 行已带
  `(session_key, turn_seq, asset_id, asset_type)`；S3 的决策单元行同表同键
  `(session_key, turn_seq)`。因此 **asset→decision 的关联 = 同表一次 join**，
  不需要 v2 之前造任何新结构。v1 只把它写成文档契约 + 冒烟断言（§7 冒烟 5）：
  ```
  SELECT d.payload_json AS decision, a.asset_id, a.asset_type
  FROM attribution_events a
  JOIN attribution_events d
    ON d.session_key = a.session_key
   AND d.turn_seq     = a.turn_seq
  WHERE a.event_type = 'injection.hook.done' AND a.asset_id IS NOT NULL
    AND d.event_type = 'decision_unit.created'
  ```
  判定语义仍留 v2 S5（同一 `(session, turn)` 可见切片里哪条资产真影响了该决策）；
  捕获侧对"真实 asset 切合"的全部义务是**保证 turn_seq 口径与 S2 同源**（§4.5，
  两者都来自 turnSeq.ts）——这条已由设计满足，不改代码。

- **A2（restraint 密封时快照可见切片进 payload）**：restraint 是"因约束而没做"的
  单元，它要归因的那条 instruction 资产**恰恰就在触发轮次的注入可见切片里**。
  与其等 v2 S5 再来查，restraint 密封时（该轮次的注入**必然已完成**，见下）顺手把
  该锚点轮可见切片的 `(asset_id, asset_type)` 清单快照进 payload `visibleAssets`。
  这是对 A1 的"局部物化"：join 结果里最可能被消费的那一半，在捕获点就存档，
  决策行因此自足（会话历史清掉后仍可归因）。
  - **只做 restraint，不做全部单元**：code_change / key_tool_call 是"已发生的行为"，
    归因需要整链跨文件比对（CodeGraph 反解等），v1 全量物化会带出大量与单元无关的
    资产噪声；restraint 是"被约束的候选"、可见切片与其因果最近，物化噪声最小。
    这是本切片的有意裁剪（若 v2 要推广到全部单元，只需把同一 helper 挪到 runner
    通用密封点，见 §9 开放问题 6）。
  - **怎么读**：密封 restraint 时，runner 用现成 `getAttributionEventRepo().listBySession(
    sessionKey, { eventType: "injection.hook.done" })` 取该会话注入行，过滤
    `turn_seq === 锚点轮次` 的行，去重出 `{assetId, assetType}`；结果为空（S2 未开 /
    该轮无产资资产）→ **省略该字段**（不写空数组、不因无资产而放弃 restraint）。
    repo 已是 Null 降级、读失败静默 → runner 拿不到就省略，绝不 throw。
  - **时序保证（为什么密封时一定读得到）**：restraint 密封只发生在"候选消息之后又
    出现了下一条人类消息"的请求里。候选消息所在轮次 T 的注入，发生在**该轮请求
    处理时**（handler 接缝在注入前，抽取在接缝跑，注入在抽取之后完成 → 该轮
    `injection.hook.done` 在 T 轮请求内已落库）。restraint 的密封请求一定晚于 T 轮
    请求（至少要等 T 轮的 assistant 回复 + 下一条人类消息到达），故密封时刻 T 轮
    可见切片**必已在表中**。无竞态：唯一写入方按请求序串行落库。
  - **unit_id 不受影响**：visibleAssets 是快照增强、不进 essence（§4.6），同候选
    重放推导出的 unit_id 不变（幂等键只锚定"决策本身"，资产切片可随时间补充）。

## 5. 改动清单

### 5.1 新模块 `src/decision-units/`（命名：决策统一 `decision-unit-` 前缀，避 extraction/judge 撞车）

| 文件 | 内容 |
|---|---|
| `types.ts` | `DecisionUnitType`、`DecisionUnit` payload 接口、节选上限常量、`DECISION_SLOTS_PER_MESSAGE = 16` |
| `vocab.ts` | `EDIT_TOOL_NAMES`、`RISKY_HUMAN_SEEDS`、`KEY_TOOL_MATCHERS`（含测试命令正则）+ 命令面门控（`COMMAND_TOOL_NAMES`/`COMMAND_ARG_KEYS`/`commandSurfaceTextOf`，§4.4）。B1 增补：`KEY_TOOL_MATCHERS` 每条 matcher 带 `risky: boolean` 标注 + label + 可对任意文本执行的匹配器；导出 `RISKY_KEY_TOOL_MATCHERS`（risky 子集）供 restraint 对候选人类消息文本做命令形命中（复用同一 matcher，不另立人类口语词表）—— 全为常量，注释写明"v1 内置，词表动态提取 = v2" |
| `decision-unit-extractor.ts` | **纯函数核心**：协议归一化（anthropic content blocks / openai content string+tool_calls+role=tool → canonical 序列）+ `deriveDecisionUnits(messages, protocol, options?: { minIndex })`（只产密封单元；每次全窗口推导，`minIndex` 仅做密封边界过滤 —— `sealMessageIndex ≥ minIndex`，restraint 为 `closureIndex ≥ minIndex+1`，见 §4.4 末注）+ `computeUnitId` + 供单测的导出 helper（`mergeFileRuns`、`findPairedResult`、`classifyRestraint(candidate, chain, sealedRiskyKeyToolCalls)`…）。`classifyRestraint` 的"链内 risky 未执行"判定直接以入参 `sealedRiskyKeyToolCalls: Array<{toolUseId, resultStatus}>` 中是否存在 `resultStatus="success"` 条目为准（B3 同轮配对结论，不做二次扫描）。零 IO、零 session 状态 |
| `decision-unit-runner.ts` | 接缝调用入口 `runDecisionUnitExtraction({config, protocol, mainDialog, hasConversation, messages, sessionKey, spaceId?, userId?, agentSource})`：内部自检 config 开关 → 守卫（§4.1）→ **水位线 Map（进程内，按 sessionKey；不设显式 pending 表，见 §4.4）**，取 `minIndex = watermark - 1` 后把 `messages` 整个交给 extractor 全窗口推导（compaction：`messages.length < watermark` 时水位线清零、全窗口重放）→ 对密封 restraint 调 `loadVisibleAssets(sessionKey, turnSeq)`（§4.9 A2：repo `listBySession` + 按 turn 过滤，读不到就省略）→ `getAttributionEventRepo().appendMany(...)` → 推进水位线。导出 `__resetDecisionUnitStateForTests()`。**同步临界区**（better-sqlite3 同步写 + 模块内 Map，JS 单线程下无并发交错） |
| `__tests__/decision-unit-extractor.test.ts`、`__tests__/decision-unit-runner.test.ts` | §6 |

架构要点（写死，防返工）：
- **纯函数与状态严格分层**：extractor 无状态、输入 `(messages, protocol, options?)`
  输出单元；runner 只有水位线 Map 这一种跨请求状态（pending 语义由全窗口重推导
  隐式承担，§4.4），且全部状态都是"丢了可由全窗口重放重建"的缓存而非真值。
- runner 不 latch 任何跨请求会话态到单例字段之外（每个 sessionKey 独立条目，天然无
  S2 §3.1 那种全局缓存串台问题 —— 按 key 分桶不是共享可变字段）。

### 5.2 两条 handler 接缝（各插同一段守卫调用）

`anthropicHandler.ts`：在 session-init if 块（L732–969）闭合后（L970 空行处）、
`mem:session-reset` 确认段（L971 起）之前插入：

```ts
// ── S3 决策单元抽取（默认关闭：config 未开 = 与现状逐字节等价）──
// 位置：session-init 之后、intercept/reset 的 return 之前、injection（重写
// messages）之前。抽取必须消费注入前的原始 messages。
if (
  config.injection?.decisionUnitExtractor?.enabled &&
  requestKind === "main" && conversationId
) {
  const { runDecisionUnitExtraction } = await import("./decision-units/decision-unit-runner.js");
  runDecisionUnitExtraction({
    config, protocol: "anthropic",
    mainDialog: requestKind === "main", hasConversation: !!conversationId,
    messages: messages as unknown[], sessionKey,
    userId, spaceId, agentSource,
  });
}
```

`handler.ts`（OpenAI）：对称位置（session-init if 块 L814–1071 闭合后、L1072 空行处、
`mem:session-reset` 确认段 L1073 之前），守卫换
`!isAuxiliary && !_dshHeadless && conversationId`，`protocol: "openai"`。

默认关闭 ⇒ 该 if 恒假 ⇒ 动态 import 不执行 ⇒ **行为与现状逐字节等价**（回滚口径见 §8）。

### 5.3 配置开关 `src/types.ts` + `src/config.ts`（照 S2 姿势）

- `InjectionConfig`（types.ts InjectionConfig 接口）追加：
  ```ts
  /**
   * v1 S3 决策单元抽取器。默认关闭：未配 = 与现状逐字节等价（零回归）。
   * true → 在两条 handler 注入前接缝把消息流切决策单元，写本地 attribution_events
   * （event_type=decision_unit.created，带 tool_use.id / 合并 / 克制型单元）。
   * 见 docs/implementation/30-decision-unit-extractor.md。
   */
  decisionUnitExtractor?: { enabled: boolean };
  ```
  并在 `RawYamlConfig.injection?` 可选段追加同形状 `decisionUnitExtractor?: { enabled?: boolean }`。
- `config.ts`：DEFAULT `injection` 注入 `decisionUnitExtractor: { enabled: false }`；
  归一化照抄 `attributionEvents` 的"只接受 boolean、缺省走 default"。

### 5.4 `src/turnSeq.ts`（1 行，纯追加）

`isHumanUserContent` 加 `export`，供 decision-units 归一化层复用同一"人类消息"语义
（单点事实源；S3 与 turnSeq/Langfuse/mem-command 的轮次口径一致）。

### 5.5 `src/db/schema.ts`（注释级）

`msg_seq` 列注释更新为 §4.5 语义（纯注释，不动 DDL 结构，不动 `SCHEMA_VERSION`）。

## 6. 测试（单测，映射 master-spec §6 验收四件事）

新建 `src/decision-units/__tests__/` 两个文件；runner 测试用内存 fake repo
（仿 `appendMany` 冲突跳过语义：同 `(sessionKey, turnSeq, msgSeq)` 第二次调用不
落行）直测。

**decision-unit-extractor.test.ts（纯函数）**
1. **同 message 合并**：合成 anthropic assistant（text + 3×Edit `main.go` A/B/C +
   Write `utils.go`）→ 2 个 `code_change` 单元：`main.go` 合并（edits=3，按序保留
   3 个 tool_use.id、rationale 取自前置 text），`utils.go` 单独成单元；msg_seq =
   同锚点不同 slot，两两互异。
2. **宁碎勿并**：同消息不同文件 → 不合并；同文件被 Bash（非文件工具）隔开 → 不合并
   （两个单元）。
3. 跨消息合并退化形态：两条相邻 assistant（中间无 user/tool）同文件 → 合并、锚点
   取先消息（协议正常形态下几乎不出现，防回归）。
4. **tool_use↔tool_result 跨请求配对**：R1 窗口止于 assistant（含 `git commit -s`
   tool_use）→ `derive` 无 key_tool 单元（未密封）；R2 窗口补 user(tool_result) →
   出 `key_tool_call`，`toolUseId` 与配对结果一致；构造"id 相同但输入语义完全不搭"
   的畸形对验证**只看 id**。Anthropic（content blocks tool_result）与 OpenAI
   （role=tool + tool_call_id）两形态各一例。
5. code_change 密封时序：assistant（Edit）为窗口最后一条 → 不落；下一请求补任意
   后续消息 → 落（证据参数来自 assistant 自身，不依赖结果语义）。
6. **克制型触发（B1 两源）**：(i) 人类消息"请直接 git push，不用等我确认"（命中
   种子）+ 链内 assistant 理由"push 前必须先问，我先 commit 请你确认"（无 risky
   工具）+ 下一条人类消息闭合 → `restraint` 单元，`matchedSeeds` 命中、
   `riskyExecuted=false`、clarifying 判定正确；(ii) **纯命令形**：人类消息
   "把这个目录直接 `rm -rf` 掉就行"（含命令字面量但无种子动词）→ `matchedCommands`
   非空、`matchedSeeds` 为空（matcher 认出种子词表盖不住的破坏性命令）；(iii) 两源
   叠加："请直接 `git push -f origin main`" → `matchedSeeds` 与 `matchedCommands`
   各记其命、互不排斥。
7. 克制**不**触发：(a) 同场景但链内出现 `git push` tool_use + 配对结果 → 无
   restraint（该动作以 `key_tool_call` 出）；(b) 候选是窗口最后消息（响应链未关）
   → 无；(c) 人类消息既无种子命中、也无 `KEY_TOOL_MATCHERS` 命令命中 → 无（防
   "没删库"噪声）。
7b. **B3 机械一致性**：(i) 同一窗口先密封出链内 risky `key_tool_call`（resultStatus=
    "success"）→ `classifyRestraint(candidate, chain, [{toolUseId, resultStatus:"success"}])`
    → 返回无 restraint（同一链不产双重结论）；(ii) 同场景但 sealed 列表为空 / 只有
    非 risky 的 `git commit -s` 单元 → restraint 照常产出；(iii) 列表含该
    toolUseId 但 resultStatus="error"（或 "unknown"）→ 不算"已执行成功"，restraint
    可产出（B3 只认 `resultStatus="success"` 的密封执行，函数内部过滤，非 runner
    预判）。
8. `computeUnitId`：同单元两次推导同 id；跨 session 同内容同 id；不同文件不同 id；
   A2 的 `visibleAssets` 快照差异**不进** unit_id（同候选带不带快照 id 相同）。
9. 节选钳制：超限文本被截断且 `chars` 保留原文长度（诚实标注）。

**decision-unit-runner.test.ts（状态机）**
10. **游标推进幂等**：喂 R1 → 落 N 行；**原样重放 R1**（同 messages 再喂）→ 水位线
    不推进，`appendMany` 落 0 行；`__reset`（模拟进程重启）后重放 R1 → 推导同 N 个
    单元、fake repo 因冲突全部跳过 → 总行数不变（幂等断言）。
11. 增量 + 回看 1：R1 止于 assistant（未密封），R2 补 tool_result → 仅补落配对单元，
    msg_seq 锚点 = R1 尾部消息，不重落旧单元。
12. pending restraint：候选在 R1 未闭合 → 不落；R2 出现下一条人类消息 → 落一次；
    R3 再重放 R2 全量 → 冲突跳过（不重落）。
13. compaction 收缩：R1（len=12）后喂缩短窗口（len=5）→ 水位线清零、全窗口重放。
    两种 fixture 各断言一次：保留尾部**人类轮次编号不变**（截掉的只是工具循环
    消息）→ fake repo 按 `(turn, msg_seq)` 冲突跳过、零重复行增长；编号**漂移**时
    尾部单元以新 key 重落为**同 unit_id 的重复行**（§4.2 已知毛刺，消费端按
    `unit_id` 合并）—— 测试断言"重落行的 unit_id 与旧行一致"，不声称零增长。
14. 守卫：config 关 / `mainDialog=false` / `hasConversation=false` / 无 sessionKey
    → `appendMany` 一次都不调。
15. 行映射：密封单元 → `NewAttributionEvent` 的 eventType / unitId / turnSeq /
    msg_seq（编码校验：`anchor*16+slot`）；行级 assetId/assetType 恒缺省（A2 的
    visibleAssets 只进 payload，不摊成行、不落 asset 列）。
15b. **A2 可见切片快照**（fake repo 预置 `injection.hook.done` 行）：
    (i) 密封 restraint 时 runner 调 repo.listBySession({eventType:"injection.hook.done"})
    并过滤锚点轮 → payload.visibleAssets 与预置资产的 `(assetId,assetType)` 一致、
    去重；(ii) 快照**不改变** `msg_seq`/`unit_id`（纯 payload 附加）；(iii) 同批
    code_change/key_tool_call 单元 payload **不含** visibleAssets（只 restraint 有）。
15c. **A2 读失败/无资产降级**：repo 无该会话注入行 / 该轮无产资资产 → 密封 restraint
     照常落库且 payload 省略 visibleAssets；repo.listBySession 抛错（fake 模拟）→
     runner 不 throw、restraint 照落（降级，不因快照阻断捕获）。
16. 命令面回归（二轮评审 N1/N2/N3，映射 §4.4 追加口径）：
    (i) Write 文档含 `drop table users` → 无 `sql.drop` 的 key_tool_call（不伪造执行）；
    (ii) Write 文档含 `git push origin main` 字面量 → 无 key，且同场景 restraint 照常
    密封（写文档 ≠ push，restraint 不被文件内容抑制）；(iii) Bash 多行命令行首
    `git push` 在解码串上命中 `git.push` —— JSON 转义串上 `\b` 失效的回归护栏；
    (iv) 链内 risky Bash 工具无配对结果 + 链已闭合 → 无 key 亦无 restraint（撕裂）；
    (v) curl_pipe_sh 选项形态（深挖 FN 修复）：真实 curl 几乎总带选项（`-s`/`-fsSL`/
    `--retry`），原词法只认无选项 `curl <URL> | sh` → 全漏记；词法修为
    `curl\b[^\n]*?https?://…`，带选项/多行 pipe 均命中 shell.curl_pipe_sh。
17. 截断身份回归（二轮评审 F2 + 复核补覆盖，映射 §4.7 诚实节选）：code 文本合计超
    16k → payload `edits` 仍含每次 edit 的 `tool_use.id`；超预算条目 `text=""` +
    `chars`=原文长度（身份痕迹，不整段丢身份）。6(iii) 两源叠加与用例 9 节选钳制明文
    用例也随本项补进单测（原实现缺覆盖）。复核补齐"预算容量外"形态：6 edit × 4k →
    edits 全量 6 条 id 保留（预算在第 4 条耗尽，第 5/6 条 `text=""` 但 `chars`=4000）。
18. 词法精度（2026-09-08 拍板①/②，映射 §4.4 末注）：
    (i) `git merge-base` / `merge-file` / `merge-tree` / `merge-index` 等 `merge-*`
    plumbing 不命中 `git.merge`（只读诊断/文本合并非危险合并）；普通 `git merge` 与
    `--no-ff` / `-X theirs` / 旗标换行后续不受影响（单测正负各 2+）；
    (ii) `shell.rm_rf` = 同命令段内 recursive+force 双旗标并存：`rm -rf` 回归命中，
    `rm -r -f` 与 `rm --recursive --force` 补中；`rm -f x` / `rm -r x` 单旗标、
    `rm -r a && rm -f b`（跨 `&&` / `;` / `|`）不误报。命令面内 `echo 'rm -r -f'`
    外壳文本仍命中 —— v1 残余（§4.4 末注）。

## 7. 真实会话冒烟

复用 codebuddy-scratch/s0-smoke + s2-smoke 的编排姿势（源码实例 + 本机 docker 栈 +
真实 CodeBuddy 协议 `/codebuddy/default/v1/chat/completions`）。scratch 配置额外开
`injection.decisionUnitExtractor.enabled: true`，独立 `PROXY_DB_PATH`。

固定脚本化小任务（00-master §6 S3 冒烟内容）：**读文件 → Edit → 跑测试 → `git commit -s`**
（即 master-spec §6 的"读文件→Edit→跑测试→git commit -s"）。

1. 记录该会话 `session_key`；跑完任务后：
   `SELECT event_type, unit_type 相关 payload … FROM attribution_events WHERE session_key=? AND event_type='decision_unit.created'`；
2. 断言：
   - ≥ 1 行 `code_change`（payload.filePath = 编辑的文件、edits 含 Edit 的 `tool_use.id`）；
   - ≥ 1 行 `key_tool_call`（`toolUseId` 为该次 `git commit -s` / 测试命令的真实
     `tool_use.id`，`resultStatus` 由配对结果给出）—— **这即是"事件表产生带
     tool_use.id 的决策单元"的直接验收**；
   - 无 `injection.*` 生命周期行混入（S2 是另一份开关，本冒烟单开 S3 时不应出现，
     若同时开则按 event_type 过滤核对）；
3. 第二请求/第二轮后再查：行数增长、首轮已落行原样未改写（append-only）、
   `unit_id` 稳定；
4. 双协议覆盖分工说明（写入证据文档）：真实冒烟走 OpenAI（CodeBuddy 实际路径）；
   anthropic content-block 形态由 §6 纯函数测试 + 代码走读覆盖（本机跑 Claude Code
   CLI 进真实 CC 会话可作为加分项，不阻塞验收）。

**A1/A2 收编新增冒烟（与 S2 开关共存一轮，2026-09-08）**：同一轮 scratch 配置
`injection.attributionEvents.enabled: true` + `decisionUnitExtractor.enabled: true`，
跑同一脚本化小任务，补做：
5. **A1 join 契约实测**：对同一 session，把 §4.9 的 join 查询跑一遍 → 断言至少出现
   一条 `decision_unit.created` 行与某条带真实 `asset_id` 的 `injection.hook.done`
   行落在同一 `(session_key, turn_seq)` 上（注：`git commit -s` 这类 key_tool_call
   所在轮次必与注入轮同 turn —— 用该单元的 turn_seq 直接查可见切片即可，不要求
   本轮真有 restraint）。同时记录 join 行数写入证据文档（证明契约可执行、非空）。
6. **A2 快照核对（best-effort）**：若本轮自然出现 restraint 行 → 断言其 payload 的
   `visibleAssets` 非空，且其中每个 asset_id 都在同一 turn_seq 的 `injection.hook.done`
   行里能查到（快照 = 该轮可见切片的真子集）。restraint 行不出现时（脚本小任务
   未必触发克制），A2 降级断言由 §6 15b/15c 单测兜底，冒烟中明确记录"本轮无
   restraint、A2 以单测覆盖"——不伪造上游行为制造克制。

证据写入 `codebuddy-scratch/s3-smoke/`（不进 git，同 S2 惯例）。

## 8. 回滚口径（默认关闭 ⇒ Noop 行为）

- 新模块为**纯新增文件**；两条 handler 只追加一个 config 默认关闭的守卫 if；
  config/types 只加可选字段；turnSeq 只加 export；schema 只改注释。**无任何既有
  代码路径被替换或改默认**。
- 开关未开 = `decision_unit.created` 一行不写、抽取模块不 import（动态 import 在 if
  内）、无内存水位线条目 —— 行为与现状逐字节等价。
- A2（§4.9）读取 S2 产物是**纯读增强**：读不到（S2 未开 / 无行 / repo 失败）即省略
  payload 字段，不回溯改写已落行、不因快照改变 unit_id —— 开启 S3 但未开 S2 时的
  行为与"无 A2 版本"逐字节等价，回滚 A2 = 删除 runner 里一段 helper 调用。
- 开启时所有落库走 repo（内部 try/catch 静默降级 + Null repo），runner 自身不
  throw、不阻断请求；异常推导只影响当次捕获，不影响转发。
- 崩溃重放 / 重启：唯一索引冲突是**预期路径**（S1 repo 已按"单行跳过、整批不
  回滚"实现），无脏数据风险。

## 9. 开放问题

1. **top-N 截断归属**：本 spec 定为**不在 v1 捕获侧截断**（理由见 §2）。若评审认为
   必须与报告措辞逐字对齐，可改为"runner 每请求上限 topN（默认 30），超限单元以
   一行 `decision_unit.created` 溢出标记行（payload.overflowed=true）落库"—— 但那
   会让数据层出现非决策的决策行，v1 宁可等 S5 消费侧再定。
2. **risky 词表动态化**：instruction L1 落库切词提取（含来源 asset_id 与撤销）属
   v2；v1 用内置种子常量。评审若要求 v1 就接提取，需新增一张词表来源表 + 入库
   hook —— 超本切片范围，建议 v2。
3. **compaction 重放的 key 漂移**：唯一索引保证不重复、`unit_id` 保证可合并，但
   DB 会残留同 unit_id 的少数行。若 v2 消费端要求行级唯一，可届时给 unit_id 加
   partial unique index 并改 upsert —— 本切片不为未验证需求改表。
4. **单消息单元钳制**：16 slot/消息为防御性假设。真实 CC/CB 单消息决策单元数远超
   16 的样本若出现，应调大 `DECISION_SLOTS_PER_MESSAGE`（改常量即可，不动 DDL），
   而不是引入跨行复合键。
5. **OpenAI `role=tool` 中断语义**：CodeBuddy 部分版本可能在工具循环中不连续发送
   `role=tool`（如错误吞掉）。密封规则以"配对结果出现在窗口"为准，若某客户端永远
   不补结果，则该 key_tool 单元永不落库（宁缺不伪造）；观察到此类客户端后再议。
6. **A2 推广面（v2 决策）**：本切片只对 restraint 做可见切片快照（§4.9 理由：
   克制单元与约束资产因果最近、噪声最小）。v2 若把 `visibleAssets` 推广到
   code_change / key_tool_call，只挪 runner 同一密封点 + 同一 `loadVisibleAssets`
   helper，捕获侧成本可忽略 —— 届时按 v2 归因 worker 的实测噪声再定，v1 不做。

## 10. 溯源矩阵（本 spec 与设计/总纲的对账）

| 主张来源 | 落点 | 验收 |
|---|---|---|
| 报告 §3.2.1①：三类决策单元 + 证据强弱 | §4.4、payload §4.7 | §6 单测 1/4/6-7 |
| 报告 §3.2.1-1：宁滥勿缺 + top-N | §2（top-N 移交 v2 S5） | §9 开放问题 1 |
| 报告 §3.2.1-2：同文件 + 连续两条硬合并规则 | §4.3 | §6 单测 1-3 |
| 报告 §3.2.1-3：克制型触发 + risky 词表（v1 种子） | §4.4 | §6 单测 6-7/7b |
| 报告：按 `tool_use.id` 跨请求配对、只看 id | §4.4 | §6 单测 4 |
| 报告：增量切片 + 已见消息下标 + 进程重启可重建 | §4.2 | §6 单测 10-13；§7 冒烟 3 |
| master §8 开放问题 ① 接缝时机 | §4.1 | §7 冒烟 |
| master §8 开放问题 ② 游标存储 | §4.2 | §6 单测 10/13 |
| master §3 事件词汇表 / 命名契约 | §4.8、§5.1 | — |
| master §6 冒烟内容（读→Edit→测→commit -s） | §7 | §7 |
| 10-event-table §9.1 msg_seq 语义归属 | §4.5 | §6 单测 15 |
| 2026-09-08 brainstorm 收编 B1（人类命令形复用 KEY_TOOL_MATCHERS） | §4.4、payload §4.7、§5.1 | §6 单测 6(ii)/7(c) |
| 2026-09-08 brainstorm 收编 B3（同轮密封结论机械校验 restraint） | §4.4、§5.1（classifyRestraint 入参） | §6 单测 7b |
| 2026-09-08 brainstorm 收编 A1（asset↔decision 同表 join 契约） | §4.9、行级 §4.7 | §7 冒烟 5 |
| 2026-09-08 brainstorm 收编 A2（restraint 可见切片快照） | §4.9、payload §4.7 | §6 单测 8/15b/15c；§7 冒烟 6 |
