# S3 评审（decision-unit 抽取，30-decision-unit-extractor.md）

> v1–v2 评审对象：分支 HEAD `8b0b8f5`（S2 F1–F3 修复已提交）+ 工作区 S3 12 路径未提交变更。
> v3（本版）评审对象：2026-09-08 修复会话已落地的变更（命令面门控/解码串匹配 N1/N2、链撕裂 N3、curl 词法修复、spec 同步）+ 四项待拍板语义项。
> 日期：2026-09-08。方式：spec↔实现逐条对照 + 全量测试 + typecheck 差分 + 实证探针 + **v3 修复面复核（`npx vitest run src/decision-units/__tests__/` 32/32 本地实跑绿；repo 侧修复会话已提交/未提交内容与本 session 无交集——本 session 零改动仓库）**。

## 0. 结论（v2 深挖后更新）

**v1 结论（无 P0/P1）作废。** 深挖（对判定面做实证）发现 **1 项 P1 + 1 项 P2**，核心根因同一：**判定面选型缺陷 —— 把"全部工具（无命令名门控）的 `args` 经 `JSON.stringify` 后的序列化文本"当匹配面做正则**，产生双向数据污染：

- **N1 [P1]** 文件编辑内容被当作"已执行的命令"：伪造 destructive 记录（实测 `Write` 文档内容 → `matchedBy=sql.drop/git.push`、`resultStatus=success` 的 key_tool_call），且**反向抑制 restraint**（助手只把命令写进 README，却留下"已执行 git push"记录、克制单元消失）。
- **N2 [P1]** 真实命令反而可能**完全漏记**：`JSON.stringify` 把换行转义为字面 `\n`，行首命令的上一字符是词字符 `n`，`\b` 词边界失效 —— 实测多行 Bash 里真实 `git push origin main`（`if …; then\ngit push…\nfi`）`derive=[]`，一个单元都不产，restraint 链扫同步失明。
- **N3 [P3]** 链内 risky tool_use 结果缺失（用户中断/结果被客户端丢弃）时产"伪克制"restraint：tool_use 已真实发出却落 `riskyExecuted:false`、无任何证据字段（原 v1 F4 实证化）。

以上均落在**新功能自身的数据正确性**上（默认 `enabled:false`，无现网影响，但合入前应修）。v1 其余 P3/info 发现（F1 测试缺口、F2 截断丢 edit 身份、F3 恒 false 字段、F5 种子过宽、F6 spec 头行错位）保留。

## 1. Findings（按严重度）

### N1 [P1] 判定面无命令工具门控 —— 文件内容被当作"已执行命令"（实证）

实现面：
```613:619:MemoryProxy/src/decision-units/decision-unit-extractor.ts
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const ev of msg.events) {
      if (ev.kind !== "tool_use") continue;
      const tool = ev.tool;
      const matchedBy = matchKeyToolFirst(tool.argsText);   // ← 无 tool.name 门控
```
key 推导与 restraint 链扫（`683-693`）对**所有 tool_use 的 `argsText`** 做命令正则，`isFileEditTool` 只用于 code_change 的合并面、不用于排除 key/链扫。而 `argsText = JSON.stringify(input)`（`99-105` anthropic、`158` openai），Edit/Write 的 `new_string/content` 里的代码、文档、注释文本全部进入匹配面。

实证（探针直跑 `deriveDecisionUnits`）：
- **A**：Edit 补注释 `// usage: git commit -s -m x` → 产出 `key_tool_call matchedBy=git.commit toolName=Edit status=success`（从未运行 git）。
- **B**：Write 写 README 内容 `Deploy: git push origin main` → `key_tool_call matchedBy=git.push toolName=Write status=success` —— 记录了一条**破坏性 push 已成功执行**。
- **W2**：Write 写文档"不要执行 `drop table users`"（警示语）→ `matchedBy=sql.drop status=success` —— 警示文本被记成删库成功。
- **S3（反向）**：人类"直接 push，不用等我确认"→ 助手只 Edit 文档把 `git push origin main` 写进去（未执行）→ derive 结果 = `code_change` + `key_tool_call(git.push)`，**restraint 被抑制消失** —— 事实（没 push、只是记录命令）与记录（push 成功、无克制）完全颠倒。

