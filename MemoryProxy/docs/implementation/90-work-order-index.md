# `90`｜单号 → 落点索引（提交材料可溯源性）

> **由来**：`154 · C1`（nano 文档单）。仓库文档里大量引用 `1xx` 单号（如"（`149 · C1`）"、"`144 §5.1`"），
> 而**那些单不在仓库** ⇒ 评审**无法溯源**。本索引只解决"**点得到**"；单正文入仓（`154 · C4`）**已裁不做**。
>
> **性质**：纯文档、**零行为改动**（`154` 明令③：本单只新增 `90`/`91` 两份文档）。
> **诚实边界**：标题取自**工作区单文件**（`~/CodeBuddy/20260907024638/<单号>-*.md`，非仓库文件）；
> 本表给出"单号 → 标题 → repo 落点（提交 hash / 文档行）"。

## 1. 判据与可复算命令（先复算，再对照本表）

```bash
# 判据 A（严格：反引号包裹的 3 位数；排除依赖包目录与索引自身）
grep -rhoE --exclude-dir=node_modules --exclude='90-work-order-index.md' '`1[0-5][0-9]`' \
  MemoryProxy/docs MemoryPanel --include='*.md' | tr -d '`' | sort -u

# 判据 B（宽松兜底：任意 3 位数；应全部落在本表或 §3 误报表）
grep -rhoE --exclude-dir=node_modules '1[0-5][0-9]' MemoryProxy/docs MemoryPanel --include='*.md' | sort -u
```

| 口径 | 计数 | 说明 |
|---|---|---|
| A 严格 · **含**依赖包 | **36** | `154 · 事实 4` 的基准（其清单列出的即这 36 项） |
| A 严格 · **排除**依赖包 | **35** | 差额 = `101`（其反引号命中仅出现在 `node_modules/**` 的依赖包文档里） |
| B 宽松 · 排除依赖包 | **58** | 其中 **36** 项是真单号（§2）、**22** 项是数字碎片（§3） |

> **为什么必须排除 `node_modules`**：`MemoryPanel/web/node_modules/**` 下每个依赖包都自带说明文档
> （`ms`、`postcss-selector-parser` 等），其中含 `#3112`、`126288e`、`1.125rem` 一类数字 ⇒ 不排除会把判据污染成"到处命中"。

## 2. 主表：单号 → 标题 → 落点（36 条）

| 单号 | 标题 | 落点（提交 · 代码/文档） |
|---|---|---|
| `100` | 100 · "接线却空转"（silent no-op）系统性扫查 —— 独立复核报告 | 无独立提交（复核单）；口径被 `docs/implementation/s4-smoke-design.md:950` 引用（正例 `storage = 115`） |
| `101` | 101 · 登记 T7 端到端残项 + 随单条 #7（**三处 append，纯 docs**）——"要落就落" | `28feabd` · `MemoryProxy/docs/implementation/80-credit-score-and-ranking.md`、`MemoryProxy/docs/implementation/s4-smoke-design.md` |
| `102` | 102 · T7 端到端补齐 —— 执行报告 | `518f28e` · `MemoryProxy/docs/implementation/80-credit-score-and-ranking.md`、`MemoryProxy/docs/implementation/s4-smoke-design.md`、`MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts`（+1 文件） |
| `103` | 103 · brainstorm：判定链"**零区分度**"结构性缺口 —— **先定案，不写代码** | 无独立提交（定案单）；结论被 `docs/implementation/80-credit-score-and-ranking.md:57-60`（`110 · D6`）与 `s4-smoke-design.md`（可达性 = `103` F8/(d)）引用 |
| `104` | 104 · 引文侧剔除"注入块自身"（tier 过滤）—— **纯正确性修复** | `acef27b` · `MemoryProxy/docs/implementation/50-attribution-judge-worker.md`、`MemoryProxy/docs/implementation/80-credit-score-and-ranking.md`、`MemoryProxy/docs/implementation/s4-smoke-design.md`（+7 文件） |
| `105` | 105 · 资产级切片（**计算层**）—— 恢复候选间 coverage 区分度 | `08987e4` · `MemoryProxy/docs/implementation/50-attribution-judge-worker.md`、`MemoryProxy/docs/implementation/s4-smoke-design.md`、`MemoryProxy/src/attribution/citation/asset-slices.ts`（+3 文件） |
| `106` | 106 · (d)-1 **影子度量 + 标定工作台** —— 只记录、不改判定 | `a5d991c` · `MemoryProxy/docs/implementation/50-attribution-judge-worker.md`、`MemoryProxy/docs/implementation/80-credit-score-and-ranking.md`、`MemoryProxy/docs/implementation/s4-smoke-design.md`（+4 文件） |
| `107` | 107 · (d)-1b **标定台补强** —— 让 (d)-2 的阈值不是在"容易负例"上挑出来的 | `219b0ae` · `MemoryProxy/docs/implementation/50-attribution-judge-worker.md`、`MemoryProxy/docs/implementation/s4-smoke-design.md`、`MemoryProxy/src/attribution/citation/shadow-grading.ts`（+1 文件） |
| `108` | 108 · (d)-1c 两条补强（可复跑 + 连续重合轴）—— 执行报告 | `81d06e7` · `MemoryProxy/docs/implementation/50-attribution-judge-worker.md`、`MemoryProxy/docs/implementation/s4-smoke-design.md`、`MemoryProxy/scripts/qa/shadow-calibration.ts`（+3 文件） |
| `109` | 109 · D6 **证伪实验**：A 判据（绝对逐字重合门槛）在"**风格接近但从未读过**"反例上的 FP 率 ＋ **P3 修复** | `e1d4263` · `MemoryProxy/docs/implementation/50-attribution-judge-worker.md`、`MemoryProxy/docs/implementation/s4-smoke-design.md`、`MemoryProxy/scripts/qa/shadow-calibration.ts`（+1 文件） |
| `110` | 110 · D6 落地：**C 为默认（confirmed 只代表"整段逐字"级高置信）＋ B 降格为筛选信号** | `c8872a9` · `MemoryProxy/docs/implementation/50-attribution-judge-worker.md`、`MemoryProxy/docs/implementation/70-panel-read-and-audit-pool.md`、`MemoryProxy/docs/implementation/80-credit-score-and-ranking.md`（+3 文件） |
| `111` | 111 · 打通「shadow 落库 → 池」端到端：**真库重判一个 unit**（拿首条真实条目） | `d0c9b93` · `MemoryProxy/docs/implementation/s4-smoke-design.md` |
| `113` | 113 · V2 收尾清单 + V3 边界声明（决策备忘） | 无独立提交（决策备忘）；**经 `114` 落地**（`6eefa26`）⇒ `docs/implementation/80-credit-score-and-ranking.md:62`、`s4-smoke-design.md:1023` |
| `114` | 114 · V3（S8）**冻结 + 边界声明** —— 把"暂停决定"落成有记录、可复查、可重启的形态 | `6eefa26` · `MemoryProxy/docs/implementation/00-master-spec.md`、`MemoryProxy/docs/implementation/80-credit-score-and-ranking.md`、`MemoryProxy/docs/implementation/s4-smoke-design.md` |
| `115` | 115 · V2 收尾 ②：**归因面在真库上"看不见"** —— space 口径归属与可见性 | `4f6a4d3` · `MemoryPanel/panel-api-doc.md`、`MemoryPanel/src/panel/http/routes/attribution/common.ts`、`MemoryPanel/src/panel/http/routes/attribution/pool-routes.ts`（+4 文件） |
| `116` | 116 · V2 收尾 ①：补跑 4 个 unit（首批真实影子值 + space 三层口径） —— 执行报告 | `3ace13d` · `MemoryProxy/docs/implementation/s4-smoke-design.md` |
| `118` | 118 · 会话/单元**可见性来源不一致**（events ∪ status vs 判定行）—— 归属 + 修法定案（**待拍，不就地改**） | 无独立提交（定案单）；**经 `119` 落地**（`c233acc`）⇒ `docs/implementation/s4-smoke-design.md:1046-1048` |
| `119` | 119 · 实现单：可见性来源并入 **queue**（A′）+ UI 口径（C）—— **✅ 前置全通、可开工**（D2 语义句 / D4 不回填 / F11 期望，2026-09-13 已拍） | `c233acc` · `MemoryProxy/docs/implementation/70-panel-read-and-audit-pool.md`、`MemoryProxy/docs/implementation/s4-smoke-design.md`、`MemoryProxy/src/attribution/audit-pool.ts`（+5 文件） |
| `121` | 121 · 影子度量"形态同形不可分"（116 登记的 P3）—— 归属 + 修法定案（**✅ D1–D4 已拍（2026-09-13）⇒ 可开工**） | `f2bf4f0` · `MemoryProxy/docs/implementation/50-attribution-judge-worker.md`、`MemoryProxy/docs/implementation/70-panel-read-and-audit-pool.md`、`MemoryProxy/docs/implementation/s4-smoke-design.md`（+2 文件） |
| `122` | 122 · 118 的 B（写侧治本）—— 归属**闭合** + 修法定案（**✅ D1–D4 已拍（2026-09-13）⇒ 可开工**） | `a059c07` · `MemoryProxy/docs/implementation/50-attribution-judge-worker.md`、`MemoryProxy/docs/implementation/s4-smoke-design.md`、`MemoryProxy/src/attribution/judge-queue-repo.ts`（+5 文件） |
| `129` | 129 · 50 spec §18 的"过期句"与"足迹"（同族**第四次**，文档单）—— **可开工**（无待拍） | 无独立提交（文档单）；追记行在 `docs/implementation/50-attribution-judge-worker.md:930`（§18.4） |
| `134` | 134 + 135 · brainstorm/设计的**落地**（把已冻结的登记与协议写进 repo） —— 执行报告 | `d999653` · `MemoryProxy/docs/implementation/80-credit-score-and-ranking.md` |
| `135` | 135 · (d)-2（判定切换 + 重标定）**标定协议设计** —— 先设计、不依赖真实正例（**不实现**） | `856fc41` · `MemoryProxy/docs/implementation/80-credit-score-and-ranking.md`、`MemoryProxy/src/attribution/citation/__tests__/fixtures/shadow-calibration-cases.json` |
| `136` | 136 · 正例挖掘（P-1）+ 标注（P-2）设计 **与现库基线** —— 解 (d)-2 的数据前置（**不实现判定**） | `420d50d` · `MemoryProxy/docs/implementation/80-credit-score-and-ranking.md` |
| `137` | 137 · P-1 正例挖掘**入口**实现（136 · D4 的落地）—— 小单、只读、可复跑 | `dbde35a` · `MemoryProxy/scripts/qa/positive-mining.ts` |
| `138` | 138 ｜[account] 的 max(runNorm) 主/副字段对调（**主字段必须是单射的那个**） | `a74ef95` · `MemoryProxy/docs/implementation/80-credit-score-and-ranking.md`、`MemoryProxy/scripts/qa/positive-mining.ts` |
| `139` | 139 · 第五键（auth.url）—— 执行记录的独立复核 + 裁定建议 | `571cd08` · `MemoryProxy/scripts/qa/visible-archive-coverage.ts` |
| `140` | 140 ｜让"静默失效"**自己现形**：对账入口补第三种 0 + **一行式存活自检** | `2440723` · `MemoryProxy/docs/implementation/80-credit-score-and-ranking.md`、`MemoryProxy/scripts/qa/archive-liveness.ts`、`MemoryProxy/scripts/qa/visible-archive-coverage.ts` |
| `142` | 142 ｜P0-a：**资产 → 变更/结果** 锚定（任务三第 8 项的唯一硬缺口） | 无独立提交（按单内预设终点停在 C1 量化）；登记 `docs/implementation/80-credit-score-and-ranking.md:175-185`；实现承接 `149`（`6ffd39f`，`agent.tool.change`） |
| `143` | 143 ｜P0-b：asset_validated（验证状态）的**诚实落地** | 无独立提交（停在"方案待裁定"）；登记 `docs/implementation/70-panel-read-and-audit-pool.md:257`、`80-credit-score-and-ranking.md:186` |
| `144` | 144 报告｜回执**展开层字段**补齐（任务四第 1–9 项） | `de1655a` · `MemoryPanel/src/panel/http/routes/attribution/receipt-routes.ts`、`MemoryPanel/web/src/i18n/en-US.ts`、`MemoryPanel/web/src/i18n/zh-CN.ts`（+8 文件） |
| `145` | 145 ｜P1-b：回执**摘要层** + **三档效果状态**（任务四第 10–11 项） | `e1a61c0` · `MemoryPanel/web/src/i18n/en-US.ts`、`MemoryPanel/web/src/i18n/zh-CN.ts`、`MemoryPanel/web/src/lib/api/attribution.ts`（+8 文件） |
| `146` | 146 报告｜阶段**显名** + corrected **L2/L3 触发式** + contributed **接口登记**（P2） | `7a06f19` · `MemoryPanel/web/src/i18n/en-US.ts`、`MemoryPanel/web/src/i18n/zh-CN.ts`、`MemoryPanel/web/src/pages/AttributionReceiptPage/index.tsx`（+9 文件） |
| `148` | 148｜作业后重盘：任务三 + 任务四 还差什么（对照 141，逐项看变化） | 无独立提交（盘点单）；被 `MemoryProxy/docs/implementation/70-panel-read-and-audit-pool.md:271` 引用（`148 §3 C` = 题目 Q2 依据） |
| `149` | 149 报告｜**变更 / 结果**段打通（任务三第 8 项；承接 142 · C2） | `6ffd39f` · `MemoryPanel/web/src/i18n/en-US.ts`、`MemoryPanel/web/src/i18n/zh-CN.ts`、`MemoryPanel/web/src/lib/api/attribution.ts`（+11 文件） |
| `150` | 150 ｜**C：回执"为什么适用于当前任务"一栏**（题目 Q2 / 任务四展开层） | `c4de2a6` · `MemoryPanel/web/src/i18n/en-US.ts`、`MemoryPanel/web/src/i18n/zh-CN.ts`、`MemoryPanel/web/src/pages/AttributionReceiptPage/index.tsx`（+6 文件） |

> `101`、`148` 为什么在表内：`101` 属 `154 · 事实 4` 基准（**单真实存在**、有提交，只是仓库文档里没有独立引用）；
> `148` 是**格式变体真引用**（写作 `` `148 §3 C` ``、不满足判据 A 的"反引号紧贴数字"）⇒ 补入。

## 3. 误报表：非单号命中（22 条 = 判据 B − 主表）

| 命中 | 出处 | 原文片段（截断） | 类型 / 理由 |
|---|---|---|---|
| `112` | `MemoryProxy/docs/implementation/s4-smoke-design.md:32` | `:814 / 1050-1092 / 1112 / 1142-1165 /` | 误报（非单号引用）—— 行号区间碎片（`1050-1092` / `1112` / `1142-1165`） |
| `117` | `MemoryProxy/docs/implementation/40-visible-text-archive.md:284` | `sion-unit-runner.ts（~:117-176：watermark M` | 误报（非单号引用）—— 行号区间（`~:117-176`） |
| `120` | `MemoryProxy/docs/implementation/s4-smoke-design.md:32` | `1112 / 1142-1165 / 1206 / 1330 / 13` | 误报（非单号引用）—— 行号（`1206`） |
| `123` | `MemoryProxy/docs/implementation/s4-smoke-design.md:305` | `e（anthropicHandler.ts:1238）照常打印，A1 的 P1 证` | 误报（非单号引用）—— 行号（`anthropicHandler.ts:1238`） |
| `124` | `MemoryProxy/docs/implementation/s4-smoke-design.md:40` | `context-injector.ts:106-124 ｜` | 误报（非单号引用）—— 行号区间（`context-injector.ts:106-124`） |
| `125` | `MemoryProxy/docs/implementation/attribution-base-design.md:83` | `unit-runner.ts:42,48-51,125-130 ｜` | 误报（非单号引用）—— 行号区间（`runner.ts:…,125-130`） |
| `126` | `MemoryProxy/docs/implementation/40-visible-text-archive.md:18` | `h + 归零重放**（镜像 runner.ts:126-127 判定）；§5 改**分侧` | 误报（非单号引用）—— 行号区间（`runner.ts:126-127`） |
| `127` | `MemoryProxy/docs/tdai-memory-loop-2.0.md:363` | `ndleAtomicSearch ~1192–1279、handleConversa` | 误报（非单号引用）—— 行号区间（`~1192–1279`） |
| `128` | `MemoryProxy/docs/implementation/45-bridge-telemetry-sink.md:492` | `telemetry.ts:44-46 ｜ :128-131（emit + 默认` | 误报（非单号引用）—— 行号区间（`:128-131`） |
| `130` | `MemoryProxy/docs/implementation/45-bridge-telemetry-sink.md:468` | `etchEventSink（④ 的产物）、:130 调它 ⇒ 装配**必须与 ④` | 误报（非单号引用）—— 行号（`:130`） |
| `131` | `MemoryProxy/docs/implementation/45-bridge-telemetry-sink.md:492` | `metry.ts:44-46 ｜ :128-131（emit + 默认 sink` | 误报（非单号引用）—— 行号区间（`:128-131`） |
| `132` | `MemoryProxy/docs/implementation/attribution-base-design.md:81` | `、src/handler.ts:1114-1132 ｜` | 误报（非单号引用）—— 行号（`handler.ts:1114-1132`） |
| `133` | `MemoryProxy/docs/implementation/s4-smoke-design.md:18` | `rs 静默跳过注入**（handler.ts:1330）→ 两侧都"没块"却比对通过` | 误报（非单号引用）—— 行号（`handler.ts:1330`） |
| `141` | `MemoryProxy/docs/implementation/s4-smoke-design.md:36` | `ock-archive-observer.ts:141-185 ｜` | 误报（非单号引用）—— 行号区间（`block-archive-observer.ts:141-185`） |
| `147` | `MemoryProxy/docs/tdai-memory-loop-2.0.md:365` | `3149、searchL1Vector 1470） ｜` | 误报（非单号引用）—— 数字碎片（`searchL1Vector` 1470） |
| `151` | `MemoryProxy/docs/implementation/45-bridge-telemetry-sink.md:495` | `metry.ts:44-66 ｜ :134-151（const row: Too` | 误报（非单号引用）—— 行号区间（`:134-151`） |
| `152` | `MemoryProxy/docs/implementation/attribution-base-design.md:92` | `nt.ts:10,88,106-115,142-152 ｜` | 误报（非单号引用）—— 行号区间（`client.ts:…142-152`） |
| `154` | `MemoryProxy/docs/implementation/s4-smoke-design.md:277` | `nt → <session_context>(4154)；` | 误报（非单号引用）—— 数字碎片（`<session_context>(4154)`） |
| `155` | `MemoryProxy/docs/implementation/90-work-order-index.md:96` | `spec 对照：§4.4 L155 触发面写"**工具名 / 命令文` | 误报（非单号引用）—— 行号（`§4.4 L155`） |
| `156` | `MemoryProxy/docs/implementation/attribution-base-design.md:87` | `/pipeline-worker.ts:132,156,180-186（默认值）、:` | 误报（非单号引用）—— 行号区间（`pipeline-worker.ts:132,156,180-186`） |
| `157` | `MemoryProxy/docs/implementation/90-work-order-index.md:98` | `content 与快照逐字节一致（2720 / 1577 chars）；profile/` | 误报（非单号引用）—— 数字碎片（`2720 / 1577 chars`） |
| `158` | `MemoryProxy/docs/implementation/s3-review.md:30` | `argsText = JSON.stringify(input)（99-105 anthropic、158 openai）` | 误报（非单号引用）—— **行号**：`158` 指 openai 侧 `argsText` 所在行；此项在 `154 · 事实 4` 基准内，查证后如实列为误报 |

## 4. 自检（自带、可复跑；语义 = "被引用但索引里没有" ⇒ **必须为空**）

```bash
cd <repo-root>
# 提取索引收录的单号（两张表的"命中/单号"列）
grep -oE '^\| *`1[0-5][0-9]`' MemoryProxy/docs/implementation/90-work-order-index.md \
  | grep -oE '1[0-5][0-9]' | sort -u > /tmp/idx.txt

# 判据 A：仓库文档（排除依赖包与索引自身）引用的单号 − 索引 ⇒ 必须为空
grep -rhoE --exclude-dir=node_modules --exclude='90-work-order-index.md' '`1[0-5][0-9]`' \
  MemoryProxy/docs MemoryPanel --include='*.md' | tr -d '`' | sort -u > /tmp/refA.txt
comm -23 /tmp/refA.txt /tmp/idx.txt

# 判据 B（更强）：任意 3 位数 − 索引 ⇒ 也应为空（所有碎片都已登记在 §3）
grep -rhoE --exclude-dir=node_modules '1[0-5][0-9]' MemoryProxy/docs MemoryPanel --include='*.md' | sort -u > /tmp/refB.txt
comm -23 /tmp/refB.txt /tmp/idx.txt
```

**反向（索引有、仓库没引用）允许**：`101` 即此类（`154` 基准内 + 单真实存在 ⇒ 收录并标注）。

## 5. 诚实登记（与 `154 · 事实 4` 的口径差）

- `154 · 事实 4` 写"**37 个**"，并列出 36 项 ⇒ **机械复算（判据 A 含依赖包）= 36**：差额属**计数口径**，如实登记、不凑数；
- 上述 36 项里，`158` 经查证**不是单号**（`s3-review.md:30` 的行号引用）⇒ 列 §3 误报表；
  `101` 的反引号命中只在依赖包文档里 ⇒ 保留在主表并标注（**单真实存在**，有提交 `28feabd`）；
- 另补 **`148`**（格式变体真引用 `` `148 §3 C` ``）—— 判据 A 会漏掉这类写法，故本表按上下文补入并注明依据。
