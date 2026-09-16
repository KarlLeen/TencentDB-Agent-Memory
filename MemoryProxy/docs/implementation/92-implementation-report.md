# 实现报告：资产使用链路与可信归因（任务三 + 任务四）

> 本报告对照 [feature/attribution-v2](https://github.com/KarlLeen/TencentDB-Agent-Memory/tree/feature/attribution-v2) 分支的真实代码逐条核对写成，配套设计稿是《团队记忆系统的价值判断与资产可感知复用设计》的作业三部分。设计稿在代码写出来之前就定了方向，这份报告回答三件事：**做了什么**（交付面）／**怎么实现的**（设计思路与关键机制）／**遇到哪些挑战**（以及怎么处理、沉淀成什么规则）。
>
> **范围**：本线负责 **任务三（资产使用链路记录与可信归因）** 与 **任务四（用户可感知的资产使用说明）**；题目 Q3（能否证明效果）与 Q4（结果反哺资产）分别由**任务五（效果评测/反事实）**与**任务六（经验回流/候选资产）**承接 —— 本线**不越界声明**（见 §9 红线）。
>
> **配套文件**：单号→落点索引见 `90-work-order-index.md`；提交材料成稿见 `91-submission-honesty-redlines.md`。公网可访问的部署在 `43.156.131.187:8443`（账号 `teacher`）。

---

## 0. 这份报告怎么读

对照方式很直接：设计稿每条机制，都在真实代码里找到（或找不到）对应实现，找到就标注真实的字段名、阈值、文件行号；找不到就如实标"仍是设计"。全文的判断标准只有一条：**能不能在仓库里指到具体代码**，指不到的说法一律不算数。§7 是终盘对账的完整表格（任务三 9 条 + 任务四 12 条），§9 是踩过的坑，是全篇最硬的两部分。

---

## 1. 状态机：真实实现

设计稿定义了六个状态，真实系统里实际在跑的是七个词（多一个综述框架带出来的 `contributed`）。逐条现状：

| 状态 | 真实系统现状 | 关键证据 |
|---|---|---|
| `asset_recalled` | ✅ 有名有载体 | 阶段词表 `stage-vocabulary.ts:14`：`recalled ← shortlist / citationMetrics[]`，展示层代码是唯一定义处 |
| `asset_selected` | 🟡 名称载体已落，筛选依据维度未落 | `stage-vocabulary.ts:15`：`selected ← shortlist`；相关性/可信度/新鲜度/环境兼容/历史效果/Token 成本这些排序维度不在本线范围，属任务二 |
| `asset_injected` | ✅ | `injection.hook.done` 按资产摊行 |
| `asset_used` | 🟡 语义窄，是设计不是欠账 | 只在 `confirmed` 时写；mechanical 判官 `confirmed` = 整段逐字（红线一），real 判官 = 语义确认（157），见 §2 |
| `asset_validated` | 🚫 制度性永久禁写 | 事件白名单 fail-closed，只放行 `used`/`corrected`（`status-events-repo.ts:44`）；没有独立验证器就不允许系统自证"已验证" |
| `asset_corrected` | 🟡 L1 在生产，L2/L3 触发式登记 | `corrected-rules.ts` 只接了版本漂移一路；grep 全 `src/` 确认另两路无生产者 |
| `asset_contributed`（综述六阶段词，非任务三六状态之一） | 🟡 接口已登记，无生产者 | 只映射/只登记、零代码路径；效果类结论跨线交给任务六 |

`asset_validated` 这条红线是整份实现报告里跟设计稿分歧最大的一处：设计稿把它当成正常要写的状态，真实代码把它当成一条不可逾越的边界。原因很直接：系统没有独立验证器，只有测试跑没跑过这一个代理信号，代理信号不够格自称"已验证"，回执因此改用三档效果状态（已采用 / 已校正 / 仅背景参考效果待验证），"已验证"这三个字不会出现在任何真实回执里。

**asset → decision/change → outcome 的关联，是设计稿唯一留白、真实实现已经补上的实体缺口。** 新增事件 `agent.tool.change` 从消息面直接派生，不依赖可见文本归档（纯 `tool_use` 的助手轮本来就没有可见文本，归档会漏这一段）。payload 逐字限定 6 个键：`tool`/`kind`/`path_ext`/`path_sha16`/`exit_status`/`units`，命令原文、路径原文、diff 一律不落。唯一锚落在 `units` 数组里的 `unit_id`，幂等槽位带独立编号（`10_000_000 + anchor×16 + 事件位`），跟决策单元自己的槽位不冲突。"窗口末条不落"：窗口内最后一条工具调用先不落（否则会落一条 `units: []` 且因幂等键冲突永远学不到锚），等下一次请求再落。真库已经落行，一次真实请求的完整回放：

```
hook.done +48（3 请求 × 16）
block_seen +15
block_text +6
message_snap +5
decision_unit.created +1
agent.tool.change 0 → 1
judge_queue +1

payload 逐字：
{"tool":"Edit","kind":"edit","path_ext":"ts","path_sha16":"b93791ddb9fd1766","units":["du_71fa18decb71"]}
```

这条锚定链在真实数据上的覆盖面是 34/35 ≈ 97%。

---

## 2. `asset_used` 怎么判定：真实机制

设计稿的核心判断保留了下来：不从资产出发问"它被遵守了吗"，而是从决策出发问"这个决策能归因到哪条资产"。真实实现在两处比设计稿描述得更具体，也更严格。

**决策单元的锚点不是按 `tool_use.id` 配对，是纯位置锚。** 真实编码是 `msg_seq = anchorMessageIndex × 16 + unitSlot`（`decision-units/types.ts:8-9,103-106`），身份/去重键是内容哈希 `unit_id = "du_" + sha1(canonical essence).slice(0,12)`。`tool_use.id` 仍然保留，但只是 payload 里的配对/证据字段，不是锚点本身。合并规则也比设计稿描述的范围宽一档：不是"同一条 assistant message"，而是"同文件 + 相邻轮次之间没有被非文件类工具打断"，可以跨消息合并。

这个纯位置锚点还顺手解决了设计稿担心的一个问题。设计稿在残留限制里花了一整段论证"任务边界判定仍是启发式，但只要每个决策单元独立划上下文切片、独立拉候选清单，边界切错就不会污染归因"，这段论证的前提在真实代码里根本不用刻意维护：候选清单本来就是按决策单元、按轮次锚定（`turn_seq`）逐条解析的（`evidence-supply.ts`、`fetched-anchoring.ts`），没有任何环节会把多个决策单元的候选清单合并成一份共享上下文。任务边界切在哪儿，都不会波及单条归因的判读输入，这是架构本身的写法，不是靠自觉遵守的约定。

**三道机械锚点已实现，落地形态比设计稿更严格一档。** 真实代码在 `MemoryProxy/src/attribution/citation/grading.ts`：锚点一变成 `matchLevel`（exact / whitespace / punctuation 三级引用匹配），锚点二变成 `gramCoverage`/`coverageDistinct`（区分性 n-gram 覆盖率），锚点三变成 `exclusionCount`（同一段文字在别的资产里出现的次数）。三者是分工关系，不是互相替代：`coverage`/`exclusion` 先把候选筛出来，但 **mechanical 判官**的 `confirmed` 档位是**红线一**：只认 `matchLevel: exact` 的整段逐字级引用，覆盖率/排他性达标只是必要条件，不是充分条件，"文本重合"被制度性降格成筛选信号，不能单独把归因抬到 `confirmed`（real 判官的语义确认是另一条独立通道，见下文，不稀释这条红线）。系统里还有一层裁判完全看不到的"影子指标"（`shadow-grading.ts` 的 `citationMetricsShadow[]`：最长公共子串连续重合、逐消息覆盖、跨度计数），专门留给事后校准分析用，不参与线上判定。

**裁判队列是真实的持久化基础设施，且比设计稿描述的更完整一档。** `attribution_judge_queue` 是一张真实的 SQLite 表，带租约超时的 CAS 认领、`pending → processing → done/failed` 状态机；`worker:attribution` 是独立进程，`prompt_sha256` 端到端落地（`judge-prompt.ts` 计算，`attribution_judgement_details.prompt_sha256` 落库）。触发时机不是设计稿设想的"任务/会话结束"或"空闲超时"，而是每个决策单元产生就立即入队，另有一条 `task_boundary` 触发和人工可发起的 `rejudge` 兜底。没做的两样：熔断机制（持续失败不会自动暂停标"待人工"）、以及设计稿设想的"两阶段人工标注校准集"。仓库里搜不到任何标注语料或标注流程，真正起类似作用的只有 `shadow-grading.ts`（离线分析用，判定层零读取）和一小组回归测试固定样例 `judge-golden-cases.ts`，跟设计稿描述的冷启动人工标注、观测级标注升级、三类负例构造完全是两回事。

**real 判官已上线，`confirmed` 从「整段逐字」扩展到「语义确认」双通道。** 157 单号落地了 real 判官（`judge.provider: real`，喂资产正文给 LLM 判「实质遵循」），与 mechanical 判官（`matchLevel: exact` 整段逐字）并存。real 判官不再要求逐字命中——它对照资产正文做语义判断，确认依据是「决策实质遵循了资产的约定/流程/约束」，`matchLevel: none`（语义确认）与 `exact`（逐字）是两档不同的确认来源，都写进 `attribution_judgement_details`。回执页因此多了一条「归因链」：判官理由 + 具体动作 + 位置，三行讲完 asset → decision → outcome（158）。

**跨命令证据链（161 + 163），解决了「验证链在判官视野里是断的」这个真实缺口。** 之前判官只能看到孤立的决策单元（如一条 pytest），看不到它后面的辅助动作（grep 提取失败、diff 对比基线）。现在判官输入新增 `turn_context`（同 turn 上下文），支撑它的是一条新事件 `tool_call.observed`：非 key 的 shell 命令（grep/diff/cat/wc 等）作为背景素材落库，**不独立成决策单元**（不稀释候选池、不撞 shortlist 成本闸门），只作为「支撑同 turn 内那个真正决策单元」的背景材料喂给判官。命令原文落库不截断（capture 层宽），组装层才截断（consume 层严），单条截断值先用临时值 200、等真实分布回看收紧。

**一个真实判官的判定结果（DeepSeek）证明了这条链的价值：**

> 资产正文教「三步验证 SOP：跑 pytest → grep 提取失败 → diff 对比基线」。会话里模型跑了 pytest（决策单元）+ grep/diff（辅助命令）。判官判定 `confirmed`，理由原文：*"The unit runs `pytest tests/ -q`, which is exactly step 1 of the asset's mandated three-step verification workflow. The turn_context also shows the subsequent grep and diff steps, matching the asset's prescribed sequence."* —— 判官不仅确认了 pytest 遵循 SOP 第一步，还**明确引用了 turn_context 里的 grep/diff 作为「后续步骤」的证据**。

另一个真实案例（更早的正例）：会话里模型执行 `git commit --signoff`，独立裁判对照资产正文后把它精确归因到 loopx 贡献者工作流偏好资产（DCO 签名约定）——`confirmed → asset_used` 落行，回执页显示「实质使用于 轮 4 · 消息 784（git.commit）」。

---

## 3. `asset_corrected` 怎么判定：真实机制

设计稿提出三路候选来源（时效规则、scope 聚类配对、实体状态校验），真实实现只接通了一路。

**只有 L1 版本漂移在生产。** `corrected-rules.ts` 的逻辑是：对每个 session 里出现过的 `asset_used` 行，比对首见版本与最新版本，版本窗口显示漂移就产一条 `asset_corrected`（`route: "version_drift"`）。这条路径写死了一条护栏：**不得把 5xx/超时记成 corrected**，网络层的失败不能冒充内容层的过时判断。

**scope 聚类配对、实体状态校验两路是"触发式登记，本线不实现"。** 不是忘了做，是在设计文档里明确标注为下一阶段的工作，当前代码里没有对应的生产者。

`asset_used` 和 `asset_corrected` 复用同一套核验方法论（机器规则 + 独立裁判互相印证），问的是两个正交问题：前者问"这次执行有没有受影响"，后者问"这条资产内容本身现在还成不成立"，跟具体哪次任务执行无关，这条设计判断在真实代码里原样保留，没有走样。

---

## 4. 回执设计：真实实现

设计稿要求的五项展开字段和一套摘要层，真实实现里逐项对照：

| 字段 | 现状 |
|---|---|
| 名称 / 类型（语义类映射） / 版本 / 更新时间（透出 `updated_at`） | ✅ 已实现 |
| 使用位置 / 对应代码修改 | ✅ 已实现，跟 §1 的 `agent.tool.change` 锚定链同源 |
| 摘要层（"本次应用 N 项团队资产"+一句话用途） | ✅ 已实现 |
| 效果状态三档（"已验证"不出现） | ✅ 已实现，直接对应 §1 的红线二 |
| 简洁可展开 | ✅ 已实现 |
| 来源 | 🟡 固定 `source: null`，代码注释逐字"无数据源 ⇒ 渲染'未知'、不臆造"，依赖任务一/六补元数据 |
| 验证状态 | 🟡 固定 `pending`，代码注释"不得拿 `meta.status` 冒充"，没有独立验证器就不写 |
| 风险 | 🟡 仅版本漂移一路，对应 §3 |

**`violated` 不对称水印仍是设计，真实代码里还没有。** 检索整个仓库，`violated` 这个词没有在任何判定/回执代码里出现过。设计稿"used 分歧默认藏起来、violated 疑似违反必须带水印露出来"这条不对称逻辑，目前只在回执页展示三档效果状态和按决策组织的归因明细，没有单独实现，是设计稿里想清楚、工期里还没排上的一块。

**evidence 按查看者权限过滤，这条实现了。** 裁判引用写进事件后，回执渲染按查看者逐条过 ACL，无权限时替换成"引用已按资产可见性隐藏"占位符。

**Q2"为什么适用于当前任务"已闭合。** 这一档只从已有素材派生：`verdict`、`citationMetrics`、shortlist 溢出面，输出四档，单一落点，复用既有 `verdict`，素材缺失就如实显示"未知"，零新增拉取、零新增 LLM 调用、不新造阈值，跟"不用模型自证"的立场一致，只是落地时机比原设计更早，在回执渲染这一步直接复用裁判已经算过的东西，没有另起一套"解释生成"。

---

## 5. 信用记录反哺排序：真实实现

设计稿提出的贝叶斯平滑信用分，在真实代码里因为红线二做了一处必然的改动。真实公式（`credit-score.ts:7,26,91-92`）：

```
credit = (used − corrected + k × baseline) / (used + k)      k = 5
```

因为 `asset_validated` 永久不可写，分子没法用"验证通过次数"，改成了"用了但没被证伪的次数"（`used` 减去 `corrected`），形状仍是贝叶斯平滑，只是"通过"的定义从"独立验证过"退成了"用了、暂时没被推翻"，如实反映系统真实掌握的信息。

**设计稿的乘性组合精排分（信用分 × 健康度 × 情境）没有实现。** 仓库里没有找到这个组合公式的任何代码，实际的 `rankByCredit`（`credit-score.ts:136-145`）只按单一信用分排序，"健康度"和"情境"两个乘数目前都不存在。而且整套排序功能挂在开关 `attribution.ranking.enabled` 后面，默认值是 `false`：本地部署至今正例长期为 0，此时打开排序等于让一堆没有统计意义的信用分去左右注入顺序，属于空转，所以刻意不开。这是诚实的现状，不是没做完，是"没有正例之前，宁可先别用"的克制。

---

## 6. 三条设计原则与关键机制

三条原则（先立原则，再写代码）：

1. **口径先行**：先定义"什么算被引用"，再写实现；判据的形态假设必须覆盖**实际**形态（不是"我以为的形态"）。
2. **判据取精确通道**：数值型基线/期望值**只从精确通道取**（精确分数 / 语言层真值 / `printf('%.17g')`），**不得取自显示层**（SQLite 默认显示、`toFixed`、`console.log` 默认精度）。
3. **fail-closed 与"静默即缺陷"**：危险动作**默认禁写**（红线二）；**任何"应当发生的写入"都必须能两侧对账**。

红线为什么是机械的：

- **红线一**（mechanical 判官的 `confirmed` 只代表整段逐字级引用）：把文本重合**降格为筛选信号**，`confirmed` 稀少是**设计结果**；
- **红线二**（`asset_validated` 禁写）：事件白名单 **fail-closed**，`asset_used` / `asset_corrected` 之外的状态事件**写不进去** ⇒ 回执里**不会出现"已验证"**。

---

## 7. 终盘对账：任务三 9 条 + 任务四 12 条

逐条重核代码与真库，不引报告，是这份实现报告最硬的部分。

### 任务三（9 条）：唯一实体缺口已闭合，余下没有"该做没做"的欠账

| # | 要求 | 现判 | 关键证据 |
|---|---|---|---|
| 1 | `asset_recalled` | ✅ 有名有载体 | 阶段词表 `stage-vocabulary.ts:14`：`recalled ← shortlist / citationMetrics[]`，展示层代码是唯一定义处 |
| 2 | `asset_selected` | 🟡 名称载体已落，筛选依据维度未落 | `:15 selected ← shortlist`；相关性/可信度/新鲜度/环境兼容/历史效果/Token 成本这些维度属任务二 |
| 3 | `asset_injected` | ✅ | `injection.hook.done` 按资产摊行 |
| 4 | `asset_used` | 🟡 语义窄 = 设计，不得放宽 | 仅 `confirmed` 时写；mechanical = 整段逐字（红线一），real = 语义确认（157，不稀释红线） |
| 5 | `asset_validated` | 🚫 制度性禁写 | 白名单 fail-closed；"谁能签这个字"留作显式裁定，不靠倒计时逼出来 |
| 6 | `asset_corrected` | 🟡 L1 在生产；L2/L3 = 触发式登记 | 逐字裁定 + 全仓库 grep 核实：无生产者；并写死"不得把 5xx/超时记成 corrected" |
| 7 | `asset_contributed` | 🟡 接口已登记，无生产者 | 只映射/只登记、零代码路径；效果类结论跨线交给任务六 |
| 8 | asset → decision/change → outcome | ✅ 已打通 | `agent.tool.change`（从消息面直接派生）+ 唯一锚落 `unit_id` 列 + 幂等槽位带；真库已落行，payload 逐字见 §1（零原文） |
| 9 | 防"仅凭召回宣称有效" | ✅ | 三档只报真实状态；`validated` 禁写 |

### 任务四（12 项）：全部有落点，9 ✅ / 3 🟡，🟡 是"如实缺"，不是"缺实现"

名称、类型（语义类映射）、版本、更新时间、使用位置、对应代码修改、摘要层、效果状态三档、简洁可展开这 9 项已落地；来源、验证状态、风险这 3 项固定渲染"未知"/"pending"/"仅版本漂移"，理由见 §4。另：Q2"为什么适用于当前任务"已闭合，见 §4 末尾。

---

## 8. 结果与证据（可复跑）

### 8.1 机器门（提交态亲跑）

| 门 | 结果 |
|---|---|
| `MemoryProxy` | **57 文件 / 658 测试全过** |
| `MemoryPanel` | **9 文件 / 71 测试全过** |
| 存活自检 | `auth=401(ok) health=200(ok)`（`scripts/qa/archive-liveness.ts`） |

### 8.2 端到端（真实上游 + 真实判官）

一次请求的逐表增量（每格可归因）：`hook.done +48`（3 请求 × 16）、`block_seen +15`、`block_text +6`、`message_snap +5`、`decision_unit.created +1`、**`agent.tool.change 0 → 1`**、`judge_queue +1`。

真实判官的归因链（两个正例）：

- **loopx DCO**：`git commit --signoff` → 归因到 loopx 贡献者工作流偏好资产（DCO 约定）→ `confirmed → asset_used`，回执页「实质使用于 轮 4 · 消息 784（git.commit）」；
- **pytest→grep→diff 验证链**（§2 详述）：判官 `confirmed`，理由引用 turn_context 里的 grep/diff 作为「后续步骤」证据。

### 8.3 三个可复跑入口（评审可自己跑）

| 入口 | 作用 |
|---|---|
| `scripts/qa/archive-liveness.ts` | 存活自检：无凭据必须 401 + health |
| `scripts/qa/visible-archive-coverage.ts` | 两侧对账（hook.done ↔ block_seen ↔ 候选），三种"0"可分 |
| `scripts/qa/positive-mining.ts` | 正例挖掘 + 落空报告（"真没有"与"口径坏了"可分） |
| `scripts/qa/shadow-calibration.ts` | 影子指标标定台（夹具 FP=0 ∧ FN=0） |

---

## 9. 踩过的坑（都是真跑出来的）

> 每一条都给出**怎么发现的 → 怎么处理 → 沉淀成什么规则**。

1. **"链路在跑" ≠ "端到端真的通"**：归档/注入/单元三段双侧非零，客户端一个字拿不到——上游还是占位域名，FORWARD 阶段 502。→ 把验收落在末端产物上，配同族反控（换回占位域 ⇒ 必须 502）。**规则：末端产物判据**。
2. **默认关闭的开关 + 部署配置代际**：两个真实会话的 block_seen 0 行，合计 116 事件 ≈ 全库 29% 从未进档，成因是配置里三键缺省 false。→ 做两侧对账入口、缺口不回填、用"新事件类型首次出现"证明新代码在跑。**规则：静默不写必须两侧对账**。
3. **判据的"形态假设"没覆盖实际形态**：数值期望值写成 15 位截断形态，parse 回来差 3 ulp；`toFixed(16)` 非单射，把约 19 个相邻 double 压成同一串。→ 主字段改最短往返形态（17 字符，单射），不改判据、不用容差。**规则：数值型期望值必须取自精确通道**。
4. **口径与数据现实的冲突**：改写型反例重合度最高 0.877 ≥ 正例最低 0.605，区间重叠、不可分；现库最大连续重合仅 3 字符（阈值 24）。→ 不调门槛、不放宽口径，把"0 候选"做成可分报告。**规则：不得调阈值掩盖数据不足**。
5. **账要能对上**：锚定面 34/35 ≈ 97%，但变更类 0 条可判定（档②无 assistant 行拿不到工具名）。→ 不为凑数放宽门槛，停在"量化 + 诚实登记"，据此做成 `agent.tool.change`。**规则：单内预设终点，允许停在"量化 + 登记"**。
6. **端到端落地时的"隐性前提"**：Model gate（model 必须匹配价目表）、两把钥匙（上游 key ≠ 客户端 user_key）、身份头缺失 ⇒ 200 但零观测、接口文档示例 ≠ 本栈实况。→ 逐条核回代码与真库。**规则：接口文档的接入示例必须逐字核回本栈**。
7. **统计与自检自身的坑**：`zsh` 不对未加引号参数做字段分割 ⇒ 45 文件误报；`cut` 截断输出当全集；空串 sha256 假阳性；统计单号时自指污染。→ 采集命令原样写进文档。**规则：统计四戒**（循环先验证／计数先 wc -l／空哈希当异常／采集集合不得含被验收对象自身）。
8. **"不声明"必须是机械的**：把"只有任务结果或独立验证器能证明正向作用时才可声明"做成代码级约束（白名单 fail-closed 禁写 `asset_validated`）。**规则：红线要用机制保证，不用自觉保证**。

---

## 10. 还差什么 + 诚实限制

### 还差什么（按性质分四类）

| 类 | 差什么 | 怎么办 |
|---|---|---|
| A · 已由真实会话验证 | 回执页"使用位置"/"对应代码改动"真实计数 + 判官跨命令证据链 | 已跑通：回执页显示"实质使用于 轮 4 · 消息 784（git.commit）"；pytest→grep→diff 验证链被真实 DeepSeek 判官读出（见 §2） |
| B · 待外部元数据（非本线） | 来源 | 依赖任务一/六补元数据；此前如实显示"未知" |
| C · 有意不补（红线/待裁定） | `validated`（红线二）、`used` 语义窄（红线一）、L2/L3 corrected、`contributed` | 保持现状，等裁定；明令不得为凑数据放宽口径 |
| D · 不属本线 | Q3（能否证明效果）、Q4（结果反哺资产） | 分别交给任务五、任务六 |

### 诚实呈现的限制

- **"已验证"档长期为空**：红线二，没有独立验证器就禁写，有意设计，不是缺陷。
- **正例长期稀少（仅 mechanical 口径）**：红线一，mechanical 判官的 `confirmed` 要求整段逐字，现库最大连续重合远低于阈值；real 判官（语义确认，157）上线后，语义遵循也能产 `confirmed`，但两条口径分开计，不互相稀释。
- **信用排序功能默认关闭**：正例为 0 时打开排序是空转，宁可先不用。
- **`violated` 不对称水印未实现**：设计已想清楚，工期未排上。
- **scope 聚类配对、实体状态校验两路 corrected 候选未接线**：触发式登记，等待下一阶段。
- **两阶段人工标注校准集不存在**：只有离线 shadow-metric 工具和一组回归测试固定样例。
- **熔断机制未实现**：裁判队列持续失败不会自动暂停标"待人工"。

---

## 11. 老师怎么部署 / 复现

### 最快看：公网已部署

`https://43.156.131.187:8443/`（BasicAuth，账号 `teacher`）→ `#/attribution` 看回执页，`#/audit` 看人工抽查池。回执页里展开任意已采用资产，能看到「归因链」三行（判官理由 + 具体动作 + 位置）。

### 本地复现

两个进程：

| 组件 | 跑法 | 端口 |
|---|---|---|
| proxy 后端 | `cd MemoryProxy && node --import tsx/esm <launch.mts> --config <config.yaml>`（连真库 `~/.tdai-memory-proxy/proxy.db`） | 8098 |
| 面板 | Docker 镜像 `team-memory-panel-knowledge:6a87a9c-navfix`，容器 `tdai-memory-hub` | 8125 |

`attribution` 段的关键三键（缺任一键归因全暗）：

```yaml
attribution:
  judge:
    enqueue: true        # 入队开关
    provider: real       # 真实 LLM 判官（DeepSeek）
injection:
  decisionUnitExtractor:
    enabled: true        # 抽取开关
```

起来后 `http://127.0.0.1:8125/#/attribution` 选会话看回执。

### 复现「pytest → grep → diff 读出验证 SOP」这条

1. 造一个资产正文教「三步验证 SOP：跑 pytest → grep 提取失败 → diff 对比基线」（落 `injection.hook.done` + 可见正文归档）；
2. 会话里跑 pytest（决策单元）+ grep/diff（辅助命令，自动落 `tool_call.observed`，命令原文不截断）；
3. 判官判定 pytest 单元时，`turn_context` 带上 grep/diff，real 判官据此 `confirmed`，理由会引用「subsequent grep and diff steps」（真实判定原文见 §2）。

---

## 附：代码索引

| 机制 | 文件 |
|---|---|
| 状态阶段词表 | `MemoryPanel/.../stage-vocabulary.ts` |
| 事件白名单 fail-closed | `MemoryProxy/src/attribution/status-events-repo.ts` |
| 决策单元编码 | `MemoryProxy/src/decision-units/types.ts` |
| 候选清单解析 | `MemoryProxy/src/attribution/evidence-supply.ts`、`fetched-anchoring.ts` |
| 三道机械锚点 | `MemoryProxy/src/attribution/citation/grading.ts` |
| confirmed 判据（mechanical） | `MemoryProxy/src/attribution/citation/mechanical-judge.ts` |
| 影子指标 | `MemoryProxy/src/attribution/citation/shadow-grading.ts` |
| real 判官（语义确认） | `MemoryProxy/src/attribution/judge/real-provider-judge.ts`、`prompts/judge-prompt.ts` |
| 同 turn 上下文 | `MemoryProxy/src/attribution/worker.ts`（`buildTurnContext`）、`judge/types.ts` |
| 工具调用素材 | `MemoryProxy/src/decision-units/tool-call-observed.ts` |
| 裁判队列 | `MemoryProxy/src/attribution/judge-queue-repo.ts` |
| 裁判 worker | `MemoryProxy/src/attribution/worker.ts` |
| 入队触发 | `MemoryProxy/src/attribution/enqueue.ts` |
| corrected 规则 | `MemoryProxy/src/attribution/corrected-rules.ts` |
| 信用分公式 | `MemoryProxy/src/attribution/credit-score.ts` |
| 变更锚定事件 | `MemoryProxy/src/decision-units/tool-change-records.ts` |
| 回执页面 | `MemoryPanel/web/src/pages/AttributionReceiptPage/` |
| tsc 基线 | `scripts/qa/tsc-baseline.json` |