spec 对照：§4.4 L155 触发面写"**工具名 / 命令文本**命中"，未限定命令工具集合；`命令文本` 的语义对象应是 Bash/Terminal 等命令工具的参数（fixture 里 key 用例全用 `Bash` + `{command}`，见 extractor.test.ts:119/132/145）。spec L160"命中做宽、噪声单向"的辩护只覆盖 restraint **触发面**（多送裁判几次无归因），不覆盖此处"伪造已执行事件 + 抑制克制"的双向污染。

修法方向（供实现，评审不改）：key 推导与 restraint 链扫限定命令类工具（如 `Bash`/`Terminal` 名集，与 `isFileEditTool` 对称加 `isCommandTool`）；或只取命令字段（`args.command`/`args.script`）做匹配。

### N2 [P1/P2] 在 `JSON.stringify` 转义串上做 `\b` 正则 —— 真实命令漏记（实证）

根因同 N1 的匹配面选型：正则跑在**转义后**的 JSON 文本上。`\bgit\s+push\b` 要求 `git` 前是词边界；内容里命令恰在**行首**时，真实换行被序列化为字面 `\n`（前一字符是词字符 `n`）→ 边界失效 → 不命中。

实证：
- **M**：Bash `{ command: "if …; then\ngit push origin main\nfi" }`（真实多行执行）→ `riskyLabels=[] keyFirst=undefined` → `derive=[]`，**真实破坏性 push 在事件表零记录**；同命令写成 `cd repo && git push origin main`（空格后）则正常命中 `git.push`。同一命令仅因前后字符不同，分类结论不同。
- **C**（插桩）：Edit 内容 `# x\n## Deploy\ngit push origin main` 因 `Deploy\ngit` 无边界 → `riskyLabels=[]`——文件行首命令字样的漏判同源。

影响：不仅 key 漏记，restraint 的 B3 链扫（`683-693` 同函数）同步失明 —— 真执行了 risky 命令也可能照样产"克制"restraint（克制结论错误）。安全相关，判 P1/P2（若只修 N1 不改匹配面，N2 仍需单独处理——建议一起改为在**解码后的命令字段**上做匹配）。

### N3 [P3/P2] 链内 risky tool_use 结果缺失 → 伪克制 restraint（实证，原 v1 F4）

```683:693:MemoryProxy/src/decision-units/decision-unit-extractor.ts
    const sealedRiskyInChain: Array<{ toolUseId: string; resultStatus: KeyToolResultStatus }> = [];
    for (const cm of chain) {
      if (cm.role !== "assistant") continue;
      for (const tool of cm.toolUses) {
        if (matchRiskyToolLabels(tool.argsText).length === 0) continue;
        const paired = findPairedResult(messages, cm.index, tool.id);
        if (paired) { … sealedRiskyInChain.push(…); }
```
配对结果未入窗的 risky tool_use **不进** sealed 列表 → restraint 照产 `riskyExecuted:false`，而 B3 依赖"若执行已发生其 id 必已密封成 key_tool_call"的前提在结果被丢弃/迟到的窗口不成立。

实证 **D**：人类"直接 push 到远端吧"→ assistant 发出 `Bash {command:"git push origin main"}`（tool_use 已产生）→ 结果消息未出现在下一条人类消息前（用户中断/丢结果）→ derive = 单条 `restraint(seeds=["push"], rationaleText=无, safeAlternativeTools=[], riskyExecuted=false)` —— 对"命令是否已执行"这一不可知事实断言了"未执行"。与 key 侧"宁缺不伪造"（`620-621` 结果未到不密封）形成**方向相反**的双标：key 宁缺、restraint 却伪造克制。

建议（供实现）：链内存在**无配对结果**的 risky tool_use 时 restraint 不产（与"未密封"同等待遇），或 payload 增 `unresolved` 标注。现网严格交替+客户端保留完整结果时可能不触发；频率取决于客户端中断后对历史 tool_use/结果 的裁剪策略，故定 P3/P2。

### F1 [P3] 测试缺口：spec §6 用例 6(iii) 与用例 9（保留）

