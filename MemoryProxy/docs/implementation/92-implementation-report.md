# 团队记忆系统：资产使用回执与可信归因（任务三 + 任务四 实现报告）

> 一句话说清这个交付：**Agent 干活时，系统自动记录「团队资产影响了哪次决策」，由独立判官给出可核验的证据，并在回执页展示给用户。** 本报告用两个真实案例 + 真实数据讲清楚它做了什么、怎么做的、哪些没做。配套代码在 [feature/attribution-v2](https://github.com/KarlLeen/TencentDB-Agent-Memory/tree/feature/attribution-v2) 分支，单号→落点索引见 `90-work-order-index.md`。

---

## 1. 先看两个真实案例（系统实际跑出来的）

### 案例 1：DCO 签名约定被正确归因

**场景**：把 loopx 项目的 4 个文件改动提交成 git commit。

**过程**：

1. 会话初始化时，系统注入 **11 项团队资产**（12 个 skill + 1 个团队记忆，去重后 11 项）；
2. 模型执行 `git commit --signoff` —— `--signoff` 正是其中一项资产里教的「PR 必须 DCO 签名」约定；
3. 独立判官（DeepSeek LLM）对照资产正文逐条判定，把这次 commit **精确归因**到那条 DCO 资产：
   - 判定：`confirmed`（已采用）
   - 理由原文：*"The unit runs `git commit --signoff`, which directly reflects the asset's stated convention of DCO signing for huangruiteng/loopx PRs."*
4. 回执页结果（见下方截图）：
   - 摘要一句话：「**1 项已采用；10 项仅作为背景参考**，效果待验证」；
   - 已采用资产置顶，展开看到**归因链**三行：判官理由 → 具体动作（`git commit --signoff`）→ 位置（轮 4 · 消息 784）。

**（此处插入截图：回执页 — DCO 案例归因链）**

这个案例说明系统回答问题的方式：**不从资产出发问"它被遵守了吗"，而是从决策出发问"这个决策能归因到哪条资产"**——并且判官给出的是可核验的理由，不是黑盒打分。另外 10 项为什么是"背景参考"？判官逐条给了拒因（"注入了，但没找到它影响了哪个决策的可信证据"），**不静默、不凑数**。

### 案例 2：验证链（pytest → grep → diff）被完整读出

**场景**：一项资产教「三步验证 SOP：跑 pytest → 用 grep 提取失败用例 → 用 diff 对比基线」。

**过程**：

1. 会话里模型跑了 `pytest`——这是一次**决策**，抽成决策单元；
2. 随后跑了 `grep`、`diff`——这些是**辅助命令**，不是决策，**不会**被拔高成独立单元（否则大量路由性命令会稀释候选池）；
3. 关键机制：grep/diff 作为**背景素材**记录进新事件 `tool_call.observed`，并在判官判定 pytest 单元时，通过 `turn_context`（同轮上下文）喂给判官；
4. 判官判定 `confirmed`，理由原文：*"The unit runs `pytest tests/ -q`, which is exactly step 1 of the asset's mandated three-step verification workflow. **The turn_context also shows the subsequent grep and diff steps**, matching the asset's prescribed sequence."*

这个案例说明的核心：判官看到的不是孤立的一条命令，而是**完整的验证链**——「pytest → grep → diff」三步与资产教的 SOP 一一对应。如果没有 `turn_context`，判官只能看到 pytest，验证链在它的视野里是断的。

---

## 2. 数据账单（上面案例的真实数字）

| 项 | 数字 |
|---|---|
| 注入资产 | 11 项（12 skill + 1 团队记忆，去重后 11） |
| 决策单元 | 3 个（1 个 git commit、1 个 pytest、1 个克制判定） |
| 判官判定 | 3/3 判完：**1 confirmed → `asset_used` 落行**；2 unconfirmed（各自带理由）；0 待处理、0 失败 |
| 六阶段口径 | recalled / selected / injected = 11 项进入上下文；**used = 1**（DCO）；validated = 0（fail-closed 设计，见 §4）；corrected = 0 |
| 锚定覆盖 | 34/35 ≈ 97%（asset → decision/change → outcome 的关联面） |
| 测试 | **MemoryProxy 57 文件 / 658 测试全过；MemoryPanel 9 文件 / 71 测试全过** |

---

## 3. 系统怎么做到的（四步，大白话）

1. **记录**（任务三）：请求经过时自动记三样——哪些资产被注入了（`injection.hook.done`）、模型做了哪些关键决策（`decision_unit.created`，如跑测试、提交代码）、决策伴随的变更与辅助命令（`agent.tool.change` + `tool_call.observed`）。payload 只落哈希与枚举，**命令原文、路径原文、diff 一律不落**（不制造新隐私面）。
2. **判定**（任务三）：每条决策入判定队列（真实 SQLite 表 + 租约认领），独立判官逐条判。判官两条通道：
   - **real 判官**（默认启用，DeepSeek）：对照资产正文判断「这个决策是否**实质遵循**了资产的约定/流程」，给出理由；
   - **mechanical 判官**（兜底）：只认「整段逐字引用」，拿不到就如实 unconfirmed，**不用相似度充数**。
3. **回执**（任务四）：面板回执页把结果讲给用户——摘要一句话（"本次应用 N 项团队资产"）、三档效果状态（已采用 / 已校正 / 仅背景参考）、展开看明细（含归因链）。
4. **不撒谎的机制**（设计核心）：
   - 没有"已验证"这个档：没有独立验证器，系统就**不许**自己写"已验证"——这是代码级 fail-closed（事件白名单），不是靠自觉；
   - 缺数据显示"未知"，不用 0 或空串冒充；
   - unconfirmed 的每一项都带判官理由，不静默丢弃。

---

## 4. 诚实边界（哪些没做、为什么）

| 没做的 | 原因 |
|---|---|
| "已验证"档长期为空 | 没有独立验证器就禁写——**有意设计**，不是缺陷 |
| mechanical 口径的正例稀少 | 只认整段逐字，宁缺毋滥；real 判官的语义确认是另一条通道，**两口径分开计、不互相稀释** |
| 信用排序默认关闭 | 正例为 0 时打开排序是空转，宁可先不用 |
| 效果评测、经验回流 | 属于题目任务五 / 任务六，本线不越界声明 |

完整清单（含 8 个踩坑记录、"该做没做"的逐项对账）见文末附录。

---

## 5. 老师怎么部署 / 复现

### 最快看：公网已部署

`https://43.156.131.187:8443/`（BasicAuth，账号 `teacher`）→ `#/attribution` 看回执页，`#/audit` 看人工抽查池。

### 本地复现

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

### 复现「pytest → grep → diff 读出验证 SOP」

1. 造一个资产正文教「三步验证 SOP：跑 pytest → grep 提取失败 → diff 对比基线」（落 `injection.hook.done` + 可见正文归档）；
2. 会话里跑 pytest（决策单元）+ grep/diff（辅助命令，自动落 `tool_call.observed`）；
3. 判官判定 pytest 单元时 `turn_context` 带上 grep/diff，real 判官据此 `confirmed`，理由引用「subsequent grep and diff steps」（真实判定原文见案例 2）。

---

## 附 A：终盘对账（任务三 9 条 + 任务四 12 条）

逐条指到代码，指不到就如实标"仍是设计"——这是全篇最硬的部分。

### 任务三（9 条）

| # | 要求 | 现判 | 关键证据 |
|---|---|---|---|
| 1 | `asset_recalled` | ✅ 有名有载体 | 阶段词表 `stage-vocabulary.ts:14` |
| 2 | `asset_selected` | 🟡 名称载体已落，筛选维度未落 | `:15 selected ← shortlist`；排序维度属任务二 |
| 3 | `asset_injected` | ✅ | `injection.hook.done` 按资产摊行 |
| 4 | `asset_used` | 🟡 语义窄 = 设计 | 仅 `confirmed` 时写；mechanical = 整段逐字（红线一），real = 语义确认（157） |
| 5 | `asset_validated` | 🚫 制度性禁写 | 白名单 fail-closed（`status-events-repo.ts:44`）；"谁能签这个字"留作显式裁定 |
| 6 | `asset_corrected` | 🟡 L1 在生产；L2/L3 触发式登记 | `corrected-rules.ts` 只接版本漂移；写死"不得把 5xx/超时记成 corrected" |
| 7 | `asset_contributed` | 🟡 接口已登记，无生产者 | 效果类结论跨线交给任务六 |
| 8 | asset → decision/change → outcome | ✅ 已打通 | `agent.tool.change` + `tool_call.observed` + 幂等槽位带；真库已落行（payload 见 §1） |
| 9 | 防"仅凭召回宣称有效" | ✅ | 三档只报真实状态；`validated` 禁写 |

### 任务四（12 项）：9 ✅ / 3 🟡

名称、类型、版本、更新时间、使用位置、对应代码修改、摘要层、效果状态三档、简洁可展开这 9 项已落地；来源、验证状态、风险 3 项固定渲染"未知"/"pending"/"仅版本漂移"——🟡 是"如实缺"，不是"缺实现"。

---

## 附 B：踩过的 8 个坑（现象 → 处理 → 沉淀成规则）

1. **"链路在跑" ≠ "端到端真的通"**：三段各自双侧非零，客户端一个字拿不到（上游还是占位域名）→ 验收必须落在末端产物上。**规则：末端产物判据**。
2. **默认关闭的开关 + 配置代际**：116 事件 ≈ 29% 可见文本从未进档，成因是配置三键缺省 false → 做两侧对账入口、缺口不回填。**规则：静默不写必须两侧对账**。
3. **判据的形态假设没覆盖实际形态**：`toFixed(16)` 非单射，把约 19 个相邻 double 压成同一串 → 主字段改最短往返形态（17 字符，单射）。**规则：数值期望值必须取自精确通道**。
4. **口径与数据现实冲突**：改写型反例重合度 0.877 ≥ 正例最低 0.605，区间重叠 → 不调门槛、不放宽口径，把"0 候选"做成可分报告。**规则：不得调阈值掩盖数据不足**。
5. **账要能对上**：锚定面 97% 但变更类 0 条可判定 → 停在"量化 + 诚实登记"，据此做成 `agent.tool.change`。**规则：允许停在"量化 + 登记"**。
6. **端到端的隐性前提**：Model gate / 两把钥匙 / 身份头缺失 ⇒ 200 但零观测 → 逐条核回代码与真库。**规则：接口文档示例必须逐字核回本栈**。
7. **统计工具自身会骗人**：zsh 不分词 / cut 截断当全集 / 空串 sha256 假阳性 / 自指污染 → 采集命令原样写进文档。**规则：统计四戒**。
8. **"不声明"必须是机械的**：把"无验证器不许声明效果"做成代码级约束。**规则：红线要用机制保证，不用自觉保证**。