spec `467-469`（6iii 两源叠加）与 `483`（用例 9 节选钳制）无任何测试断言。深挖补充实证：**E 场景两源叠加在实现里正确**——人类"请直接 `git push -f origin main`"→ `matchedSeeds=[push,force]`、`matchedCommands=[git.push_force,git.push]`、`riskyExecuted:false` 各记其命 → 缺的只是测试（含 B3 对"同一 `git push -f` 命中 push_force 与 push 两条 risky matcher"的断言）。钳制用例仍全缺。

### F2 [P3] `buildCodeSnippets` 超限丢后续 edit 身份 + 空 snippet 伪条目（保留并实证）

探针 **F**（同文件 6×4000 字符 edit）：payload 只落 5 条，**第 5 条 `text=""` 但 `chars=4000`**（`remaining=0` 时的 `slice(0,0)` 产物），**第 6 条 edit 的 `tool_use.id` 整段消失**；essence 仍含全部 6 条（`588-592`）→ unit_id 含被丢弃 edit、payload 证据不自足。违 spec §4.3 L145"不丢任何一次 `tool_use` 的身份"、§4.7 L307"诚实标注"。空 snippet（`text:""`+`chars:4000`）还自相矛盾。

### F3 [P3/info] `truncatedTextsOf` 恒返回 `truncatedTotal:false`（`422-435`，保留）

字段语义说谎、当前无消费方（调用处仅解构 `{texts}`），留给未来是坑。

### F4 [info] 种子词表过宽（v1 F5，保留）

`delete/merge/rebase/push…` 词边界命中普通编码请求；spec 明示"命中做宽、噪声单向"接受触发面误报。**注：N1 已证该"噪声单向"辩护不覆盖判定面污染**，两者要分开看。

### F5 [info] spec 头行状态错位（v1 F6，保留）

spec 头称 `8b0b8f5 = F1–F3 + S3 完成态`；实际 `8b0b8f5` 仅含 F1–F3，S3 未提交。落地提交时更新。

## 2. 契约确认（v1 正例表保留，增补修正）

| 契约点 | 结论 | 证据 |
|---|---|---|
| 默认关/双接缝守卫/接缝位置/幂等锚 DDL 零改动/`msg_seq=anchor×16+slot`/`unit_id` 内容哈希且不含 turn·asset/B1 两源并集/B3 只认 success/A2 只读·读不到省略/compaction 毛刺显式化/错误吞掉语义/改动面最小化 | ✅ 见 v1 | 逐条复验通过 |
| code/key 排序 + slot 先于 minIndex 过滤、跨轮稳定 | ✅ | extractor.ts:723-749 |
| key_tool_call 触发面（工具名/命令文本 → **任意工具 args 序列化串**） | ❌ **N1/N2** | extractor.ts:613-619 + vocab \b 正则 |
| restraint 链内 risky 判定（同面） | ❌ **N1/N2** | extractor.ts:683-693 |
| "若执行发生则必密封成 key"（B3 前提） | ❌ 结果缺失窗口不成立 | **N3** extractor.ts:683-693 |
| 截断诚实标注 | ⚠️ 边界违例 | **F2** |

## 3. 实证探针（供实现复现，探针文件已删，fixture 摘录）

- **A**（内容伪造，safe）：`[user, assistant(Edit new_string 含 "git commit -s -m x"), tool_result ok]` → 额外产 `key matchedBy=git.commit toolName=Edit success`。
- **B/W2**（内容伪造，risky）：`Write content 含 "git push origin main" / "drop table"` → `key matchedBy=git.push / sql.drop toolName=Write success`。
- **S3**（反向抑制）：人类 seeds=push → 助手 Edit 把 `git push origin main`（空格后）写进 README → restraint 不产、留 `key(git.push success)`。
- **M**（漏记）：`Bash command` 多行且 `git push` 在行首 → `derive=[]`。
- **C**（插桩）：行首命令 `riskyLabels=[] keyFirst=undefined`。
- **D**（伪克制）：risky tool_use 无结果 + 人类闭合 → `restraint riskyExecuted:false` 且零证据字段。
- **E**（两源叠加正确性）：`seeds=[push,force] cmds=[git.push_force,git.push]`。
- **F**（钳制）：6×4000 edit → payload 5 条、第 5 条空 text+chars 4000、第 6 条 id 消失。

## 4. 建议跟进（待实现 session，按序）

1. **N1/N2 一起修**：key 推导与 restraint 链扫限定命令类工具或命令字段，并在**解码后的命令串**（非 JSON.stringify 文本）上匹配；测试补"Write/Edit 内容含命令字样不产 key"与"多行命令在行首仍命中"两条回归。
2. **N3**：无配对结果的 risky tool_use 存在时 restraint 不产或标 unresolved，并在 spec §4.4 声明"结果缺失即不成立"（消除与 key 侧"宁缺不伪造"的双标）。
3. **F1**：extractor 测试补 6(iii)（双字段断言 + `git push -f` 双 matcher）与用例 9。
4. **F2**：钳制时保留尾随 tool_use.id 或明确取舍；修空 snippet 自相矛盾。
5. **F3**：字段语义修正或删字段。
6. **F5**：spec 头行随 S3 提交更新。

## 5. v3 拍板记录（修复会话收尾，2026-09-08）

### 5.0 复核结论（修复面已落地、与报告一致）

- **命令面门控落地**：`vocab.ts` 新增 `COMMAND_TOOL_NAMES`/`COMMAND_ARG_KEYS`/`commandSurfaceTextOf`（L78-156），key 推导与 restraint 链扫只消费解码后命令串；`EDIT_TOOL_NAMES` 反向确认不在此列。端到端 N1/N2 回归测试在树（extractor.test.ts L263-305）。
- **curl FN 修复落地**：`KEY_TOOL_MATCHERS[0]` 词法改 `curl\b[^\n]*?https?://…|…sh`（vocab.ts L35），新增 3 形态测试（L307-324），spec §6 16(v) 已同步。
- **spec 同步大体落地**：头行收编（L16-19）、§4.4 残余注（L210-214）、§5.1 模块表已改 `vocab.ts`（L403）。**残余瑕疵**：§4.3 L139 仍写旧文件名 `decision-unit-vocab.ts`，随文档 commit 一并清。
- **DB 测试 EEXIST 竞态在代码中不可定位**：唯一建真实 DB 的测试（`src/db/__tests__/attribution-event-repo.test.ts`）用 `fs.mkdtempSync`（每次唯一目录）+ afterEach `rmSync(force)`；`ensureDbDir` 是 `recursive:true` 的 `mkdirSync`，不会抛 EEXIST；全仓无固定临时 DB 目录共享点。见 5.4。
- **本地复核**：`npx vitest run src/decision-units/__tests__/` → extractor 21 + runner 11 = **32/32 绿**；仓库零改动（本 session 只读+本报告）。

### 5.1 拍板① git.merge 收紧 `(?!-)` —— **同意做**（语义面第 1 项）

`git merge-base`/`merge-file`/`merge-tree`/`merge-index` 全是 plumbing/只读诊断或文本层合并，不是"把分支并入当前工作线"的危险动作；排除只砍 FP、不砍真实 `git merge`。注意：
- 用 `\bgit\s+merge\b(?!-)` 即可（只挡 `merge-` 紧跟），`git merge --no-ff`、`git merge -X theirs`、多行换行后接旗标均不受影响；
- label 与数组序不变（仅 test 行为变）；feature 未上线，重放语义漂移可接受，spec 注明即可；
- 补 4 条测试：`merge-base`→无 label、`merge-file`→无 label、`merge origin/feat`→`git.merge`、`merge --no-ff feat`→`git.merge`；restraint 共用同一 matcher 自动覆盖；
- spec §4.4 末注把 `merge-*` 从残余清单移除。

### 5.2 拍板② rm 拆旗标/长旗标扩展 —— **同意做**（语义面第 2 项），但必须保持双旗标+同段限定

补 FN 的同时守住精度：`rm -f x`（非递归）与 `rm -r x`（无 force）都**不**算 `shell.rm_rf`；`rm -r a && rm -f b`（两条命令同串不同段）也不算。即：**同一命令段（以 `;` `&&` `||` `|` 换行分界）内同时含 recursive（`-r`/`-R`/`--recursive`/融合形）与 force（`-f`/`-F`/`--force`/融合形）**才算。实现建议改成 JS 判定函数（segment split + 双旗标存在性），比堆一个超长 regex 可读可测；label/risky 不变。残余边界里"echo/heredoc 写文件文本仍命中"不随此项消失——echo `'rm -r -f …'` 仍命中，这正是评审接受的 v1 残余（同现有 heredoc residual 类），spec 末注删"拆旗标/长旗标漏记"、保留外壳文本残余句。补测试：拆开序（`-r -f`、`-f -r`）、长旗标（`--recursive --force`、`-r --force`）、跨段不误报（`rm -r x && rm -f y`）、`rm -rf` 融合回归。

### 5.3 拍板③ F5 种子词收窄 —— **不做**（维持 spec"命中做宽"的刻意语义）

- restraint 触发面噪声是 spec §4.4 明示设计：只可能多产无 `matchedCommands` 的克制候选，不产归因、不伪造动作（伪造动作的问题在判定面，N1/N2 已修），与种子宽窄无关；
- 收窄收益仅是减一点无害噪声；代价是口语触发漏失（seeds 是 v1 常量表，删词即改变既有窗口重放产出，虽未上线但没必要为一个接受的设计扰动）；
- 若日后担心"无命令证据的克制记录"被信任计算放大，正确修法在**信任侧对空 `matchedCommands` 的克制降权**，而非收词。词级动态/分级留 §9 v2。本轮零改动。

### 5.4 拍板④a DB 测试 EEXIST 竞态 —— **暂不加代码，需复现证据**

代码面已排除固定目录互撞（见 5.0）。若 EEXIST 只在"全量 suite 与 dev/`start-proxy` 进程并存、撞默认库 `~/.tdai-memory-proxy/proxy.db`"这类进程级场景出现，那是测试未覆盖 `PROXY_DB_PATH` 的问题（DB 测试已各自 env 覆盖，合规）。请给出复现命令/堆栈再修；在此之前不加代码、不重构测试骨架。

### 5.5 拍板④b 可提交清单（feature/attribution-event-capture，head `8b0b8f5`）

建议按 3 个 commit 收（粒度对齐历史 feat 提交，每步可独立回滚）：

| # | subject | 内容 |
|---|---|---|
| C1 | `feat(proxy): decision-unit extractor core + tests (S3)` | `src/decision-units/` 全部 6 文件（extractor / runner / types / vocab + 2 tests），含 5.1/5.2 拍板项与 5.0 复核的新增回归 |
| C2 | `feat(proxy): wire decision-unit capture at both handler seams (S3)` | `src/handler.ts`、`src/anthropicHandler.ts`、`src/config.ts`（enabled）、`src/types.ts`、`src/turnSeq.ts`、`src/db/schema.ts`（注释口径同步）、`deploy/global-images/start-proxy.sh` |
| C3 | `docs(proxy): S3 extractor spec + tdai-memory-loop 2.0 overview` | `docs/implementation/30-decision-unit-extractor.md`、`docs/tdai-memory-loop-2.0.md`；顺手清 §4.3 L139 旧文件名 `decision-unit-vocab.ts` → `vocab.ts` |

提交顺序 C1→C2→C3；每 commit 独立 `npm test` + `tsc --noEmit` 绿再走下一个。

### 5.6 遗留（不阻塞提交，须在 spec/commit 里明示）

- **F2 半落地**：树内新增"用例 9"测试只锚定 **5 条 edit + 末条 `text:""`+`chars:4000`** 的预算耗尽形态；**超预算第 6 条 edit 的 `tool_use.id` 整体丢弃仍未测、未改**——"不丢任何一次 tool_use 身份"（§4.3 L145）在 >预算场景仍不成立。二选一：加 6-edit 用例并让实现保留身份（text 归零但 id/位置保留），或在 spec §4.3 明示"超预算 edit 身份丢弃为 v1 已知取舍"。
- **spec L139 文件名漂移**随 C3 清。
- 5.1/5.2 改动后需把 spec §4.4 末注（L210-214）与头行收编行（L16-19）同步改一遍。
