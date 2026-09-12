# S4 真实 HTTP 冒烟 — 设计 / 交接任务书

> 定位：把 40 spec §8.3「转发前 `injectedBody` 字节硬比对」从**等价层**搬到**真链路**。
> 关系：本文件是 `s4-smoke-checklist.md` 的**收敛 + 修正**；checklist 给形态与断言面，本文件给方案选型、分期、交接契约。
> 边界：**不改生产代码**。coding 交给另一个 session，本文只做设计。

---

## 0. TL;DR

| 问题 | 结论 |
|---|---|
| 要做什么 | 用真 HTTP 请求打真 proxy，从**上游 stub 收到的 rawBody**偷注入结果，与**归档还原串**按同规则剥离后逐字节比对 |
| 怎么做最好 | **vitest 集成测试**（真 listen + 真 fetch + 内嵌 `node:http` stub），不是手工 curl 脚本 |
| 为什么不用 dump | `PROXY_DEBUG_DUMP_BODY` 只在 **openai 侧**存在（`src/handler.ts:313`），anthropic 侧没有正文字节 → 用 stub 比加 dump 更干净且零侵入 |
| 交付物 | 1 个主测试 + 2 个 helper（stub / 归因窗口），约 400–600 行，落在 `src/injection/__tests__/` 下以进 vitest include |
| 分期 | S4a 接缝 B 最小闭环 → S4b 加接缝 A 渲染块 → S4c（可选）compaction / cap |
| 最大风险 | **空 injectors 静默跳过注入**（`handler.ts:1330`）→ 两侧都"没块"却比对通过 = 假绿。断言必须含正向证据 |
| **已定** S4 归属 | **进默认 `npm test`**（CI 需允许 loopback bind）；若 CI 不稳再拆 `npm run smoke:s4` |
| **已定** R1 处置 | **不靠"记工单"**（会忘）→ 登记进 `known-drift.ts` + `it.fails` 双向 tripwire，详见 §5.5 |

---

## 1. 源码事实（决定设计，逐条已核实）

| # | 事实 | 证据 |
|---|---|---|
| F1 | app 是工厂 `createApp(config): Hono`，不导出单例；`index.ts` 用 `@hono/node-server` 的 `serve({fetch, hostname, port})` 启动 | `src/server.ts:19-20`、`src/index.ts:107`、`src/index.ts:133-140` |
| F2 | 上游 URL 链：`upstream.agents[<URL第一段 agent>].url` ?? `costGuard.anthropicUpstream.url`（仅 anthropic）?? `upstream.url`；默认字面量 `https://llm-upstream.example.com/v2/chat/completions` | `src/config.ts:7,16,289-296`、`src/handler.ts:1370-1394`、`src/anthropicHandler.ts:1274-1278` |
| F3 | `joinUrl` 在 base 已以 `/messages` 或 `/chat/completions` 结尾时**直接用 base**，否则拼白名单端点 | `src/guard-adapter.ts:326-366` |
| F4 | 注入三重门控：`!injectedSkipped && injection.enabled && injectors.length > 0` | `src/handler.ts:1330` |
| F5 | 时序：session-init → **档① 接缝 B 捕获** → decision-unit 抽取 → **档② 归档** → mem-reset → **pipeline 注入** → 转发 | `handler.ts:814` / `1050-1092` / `1112` / `1142-1165` / `1206` / `1330` / `1387` |
| F6 | 档② 拿的是**注入前**的 messages，并丢弃 `role==="system"` | `src/decision-units/message-increment-archive.ts:199-249` |
| F7 | 档② epoch 判定：`messageCount < lastSeen` → `epoch+1, last=0` | `src/decision-units/message-increment-archive.ts:212-216` |
| F8 | 档① 接缝 B **两侧都有**：anthropic 用 `initResult.systemAppend`（与合入 `body.system` 的**同一字符串**）；openai 侧**重建** `buildSessionContextBlockWithToggles(agentDetail, taskDetail, ...)` | `src/anthropicHandler.ts:939-962`、`src/handler.ts:1050-1092` |
| F9 | 档① 接缝 A = `VisibleBlockArchiveObserver.onHookDone`，要求 `meta.sessionKey` + `number` 型 `turnSeq` + 非空 `blocks` | `src/injection/visible-block-archive-observer.ts:141-185` |
| F10 | 装配门控在 **observer 选择段**：`if (config.injection?.visibleArchive?.enabled) observers.push(new VisibleBlockArchiveObserver(...))`；observer 自身无门控 | `src/injection/index.ts:419-425`（**勘正 2026-09-10**：原文写 `pipeline.ts:415-434`，该文件 grep `visibleArchive` 零命中，系设计侧笔误） |
| F11 | 档② 调用点守卫 = `decisionUnitExtractor.enabled === true`（与 extraction 同区同守卫） | `src/handler.ts:1148`、`src/anthropicHandler.ts:1027` |
| F12 | 两侧"追加算术"**同构**：string → `${sys}\n\n${block}`；array → push `{type:"text",text:block}`（不带 `cache_control`）；未知/null → 直接替换为 block | `src/session/context-injector.ts:80-96`、`:278-287` |
| F13 | openai 侧 session-context 落在**第一条 system message**（无 system message 则在头部插入一条） | `src/session/context-injector.ts:106-124` |
| F14 | 四表：`attribution_block_text`(`content_hash` UNIQUE) / `_block_seen` / `_message_snap`(`UNIQUE(session_key,epoch,message_index)`) / `_archive_watermark`(`session_key` PK) | `src/db/schema.ts:101-145` |
| F15 | 读 API：`windowVisibleText(repo, sessionKey, opts) → {epoch, pieces[]}`（pieces 含 `tier/turnSeq/seq/source/content/chars/truncated`）；`archiveVisibleText(repo, sessionKey) → {epochs, pieces}` | `src/db/visibleTextRepo.ts:488-560`、`:551` |
| F16 | repo 是单例，但 **可注入**：`getVisibleTextRepo()` / `setVisibleTextRepo(repo)` / `__resetVisibleTextRepoForTests()` | `src/db/visibleTextRepo.ts:411-428` |
| F17 | DB 路径：`PROXY_DB_PATH` > `~/.tdai-memory-proxy/proxy.db`；单例 + 懒初始化 | `src/db/index.ts:18-36` |
| F18 | auth 关 → `verifyUserKey` 返回 `{userId:"", rejected:false}`（不拒绝）；userId 兜底链 `x-user-id` → `x-cb-user-id` → `x-tdai-user-token` → `""` | `src/auth.ts:34-46,70-73`、`src/handler.ts:671-675` |
| F19 | session-init 可跳过全部交互表单：`sessionInit.debugForceIdentity`（三元组）；userId 可用 `sessionInit.debugForceUserId` 强制 | `src/session/claude-code/init.ts:632-683`、`src/handler.ts:677-684` |
| F20 | 启动 session-context 详情仍需内核：`metadataClient.getAgent` / `getTask` / `appendParticipationLog` | `src/session/claude-code/init.ts:422+`（内 68/75/99 行）、`src/meta/client.ts:294,299,390` |
| F21 | vitest include **只认** `src/__tests__/**` 与 `src/**/__tests__/**`；现有 15 个测试文件全在 `src/**/__tests__/`；无 `supertest`/`nock`/`msw` 依赖 | `vitest.config.ts:7`、`package.json:37-44` |
| F22 | `[injection-debug]` **无条件**打印（每请求一行，含 `injectionEnabled=` `injectors=` `injectedSkipped=`）；`[visible-archive]` **只在 catch 分支**打印 | `src/handler.ts:813`、`src/anthropicHandler.ts:727`、`src/anthropicHandler.ts:956-961`、`src/handler.ts:1160-1164` |

---

## 2. 三个关键风险（S4 的真正价值所在）

### R1 — openai 侧是"重建"而非"复用"，存在结构性漂移

- anthropic：`recordSessionContextBlock({ content: initResult.systemAppend })`，而合入 `body.system` 用的是**同一个字符串**（`appendBlockToAnthropicSystem(body.system, initResult.systemAppend)`）→ 天然逐字节，S4 主要验"没漏档"。
- openai：归档侧**重新调用** `buildSessionContextBlockWithToggles(initResult.agentDetail, initResult.taskDetail, config.sessionInit, sessionKey)`（`handler.ts:1063`），而实际注入走 `injectSessionContextWithToggles(messages, agentDetail, taskDetail, ...)`（`handler.ts:875-879` / `session/codebuddy/init.ts:358`）。
- 只要 `agentDetail/taskDetail` 来源、toggles 取值、`bypassed` 判定任一处不一致，**归档块 ≠ 实际注入块**。

→ 这是 S4 最该抓的 bug 面，也是"真链路"相对等价层唯一能多验的东西。

### R2 — 档②/档① 语义互补，"还原 injectedBody"必须走 §3a 归因，不能天真拼接

- 档② 存**注入前**消息流（且丢 system 行），档① 存**注入内容**（渲染块 + session-context），excluded（客户端 system 原文）**不入档**。
- 所以 `windowVisibleText()` 的 `pieces` **不等于** injectedBody；必须按 §3a 归因表把 `excluded + 档① + 档②` 重组成 injectedBody 再比对。

→ 硬约束：**归因/剥离规则必须与 golden 装置共因**（提到共享 helper），否则两套规则各自自洽 → 假绿。

### R3 — 空注入会假绿

`injectors.length > 0` 是注入的**必要条件**（`handler.ts:1330`）。若配了空的/不产块的 injector，上游 body 没有渲染块、归档也没有块，两边"完美一致"但什么都没验证。

→ 每条用例必须同时断言**正向证据**：`attribution_block_seen` 至少 1 行（且 `hook_id` 符合预期）+ 上游 rawBody 里确实含 `<session_context>`（`context-injector.ts:38-39`）。

---

## 3. 方案评估

| 维度 | A 手工脚本 + curl | **B vitest 集成测试（推荐）** | C 生产代码加 dump 钩子 |
|---|---|---|---|
| 真实性 | 高（真端口真 curl） | 高（真 `listen` + 真 `fetch`，仅进程内） | 高 |
| 可回归 | 无（人跑，易腐化） | **有**（进 vitest include → `npm test`） | 无（仍要人比对） |
| 隔离 | 需手工清 `/tmp` | 随机端口 + 临时 DB + repo 注入 | 无隔离 |
| 对生产侵入 | 0 | **0** | 需给 anthropic 侧新增 dump（openai 侧已有） |
| 诊断力 | 最强（可随意 curl） | 中（失败需看断言 diff） | 中 |
| 成本 | 低 | 中（约 400–600 行） | 低但不可持续 |

**推荐 B，理由**：S4 的验收价值只有在"以后每次改动都能重跑"时才成立；A 的价值（随手 curl）用 `npx vitest run -t <name>` 基本等价保留。

**B 的关键实现要点（易踩）**

1. **端口用 0**：`createServer(app.fetch).listen(0)` 再取 `server.address().port`；上游/kernel stub 同样 `listen(0)`。硬编码端口会在并行 worker 下偶发冲突。
2. **DB 隔离双保险**：`PROXY_DB_PATH` 指向 `mkdtemp` 临时目录 **且** 在 beforeAll 用 `setVisibleTextRepo(new SqliteVisibleTextRepo(tmpDb))` 显式注入（`visibleTextRepo.ts:419`）。原因：db/repo 都是**模块级单例**（`db/index.ts:21`、`visibleTextRepo.ts:411`），env 时序不可靠。
3. **config 直接构造对象**，不落 yaml 文件。配置解析本身已由 §8.5 的 toggle 矩阵覆盖；S4 造 yaml 只会引入第二处配置漂移源。（诚实边界要写进注释）
4. **归因逻辑共因**：把 golden 装置里的"从归档重建 injectedBody + 剥离胶水"提成 `src/injection/__tests__/_helpers/attribution-window.ts`（**非** `.test.ts` 后缀，不会被 vitest 当用例收集），golden 与 S4 同时 import。若不动 golden 文件，至少在 S4 内注明"与 golden 同源，改一处必须同步另一处"。
5. **stub 只回合法响应**：非法响应会触发重试/降级分支，让 body 对比失真。

---

## 4. 分期

### S4a — 接缝 B 最小闭环（先打通链路）

- **stub 需求**：上游 stub（18701/18702 等价物，记录 rawBody）+ kernel stub 两个端点 `POST /v3/meta/agent/get`、`POST /v3/meta/task/get`（可选 `participation-log/append` 回 200）。
- **config 要点**：`auth.enabled=false`；`sessionInit.enabled=true` + `debugForceIdentity{team,agent,task}` + `debugForceUserId`；`injection.enabled=true`；**`injectors=["knowledge"]` 且保持 `knowledge.enabled=false`**（**勘正 2026-09-10**：原文写 `injectors=["skill"]`。`SkillToolsInjector` 在 `src/injection/index.ts:319` **无条件注册**且**总是产出** `<skill_tools>` 块 → anthropic `serializeSystemMessage`（`textBlocks.length===1 ? string : array`）会把 `body.system` 变数组，A1 的 string 等值断言必红。`["knowledge"]` + disabled 走 `shouldRegisterKnowledgeInjector=false`（`src/injection/index.ts:515-524`；默认 `knowledge.enabled=false` 见 `src/config.ts:140-141`）⇒ gate 的 `injectors.length>0` 满足、注册表为空、零 hook 产块，才真正做到"只验接缝 B"）；`decisionUnitExtractor.enabled=true`（档② 才跑）；`visibleArchive.enabled=true`。
- **用例**：
  - A1 anthropic + string system → 断言上游 `body.system` == `excluded + "\n\n" + 归档块`，且 `block_seen` 有 1 行 `source=session.context`。
  - A2 anthropic + array system（末块带 `cache_control`）→ 断言数组长度 +1、末块为 plain text block、原块与 `cache_control` 未动（F12）。
  - A3 openai → 断言 `messages[0]`（system）内容 == `excluded + "\n\n" + 归档块`，**且归档块 == 实际注入块**（R1 的正面验证）。
- **负例**：**勘正 2026-09-10**（原文"上游 body 无 `<session_context>` 且四表 0 行"**不成立**）：`injectors=[]` 只关掉注入 pipeline，而接缝 B 在 handler 的 session-init 分支、**先于** gate 执行，故上游**仍含** `<session_context>`、档① 仍有 session-context 行。正确的 pin 是三件事：首行 `injectors=[]` + **无** `entering injection pipeline` + **渲染块档① 行数 = 0**（过滤 `source !== "session.context"`，依据 `schema.ts:103`：`source = block.metadata.source ?? hook.id`，合成块即 `session.context`）。

### S4b — 接缝 A（渲染块进真链路）

- kernel stub 增加 `POST /v3/skill/search` 返回 1 条确定资产 → 断言：`block_seen` 多 1 行（`hook_id=skill`）、上游 body 含该块文本、pieces 重建后与上游一致。

### S4c — 可选加厚

compaction（档② `epoch` 递增 + `archiveVisibleText` 超集）、超 cap 截断（`truncated=1` + `chars=原长`）。

---

## 5. 交接任务书（给 coding session）

### 5.1 文件清单与职责

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `src/injection/__tests__/visible-archive-http-smoke.test.ts` | S4a/S4b 用例主体：起 proxy + 2 stub，发请求，断言 | 无（测试文件） |
| `src/injection/__tests__/_helpers/s4-stubs.ts` | `startUpstreamStub(protocol)` / `startKernelStub(assets)`：`node:http` + `listen(0)`，记录 `{path, headers, rawBody}`，暴露 `requests[]` 与 `close()` | `UpstreamStub`、`KernelStub` |
| `src/injection/__tests__/_helpers/attribution-window.ts` | 从归档重建 injectedBody（§3a 归因表）+ `stripGlue()`；与 golden 共因 | `rebuildInjectedBodyFromArchive(repo, sessionKey, {excluded, protocol})`、`stripGlue(s)` |
| `src/injection/__tests__/_helpers/known-drift.ts` | **已知漂移的唯一权威登记表**（R1 若坐实的容器）：id / 工单号 / 文档锚点 / 现象摘要；用例由它**生成**而非手写（§5.5） | `KNOWN_DRIFT` |

### 5.2 接口契约

**上游 stub**
- 记录：`{ path, headers, rawBody }` 追加到 `requests`（不做解析，断言侧自己 `JSON.parse`）。
- 响应：`content-type: application/json`；anthropic 回 `{type:"message",content:[{type:"text",text:"ok"}],usage:{...}}`；openai 回 `{object:"chat.completion",choices:[{message:{role:"assistant",content:"ok"}}]}`。
- 所有 fixture 用 `stream:false`。

**kernel stub**
- `POST /v3/meta/agent/get` → `{code:0,message:"ok",data:<AgentEntity 本体>}`；`/v3/meta/task/get` 同构（**勘正 2026-09-10**：原文猜的 `data:{agent:{...}}` 多包了一层。`MetadataClient.getOne` 直接 `return env.data`（`src/meta/client.ts:472-479`、`:562-566`），包错一层**不报错**，只会让 detail 字段静默 `undefined` → 空块 → 假绿。另：`TaskEntity` 只有 `title`、**没有** `name`（`src/meta/client.ts:74-82`），下游映射是 `name: task.title`（`src/session/store.ts:579`），故 fixture 给 `title` 即可）。
- 响应字段名以真实 `MetadataClient` 的解析为准：**先按 `src/meta/client.ts:294-300` + `getOne` 的拆包规则读一遍再定形**，别照抄本文件的猜形。
- S4b：`POST /v3/skill/search` → 空列表（S4a）/ 1 条资产（S4b）。

**helper 契约**
```ts
// 与 golden 同源：excluded(不入档) + 档①(block_seen) + 档②(message_snap, epoch=水位)
function rebuildInjectedBodyFromArchive(
  repo: VisibleTextRepo,
  sessionKey: string,
  opts: { excluded: string; protocol: "anthropic" | "openai" },
): { anthropicSystem?: string; openaiMessages?: unknown[] };

// 只剥"接缝胶水"：string 拼接的 "\n\n"，以及 openai system message 内同规则拼接
function stripGlue(text: string): string;
```

**known-drift 登记表契约**（防遗忘机制的权威源，§5.5）
```ts
export interface KnownDrift {
  id: string;            // 例 "openai-session-context-rebuild"
  ticket: string;        // 工单号 / 稳定引用串
  doc: string;           // 仓库内相对路径 + 锚点，例 "s4-smoke-design.md#r1"
  summarize(): string;   // 一句话现象，进用例名
}
export const KNOWN_DRIFT: KnownDrift[];   // 无漂移时 = []
```

### 5.3 五条纪律

1. **不改生产代码**；若发现必须改（例如 R1 坐实为 bug），**登记进 `known-drift.ts`（§5.5）——禁止只写进聊天或文档**，不在 S4 里顺手修。
2. 每条用例必须含**正向证据**（`block_seen ≥ 1` 且上游 body 含 `<session_context>`），否则判为无效用例。
3. 归因/剥离规则 **与 golden 共因**，禁止第二套实现。
4. 端口 0 + 临时 DB + `afterAll` 清理；**绝不触碰** `~/.tdai-memory-proxy/proxy.db`。
5. 不得用 `[visible-archive]` 日志作为成功证据（它只在 catch 打印，F22）。

### 5.4 验收命令与预期

```bash
# 前置：必须用 node 22（实测 v22.19.0）；node 24 会因 better-sqlite3 ABI 不匹配假红 48 例
PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH" npm test  # 基线 237/237（15 文件，2026-09-10 实测）→ 237+N 全过
npx vitest run src/injection/__tests__/visible-archive-http-smoke.test.ts
npx vitest run -t KNOWN-DRIFT  # 列出当前登记的漂移；期望 = 空（R1 未复现）或仅 R1
npm run typecheck:baseline     # PASS，55 errors 仍在 allow-list，零新增
```

**实测坐实的跑测前置（2026-09-10）**：本机默认 `node v24.18.0`（ABI 137）与 better-sqlite3 11.10.0 的预编译绑定（文件时间 2025-05-07）不匹配 → `getDb()` 内部 `catch` 吞错返回 `null`（`src/db/index.ts:101-107`）→ **48 例 sqlite 用例全红，报 `failed to initialize SQLite ... better_sqlite3.node`**，看上去像回归、实则环境。切 `node v22.19.0`（ABI 127）后 **15 文件 / 237 用例全绿**。故 S4 跑测前先确认 node 版本；`npm rebuild better-sqlite3` 是另一条路（`s0-s2-review.md` §4 已记为前置），但会改写 `node_modules`，非必要不动。

预期观测：日志出现 `[injection-debug] ... injectionEnabled=true injectors=["skill"] injectedSkipped=false`；上游 stub `requests.length ≥ 1`；四表行数符合用例期望；负例（空 injectors）四表 0 行。

**S4a 必须先判定 R1 真伪**：复现 → 登记进 `KNOWN_DRIFT`（走 §5.5 机制）；不复现 → `KNOWN_DRIFT` 保持空，R1 直接落为**正面断言**（重建块 === 实际注入块），无需工单。

### 5.5 R1 漂移的防遗忘机制（替代"记独立工单"）

「记独立工单」的问题正如担心的：**登记完就没人回来做**。所以把义务编码进测试套件，做成**双向 tripwire**：

1. **唯一权威源** `known-drift.ts`：所有已知漂移登记于此，不散落在聊天/文档里。
2. **用例由登记表生成**，不手写：
   ```ts
   for (const d of KNOWN_DRIFT) {
     console.warn(`[known-drift] ${d.id} (${d.ticket}) — ${d.summarize()}`);
     it.fails(`[KNOWN-DRIFT:${d.id}] ${d.summarize()}`, () => {
       // 断言"本应相等"：rebuildInjectedBodyFromArchive(...) === 实际注入块
     });
   }
   ```
   `it.fails` 的语义是**期望失败**：
   - bug 存续 → 绿，满足"进 `npm test`"；
   - 一旦有人修好 → 立刻变成 `expected to fail but passed` → **套件红**，逼翻转成正面断言并销案。
3. **联动断言（防静默删除）**：一条廉价用例读登记表里的 `doc`，断言该文档存在且含该 `id`。于是「删用例 → 必须动登记表」「删登记表 → 必须动文档」三处联动，评审可见。

**诚实边界**：该机制保证漂移**不能静默消失**，但**不能强制你去修**（bug 存续期间 `npm test` 仍是绿的）。要"强制修"只能让用例保持**红色**并不进 `npm test` —— 与"先进 `npm test`"冲突，故不取。折中：需要更响的提醒时，可加一条周期性 automation 把 `[known-drift]` 行捞出来推送（本次不做，仅记选项）。

### 5.6 文档落位与跨 session 同步协议

**为什么另一个 session 找不到文件**：这些文档原先只存在于 CodeBuddy 的临时工作区 `~/CodeBuddy/20260907024638/`（时间戳命名、**不是 git 仓库**），而代码在 `~/dev/TC/TencentDB-Agent-Memory/MemoryProxy`（git 根是它的父目录 `TencentDB-Agent-Memory`）。两者是**互不相干的两棵文件树**，编码 session 打开的是仓库 → 看不到工作区里的任何文件（本 session 的检索工具也因此只能对仓库用 shell 读写）。

**落位（本次已执行）**：六份文档全部拷入仓库 `MemoryProxy/docs/implementation/`，与既有 `00-master-spec.md` … `40-visible-text-archive.md` + `s0-s2-review.md` 同目录同命名习惯。

| 仓库路径 | 状态 |
|---|---|
| `docs/implementation/s0-s2-review.md` | 已跟踪（commit `8b0b8f5`）。**仓库版比工作区版多一节 §4「F1–F3 处理记录」，是正本**——本次用 `cp -n` 未覆盖 |
| `docs/implementation/{p0-archive-review, attribution-v2-review, s3-review, s4-smoke-checklist, s4-smoke-design}.md` | 本次新增，`git status` 显示 `??` 未跟踪；**是否提交由你决定**（S4 只需它们可见，不必入库） |

**同步协议**（沿用 s0-s2 已跑通的体例）：
1. 设计侧在本工作区草拟，定稿后 `cp` 入 `docs/implementation/`；仓库副本即交给编码侧的**快照**。
2. 编码侧**不要改正文**，在文末追加一节 `## N. 处理记录（日期）`，写「改了什么 + 验证数字」（体例见 `s0-s2-review.md` §4：逐条 F 项 + `npm test` / typecheck 数字）。
3. 设计侧下次改动前**先 diff 仓库版**，把追加的记录并回来再写新内容，禁止单向覆盖。

---

### 5.7 S4b 起跑线（设计侧补，2026-09-10，全部核到源码）

**先勘误一条注释**：`_helpers/s4-stubs.ts:173-178` 的「S4b 扩展点」把它指向 `/v3/skill/search` 分支，**指错了端点**。

- `SkillInjector` 走的是 `CoreSkillClient.listListing` → **`POST /v3/skill/listing`**（`src/injection/injectors/skill-injector.ts:17,269`；`src/skill/core-client.ts:316-321`）。
- `/v3/skill/search` 是**另一条** API（`searchSkills`，`core-client.ts:258`），本 injector 与 prewarm 都不用它。
- 若只按现注释在 `/skill/search` 造资产，`/skill/listing` 会落到 stub 兜底 `{}` → `listing` undefined → 0 块 → **"归档 === 上游"照样成立** → 又一个静默假绿（与 kernel stub 包错层同类）。请把那 3 行注释挪到 `/skill/listing` 分支；「先读 `core-client.ts` 再定形」的原则保留，这次我已替你读了（见下）。

**要造的真实形状**：`ListingResult { mode: "full" | "search"; listing: string; hits: { skill_id, version, name }[] }`（`core-client.ts:205-209`）。`listing` 是 core **预渲染好的 skill 清单文本**，proxy 只做 `wrapAvailableSkillsBlock(listing)` 原样包裹（`skill-injector.ts:93,102`）⇒ **稳定 asset id 必须出现在 stub 返回的 `listing` 字符串里**才会进上游字节；`hits[].skill_id` 只落在 `metadata.assets`（身份，不带 spans，`skill-injector.ts:299+`），**别指望它进正文**。

**块的字面标记（S4b 首跑实测，2026-09-10；原正文写作"`<available_skills>` 文本"，是文档叫法、不是字面标签）**：包裹后块首是 `SKILL_LISTING_HEADER` 的第一行 **`## Skills (mandatory)`**（`skill-injector.ts:62`），**没有任何 `<available_skills>` 标签**。`<available_skills>` 这个字面串实际只出现在 **`<skill_tools>` 块的散文**里（skill_view 的 use 说明提到它）。⇒ **别拿 `<available_skills>` 当"listing 块进来了"的证据**：只要 `<skill_tools>` 块在，它就成立，哪怕 listing 整块从未进来（会**误绿**）。要断块存在，用 `## Skills (mandatory)`。

**三条静默降级必须钉死**（每条都是 `return []` ⇒ 0 块）：
1. `!listing || listing.includes("(none)")` → `skill-injector.ts:286`：返回串里含 **`(none)`** 这个"无资产"哨兵会**静默空块**；
2. `catch` → `console.warn("[skill-injector] … degrading to empty <available_skills>")`（`:278-282`）——S4b 需断言**没有**这行；
3. 缺 session identity → 直接 skip（`:250`）。

**正向证据（沿用 `hasAgentDetail` 手法）**：injector 自带 `console.log("[skill-injector] <trigger> result mode=… hits=N listingLen=M")`（`:274-277`，`TAG="[skill-injector]"`）。S4b 应同时钉三件：`mode=full` + `hits=1` + `listingLen > 0`；**外加**上游 `rawBody` 字节含稳定 asset id；**外加**无 `degrading to empty`。三者缺一都可能被"完美一致"骗过。

**该三件套的承重墙是哪一件（S4b 首跑变异测试实测）**：`listingLen>0` 只证明 **listing 非空**，**不证明块被渲染** —— `"(none)"` 哨兵是在 `:286`（即该日志**之后**）才丢的。实测把 stub 的 listing 换成 `"(none)"`：`hits=1 listingLen>0` **照样成立**（日志那一行照样打），真正咬住它的是**上游字节断言**（`rawBody` 不含 asset id ⇒ 红）。⇒ 三件套里 **asset id 字节断言是唯一承重墙**，日志两个数字只是"早早退/降级"的探测器；`mode=full` 还只是我们 stub 回给 proxy 的**透传值**，不构成 core 路由证据。

**config 前提**：`coreSkill.endpoint` 指向 stub（默认 `http://127.0.0.1:8420`，`config.ts:134-139`）；`serviceToken` 必须给（否则 client 构造失败 → 直接走降级，`injection/index.ts:308-315` 注释原文已写 "silently degrades to no `<cloud_skills>` block"）；`team_id`/`agent_id` 需**同时**给出（plugin 侧 Zod 互绑校验，`core-client.ts:323-330`）。

**别被带偏**：`filterTeamSearchResponse`（`skill-bridge.ts:962+`，可见性白名单过滤）与 `/v3/meta/asset/list-accessible`（`meta/client.ts:347`）属于 **skill-bridge 的 team-wide search** 路径，**本 injector 不走它** ⇒ S4b 不需要造白名单。

---

### 5.7.1 ④「两块 ⇒ `body.system` 变数组」：**结论对，机理要改**（设计侧核，2026-09-10 第三轮）

判据**不是块数**，是**锚点 `{slot:"skills"}` 是否解析成功**。两条互斥分支（都已核到行）：

| 分支 | 触发条件 | 代码路径 | 结果 |
|---|---|---|---|
| **锚点命中** | prompt 里有 `# Session-specific guidance`（真 CC prompt；`agents/claude-code/index.ts:41` 把 `skills` 映射到该 heading） | `pipeline.ts:362-371` 把 system 消息**重建成单块**（`sysMsg.blocks = [{type:"text", content: profile.rebuild(...)}]`） | `adapters/anthropic.ts:198-205` 走 `textBlocks.length===1` ⇒ **仍是 string**（注入内容以胶水并进同一块） |
| **锚点未命中** | S4a 那种朴素 prompt（`"You are Claude Code (S4 excluded)."`，无 heading） | `pipeline.ts:374-382` 打 warn `[injection] anchor slot "skills" unresolved on agent … fallback to point "system.before_tools"` → `applyByPoint` → `appendTextToMessage`（`context.ts:87-89`，**push 新块**） | 多块 ⇒ `anthropic.ts:203-204` ⇒ **array** |

反例证明"块数"不是判据：**1 个注入块走 fallback 也会变 array**（基座是 string、被 push），**2 个注入块走锚点仍是 string**（被 rebuild 吸收）。S4b 沿用 A1 的 prompt ⇒ 落第二行 ⇒ 你们的结论成立。

另有一层别混：handler 层 session-context 直拼是**另一条路**（`anthropicHandler.ts:939-941` → `context-injector.ts:278-287`）：string 基座 → `${system}\n\n${block}`（这就是 `SEAM_GLUE`），array 基座 → append 新块。A1/A2 分别证明了这两半；S4b 的完整形态要把两条路叠起来看。

**S4b 断言配方（替代"按数组写"这种硬编码）**：
1. **先钉分支**：断 `anchor slot "skills" unresolved … fallback to point` 这行**在/不在**（沿用 `degrading to empty` 的正向证据手法）——它是形状的**因**，形状只是**果**。**前提（S4b 首跑才发现）**：这行与 `degrading to empty` 都是 **`console.warn`**，而 S4a 的 `startLogCapture` 只 spy 了 `console.log` ⇒ **必须先把捕获扩到 warn**，否则"未命中分支"的断言**永远为假**（抓不到）、"命中分支"的断言**永远为真**（同样抓不到 ⇒ 假绿）。这是 S4a 遗留的捕获盲点，已随 S4b 修掉（`startLogCapture` 现同时 spy `log` 与 `warn`，仍共用同一 `lines` 数组）；
2. **再由分支定形状**（以下为**实测口径**，`visible-archive-http-smoke.test.ts` 的 B1/B2 已按此钉死）：
   - **未命中 → `Array.isArray(system)===true`，恰好 3 块**：`[0]` = 客户端 string + `SEAM_GLUE` + 归档 session-context（**handler 层先拼**：`anthropicHandler.ts:939-941` 早于 pipeline 调用，故 `[0]` **不是**裸 excluded，而是被 handler 拼过胶水的那个块），`[1]` = `<skill_tools>` 块，`[2]` = `## Skills (mandatory)` 开头的 listing 块（`skill-tools-injector.ts:198` 设 `HOOK_PRIORITY.SKILL - 1` ⇒ tools 在前，**已实测坐实**）；
   - **命中 → `typeof system === "string"`**，且两个块是**插在 `# Session-specific guidance` heading 之前**（锚点 `relation:"before"`），**不是**追加到 system 末尾（原正文的 `excluded + \n\n + tools + \n\n + available` 公式**不成立**，会写出一条必错的断言）。实测顺序与偏移：`<skill_tools>(120) → ## Skills (mandatory)(2415) → # Session-specific guidance(3996) → # Memory → # Environment → <session_context>(4154)`；
3. **两条分支都加**正向证据三件套（asset id **字节** + `[skill-injector] … hits=1 listingLen>0` + 无 `degrading to empty`），其中**字节断言是唯一承重墙**（理由见上一条"承重墙"段）；
4. 只断一种形状的代价：一旦测试 prompt 换成带 `# Session-specific guidance` 的真 prompt（或反向并入 golden），形状翻转会以"神秘失败"出现；反向风险是形状无关断言照样绿。

**误因工单草案（属测试范围外，不并入 S4b 同批）**：
**①** `src/injection/index.ts:308-310` 三行注释陈旧 —— 写 "Calls **/v3/skill/search** at prewarm time"、并三次把块称作 **`<cloud_skills>`**，与 `skill-injector.ts` 类头（`listListing` + `<available_skills>`）矛盾，已实际误导过一轮（正是本轮勘误的来源）。建议单开**纯注释**工单：改这 3 行 + 复核 `typecheck:baseline` 基线不变 + 确认零行为改动。**不要**和 S4b 的验证结果同批，避免"改注释导致重跑"污染证据。

**② 同类陈旧别名（S4b 后扩案，2026-09-10；仍纯注释、仍单开不并入）**：`src/injection/injectors/skill-injector.ts` 共 **11 处**把该块称作 `<available_skills>`（`:2,8,12,48,56,83,90,185,210,228,280`）—— 实测块内**没有**这个标签（真首 = `SKILL_LISTING_HEADER` 首行 `## Skills (mandatory)`，`:62`），`<available_skills>` 只是 core 侧原名残留（`wrapAvailableSkillsBlock` 是**函数名**，不是**标签名**）。这正是本轮差点误绿的来源。
⚠️ **`:280` 必须单独处理**：那是降级 warn 的文案 `… degrading to empty <available_skills>: …`，而**我方断言 `expectNoSkillDegradation` 正以 `degrading to empty` 为锚点** —— 改文案时**必须保留该前缀**，否则"改文案"与"改断言"同批会互相掩盖（断言的"因"被搬走却无人发现）。
> 注：`wrapAvailableSkillsBlock` 这个**函数名**不要改（属重命名、非注释，有跨文件面）；本工单只收敛**注释与日志文案**，函数名/API 面保持原样。
>
> 计数口径：本行数字是**按 `<available_skills>` 字面**在 `skill-injector.ts` 里 grep 的**实测 11 处**；设计侧早前口径写作 12 处、并把 `:87`/`:237` 列入，但这两行本身**不含**该串（是相邻行）。（同一批数字口径不一，记之以备复核。）

**第四轮追记（2026-09-10，设计侧核）**：
- 勘误已从文档**落到机理层**：`s4-stubs.ts` 的 ④ 拆为 **④（元素构成：连带注册 ⇒ 两个块）** + **⑤（形状由锚点决定：两条分支 + 反例 + 配方 + 本小节指针）**；`_helpers/attribution-window.ts:99-101` 同款收紧（编码侧自查发现，属第二处）。
- 本小节依赖的挂点已全部**抽检坐实**：`ListingResult { mode, listing: string, hits:[{skill_id,version,name}] }`（`src/skill/core-client.ts:205-209`）、`!listing || listing.includes("(none)") → []`（`skill-injector.ts:286`）、正向日志 `hits=… listingLen=…`（`:276`）、降级 warn `degrading to empty`（`:280`）。① ② ③ 的注释与这些行一致，可直接作为 S4b 的施工图。
- **残留同款措辞 1 处（未改，留给编码侧裁决）**：smoke 用例 `:418` 注释 `array 形态：多 text block → adapter 序列化回 block 数组（原 N 块 + 1）`。该陈述**在 A2 语境里成立**（A2 的 3 块 = 客户端 array 2 块 + handler 层 append 1 块，全程不过 pipeline 锚点路径 ⇒ 块确实独立、adapter 规则如实生效），但那句措辞正是本轮踩坑的同款；读者若把它外推到"接缝 A 渲染块"场景就会复现同一错。建议加一句限定：`（本例块独立来自客户端 array + handler 层 append；pipeline 锚点路径会把多块重建成单块，见 §5.7.1）` —— 纯注释、不动断言。

**编码侧回执（第四轮追记后，2026-09-10，编码侧；上面你的追记与裁决原件均未改）**：两条均裁决为**改**（纯注释、不动断言），已落地。

- **`:418` 已修**：原文保留，其后补 3 行限定 —— "本例块**独立**来自「客户端 array 基座 + handler 层 append」（`context-injector.ts:278-287`），**不经** pipeline 锚点路径 ⇒ adapter 规则如实生效；锚点路径会把多块**重建成单块**（仍 string），形状判据是**锚点解析、不是块数**，**别外推到接缝 A 渲染块**"。
- **消歧已落地**：`s4-stubs.ts` 里 **5 处**裸 `core-client.ts` 全改为 **`src/skill/core-client.ts`**（仓库另有 `src/knowledge/core-client.ts`，同名照注释找会开错）。`skill-injector.ts` 经**全仓检索唯一**（`injection/injectors/skill-injector.ts`），不加前缀也不会开错，保留短写。
- **自我归因**：至此同一错法在编码侧文件里共 **3 处**（`s4-stubs.ts` ④、`attribution-window.ts`、smoke `:418`），已全部收敛到"形状由**锚点解析**决定"这一个口径 —— 这是我的**系统性**错法（拿可见的"块数"当判据），不是孤立笔误；后续凡涉及形状/形态的注释，一律先找"因"（哪条分支/哪个解析）再写"果"。

---

## 6. 开放问题（S4a 首跑后 **全部闭合**，2026-09-10）

1. ~~injector 选型~~ **闭合**：不用 `skill`，改 `injectors=["knowledge"]` + `knowledge.enabled=false`（理由见 §4 勘正）⇒ gate 打开、注册表为空、不产块不抛错；`entering injection pipeline`（`anthropicHandler.ts:1238`）照常打印，A1 的 P1 证据成立。
2. ~~R1 处置~~ **闭合**：R1 **未复现**（两个入口同源同参落到 `buildContextBlock`，`src/session/context-injector.ts:43,213,261`）⇒ `KNOWN_DRIFT` 保持 `[]`（合法初态），A3 落**正面断言**（归档块 === 上游实际注入块，逐字节）。
3. ~~`debugForceUserId` 是否足够~~ **闭合**：足够。kernel stub 只被命中 `/v3/meta/agent/get` + `/v3/meta/task/get`（另记录到未触发的兜底端点），`hasSessionInfo=true` / `hasAgentDetail=true` 已作为正向断言钉死。
4. ~~S4 是否纳入 `npm test`~~ **已定（见 §0）**：进默认 `npm test`；若 CI 不允许 loopback bind，再拆 `npm run smoke:s4`。
5. ~~anthropic `body.system` 是否被途中改写~~ **闭合**：未被改写。A1 用上游 rawBody 直接比对，`string` 形态保持 string 且**逐字节相等**成立。

新增闭合项（首跑暴露、原文未预见）：

6. **跑测 node 版本**（详见 §5.4）：必须 node 22；node 24 会让 better-sqlite3 绑定不匹配 → `getDb()` 返回 null → 48 例假红。测试已用 `beforeAll` 断言 `SqliteVisibleTextRepo` 把这条钉死。
7. **上游真实端点**：`/v1/messages` → 上游 `/messages`、`/v1/chat/completions` → 上游 `/chat/completions`（`src/routes/whitelist.ts:48-49,56`），断言按实测口径写。
8. **窗口外降级（仅记录，不处理）**：`[asset-capability] fetch failed: /v3/meta/config/user/get`、`CREDIT_REPORT fetch failed`（costGuard 关）——均不影响本窗口判定。

---

## 7. 不做的事（范围边界）

- 不改生产代码、不加新 dump 钩子（方案 C 仅作为诊断兜底，不提交）。
- 不跑真 CC / CodeBuddy 客户端（`scripts/qa/*.py` 的 pexpect 交互冒烟属 S5 最后一公里）。
- 不验 S5 的"按决策单元锚点 `(epoch,turn)` 取窗"（档① 无 epoch 维度是已记录的诚实注记，`visibleTextRepo.ts:498-501`）。
- 不做长稳/性能。
- 不重复验 §8.5 已闭合的配置解析矩阵（S4 直接构造 config 对象）。

---

## 处理记录（2026-09-10，编码侧回传；正文未改）

### 1. R1 首跑结论：**未复现** → `KNOWN_DRIFT` 保持空数组，A3 落正面断言
源码依据（自行核过，非照抄本文行号）：归档侧 `handler.ts:1063-1069` 用 `buildSessionContextBlockWithToggles(initResult.agentDetail, initResult.taskDetail, config.sessionInit, sessionKey)`；注入侧 `session/codebuddy/init.ts` 走 `injectSessionContextWithToggles(messages, agentDetail, taskDetail, config.sessionInit, sessionKey)`。两者最终都落到同一个 `buildContextBlock(agentForCtx, taskForCtx)`，`agentDetail`/`taskDetail` 是同一对对象、toggles 是同一份 config ⇒ 字符串必然逐字节相同。故 `KNOWN_DRIFT = []` 是合法初态，A3 写成正面断言（把"实际注入块"从上游字节里剥出来与归档块逐字节比对），并留了 `it.fails` 生成器备用。

### 2. 与原文不一致处（**请设计侧确认**）
- **F10 行号错**：`src/injection/pipeline.ts:415-434` 处**没有** visibleArchive 装配门（该文件 grep `visibleArchive` 零命中）。真正装配点是 **`src/injection/index.ts:419-425`**（档① observer）。实现按后者。
- **kernel stub 响应形状少/多一层**：checklist §2 的 `{code:0,data:{agent:{...}}}` 会**静默假绿** —— `MetadataClient.getOne` 直接返回 `data`，所以 `data` 必须**就是实体本身**（`data.agent_id` / `data.title` 等）。包一层不抛错，只会让 `agentDetail.id === undefined`、块体缺 id、用例"完美一致"。S4a 按 flat 实现，并加 `hasAgentDetail=true` / `hasSessionInfo=true` 正向前置断言把这类假绿钉死。
- **§4.1 A1 的期望与 `injectors:["skill"]` 自相矛盾**：`SkillToolsInjector` 在 `injectors.includes("skill")` 时**无条件注册**且**总是产出** `<skill_tools>` 块（与 skill 搜索是否返回空无关）。一旦有渲染块，anthropic 适配器 `serializeSystemMessage`（textBlocks.length===1 → string，否则 → 数组）会把 `body.system` 序列化成**数组**，A1 的 `body.system === excluded + "\n\n" + 块`（string）立刻失效。为守住"S4a 只验接缝 B"的原意，改用 **`injectors:["knowledge"]` 且 `knowledge.enabled=false`** → `shouldRegisterKnowledgeInjector=false` → 注册表为空、pipeline 照进（gate 的 `injectors.length>0` 满足）、不产块、不抛错、也不需要 skill 端点。**这是对原文的一处有意偏离。**
- **§4.1 负例期望不成立**：`injectors=[]` 只打掉**注入 pipeline**（gate）；接缝 B 与 `injectors` **无关**（它在 handler 的 session-init 分支里，先于 gate 执行）。实测负例下上游仍含 `<session_context>`、档① 仍有 session-context 行。A4 因此改成钉三件事：首行 `injectors=[]`、**无** `entering injection pipeline`、**渲染块档① 行数 = 0**；并把"上游体一致 ≠ 注入跑过"这个陷阱显式写进注释。
- **openai 侧没有 `entering injection pipeline` 日志**（只有 `anthropicHandler.ts:1238` 有）。A3 的 P1 改用组合证据：首行 `injectors` 非空 + `injectedSkipped=false` + `kind=main` + `initResult justRegistered=true` 且非 `bypassed=true`；最强证据由"归档块 === 上游实际注入块"逐字节断言兜底。
- **上游真实路径是 `/messages` 而非 `/v1/messages`**：`joinUrl(base, matchWhitelistEndpoint(path))` 在 base 为纯 origin 时不补 `/v1`。断言按实测写。
- **openai `initResult.bypassed` 实测为 `undefined`**（字段未设），不是 `false`。断言按"非 true"写。
- 顺带观察到两处与本窗口无关的降级（不影响判定，仅记录）：`[asset-capability] fetch failed: Failed to parse URL from /v3/meta/config/user/get`（asset-capability 未接 `coreSkill.endpoint`，走相对 URL 失败后降级）与 `CREDIT_REPORT ... fetch failed`（costGuard 关闭下的上报降级）。

### 3. checklist 三处修正的落地情况
- S4a 不需要 kernel 资产 ✓（只打 `/v3/meta/agent/get`、`/v3/meta/task/get`；另有 `participation-log/append`、`skill/search` 兜底端点，实测未触发任何资产端点）。
- kernel stub 形状先读 `MetadataClient.getOne` 再定 ✓（见 §2 第二条）。
- `[visible-archive]` 不当成功证据 ✓（未使用；成功证据用无条件的 `[injection-debug]` + 档①/档② 行 + 上游 rawBody）。
- 另：S4a 未构造 `config.s4.yaml`。config 以 `buildConfig({ configFile: <不存在的路径> })` 取 DEFAULT_CONFIG 后**直接覆盖对象字段**，无第二个配置漂移源 ✓。

### 4. 实测证据
- `src/injection/__tests__/visible-archive-http-smoke.test.ts`：**5/5 通过**（A1 anthropic string、A2 anthropic array + cache_control、A3 openai string + R1 逐字节、A4 负例 pin、known-drift 联动断言）。
- **零回归**：`npx vitest run src/injection` → 9 files / **88 passed**（含被改的 golden）；`npm test` → 16 files / **242 passed**。
- **类型基线**：`npm run typecheck:baseline` → `PASS — 55 errors, all within allow-list`（新增代码零新错误）。
- node **v22.19.0**（better-sqlite3 可用）；`beforeAll` 断言 `getVisibleTextRepo().constructor.name === "SqliteVisibleTextRepo"`，杜绝静默降级到 Null repo 造成的永久空档案假绿。

### 5. 共因落地
新增 `src/injection/__tests__/_helpers/attribution-window.ts` 作为「可见正文提取 + 还原串拼接 + 胶水剥离 + 按归档重建 system 文本」的**唯一实现**；`visible-archive-golden.test.ts` 已改为 import `visibleTextOfPiece` / `restoredVisibleText`，两套断言口径不再各写一份。
诚实边界：`stripGlue()` 是**有损投影**（全局折叠连续空行），只作 §3a D 准则的辅助诊断；主断言是 `rebuildInjectedBodyFromArchive()` 的带位置精确重建。该重建函数**只覆盖 string 形态 system**；array 形态（A2）由用例直接断块数组 —— 已在函数注释里声明。

### 6. 已知待办 / 未做
- `KNOWN_DRIFT` 当前为空数组（合法初态）。`it.fails` 生成器与 doc 联动断言已就位：一旦登记，漂移存续→绿、修好→套件红并逼销案。
- 未做：周期性 automation 抓 `[known-drift]` 行推送（§5.1 记的选项，按约定本次不做）。
- 未做（属 S4b）：接缝 A 渲染块在真链路下的完整归档断言。本窗口用零 hook 配置把断言收敛在接缝 B。

---

## 设计侧裁决（2026-09-10，逐条回应"请设计侧确认"）

**总判：5 处偏差全部成立，交付件接受，S4a 收口。** 每处我都回源码复核过，并把正文勘正（改动均标「勘正 2026-09-10」）。

| # | 偏差 | 裁决 | 复核依据 |
|---|---|---|---|
| 1 | F10 行号错 | **接受**；正文已改为 `injection/index.ts:419-425` | `grep visibleArchive src/injection/pipeline.ts` **零命中**；`index.ts:419` 是唯一装配门。设计侧笔误，按源码走是对的 |
| 2 | kernel stub 必须 flat；task 读 `title` | **接受**；正文已改 | `getOne` 直接 `return env.data`（`src/meta/client.ts:472-479`、`:562-566`）；`TaskEntity` 只有 `title`（`:74-82`）；`src/session/store.ts:579` 做 `name: task.title` |
| 3 | A1 改用 `["knowledge"]` + `knowledge.enabled=false` | **接受该偏离** | `src/injection/index.ts:319` 无条件 `registry.register(new SkillToolsInjector(...))` 且注释写明 "Always inject"；`shouldRegisterKnowledgeInjector` 要求 `knowledge.enabled`（`index.ts:515-524`），默认 `false`（`config.ts:140-141`） |
| 4 | 负例改钉三件事 | **接受**；正文已改 | 原文"上游无 `<session_context>` 且四表 0 行"是设计侧漏算——接缝 B 在 session-init 分支、先于 gate；`schema.ts:103` 确认 `source = metadata.source ?? hook.id`，合成块即 `session.context` |
| 5 | openai 三处实测口径 | **接受** | `entering injection pipeline` 仅存于 `anthropicHandler.ts:1238`；白名单 `pathSuffix:"/v1/messages" → upstreamEndpoint:"/messages"`（`src/routes/whitelist.ts:48-49`，openai 同理 `:56`）；openai 首行 `handler.ts:813`、initResult `handler.ts:934` |

**要补的三点（非返工，是给 S4b 留的钉子）**：

1. **`hasAgentDetail=true` 这招请在 S4b 沿用**：本次最有价值的不是某条断言，而是"把静默假绿变硬红"的手法。S4b 断言渲染块时别只断"块存在 / 行数 +1"，要断**块内具体 asset id 出现在上游字节里** —— 否则 stub 少给一个字段又会"完美一致"。
2. **A1 的边界写清楚**：`["knowledge"]` + disabled 意味着 A1 只证明"gate 开 + 接缝 B 逐字节正确"，**不证明**真实渲染块能被正确归档/注入。那是 S4b 的活，别被"S4a 全绿"顺带当成已完成。
3. **`bypassed` 断言保持现状（偏弱但稳）**：`handler.ts:934` 其实**会**打印 `bypassed=${initResult.bypassed}`，字段未设时字面是 `undefined`。写 `not.toContain("bypassed=true")` 是对的；若改成断 `bypassed=undefined`，就把上游"该字段未设"这个实现细节焊进了测试，不建议。

**复跑核对（设计侧独立跑，node v22.19.0）**：`npx vitest run src/injection` → 9 files / **88 passed**；`npm test` → 16 files / **242 passed**；`npm run typecheck:baseline` → `PASS — 55 errors, all within allow-list`。与编码侧报告**完全一致**。

**遗留（同意编码侧边界）**：S4b（接缝 A 真链路）、周期性 automation 抓 `[known-drift]`、两处窗口外降级仅记录。`KNOWN_DRIFT=[]` 是**合法终态**（R1 未复现 ⇒ 该漂移不存在），不必为它造登记项。

---

## 处理记录（第二轮，2026-09-10，编码侧回传；正文与本轮裁决均未改）

**总判：三个钉子全部落地，且都钉在 S4b 会读到的地方（不只在聊天里）。** 本轮只动注释 / 文档，不改任何断言行为。

| 钉子 | 落地位置 | 具体做法 |
|---|---|---|
| 1 `hasAgentDetail=true` 手法沿用 + S4b 断 asset id | `visible-archive-http-smoke.test.ts` 的 `expectDetailResolved` 文档注释；`_helpers/s4-stubs.ts` 的 `/v3/skill/search` 处新增「S4b 扩展点」注释 | 把手法命名为"把静默假绿变硬红"并写明机理（字段缺失时"归档 === 上游"**照样**成立，等值断言永远抓不到）；S4b 要求写死：**必须断块内具体 asset id 出现在上游 rawBody 字节里**，stub 要带稳定可识别 asset id，且返回形状**先读 `skill/core-client.ts` 再定形** |
| 2 A1 边界写清 | 测试文件头「诚实边界（设计侧钉子 2）」+ A1 用例内注释 | 明写 A1/A2/A3 的 `["knowledge"]` + disabled **只证明**「gate 开 + 接缝 B 逐字节正确」，**不证明**渲染块能被正确归档 / 注入；**「S4a 全绿」≠ 接缝 A 已验** |
| 3 `bypassed` 断言保持现状 | `expectOpenaiInjectionGateOpen` 注释 | 断言**未改**（仍 `not.toContain("bypassed=true")`）；注释补齐依据（`handler.ts:934` 无条件打印 `bypassed=${initResult.bypassed}`，openai 侧该字段未设 ⇒ 字面 `undefined`）并写明**不要**改断 `bypassed=undefined`（会把上游实现细节焊进测试） |

**另**：`KNOWN_DRIFT=[]` 按本轮裁决改注为**合法终态**（`known-drift.ts` 文件头 + 常量注释各一处，行为未变），并注明"只有**新**漂移被复现才加条目"。

**复跑核对（编码侧，node v22.19.0，纯注释改动后）**：`npx vitest run src/injection` → 9 files / **88 passed**；`npm test` → 16 files / **242 passed**；`npm run typecheck:baseline` → `PASS — 55 errors, all within allow-list`。与本轮裁决的独立复核数字**完全一致**。

**未做（与裁决一致）**：S4b 本体（接缝 A 真链路 + asset id 断言）；周期性 automation 抓 `[known-drift]`；两处窗口外降级仅记录。

---

## 处理记录（第三轮，2026-09-10，编码侧回传；正文、§5.7、前两轮记录均未改）

**勘误接受：端点指错是我方第二轮注释的错。已「把分支建对」而非改文字。**

**落地内容**（`_helpers/s4-stubs.ts`）：

- **新增真实分支** `if (path.endsWith("/skill/listing"))`，三行注释**挪到这里**；空形状明标"不可达占位，S4b 必须换成 1 条资产"。
- `/skill/search` 分支**保留但改注**：明确"本 injector **不走**这个端点（`searchSkills`，`core-client.ts:258`），S4b **不要**在此造资产"——保留只为让误打可见（不静默吞）。
- 四条 S4b 提示进代码：① `ListingResult` 形状 + asset id **必须写进 `listing` 字符串**；② `"(none)"` 哨兵会静默空块；③ 正向证据三件套；④ 见下。
- 文件头第 2 条补"同一 stub 也承载 `/v3/skill/listing`"（`cfg.coreSkill.endpoint` **本就**指向它，`:136`，故 S4b 无需另起 stub）。
- `visible-archive-http-smoke.test.ts` 的 `expectDetailResolved` 注释同步补两条前提（端点 + asset id 须进 `listing`），免得钉子在错端点上空转。

**§5.7 之外新发现的一条（建议补进 §5.7，我没动你正文）**：

> ④ **启用 skill injector 会连带注册 `SkillToolsInjector`**：`injectors.includes("skill")` 命中后 `SkillInjector` 与 `SkillToolsInjector` **一起**注册，后者**总是**产出 `<skill_tools>`（`injection/index.ts:307-320`，注释原文 "Always inject ... Even when there are no skills to recommend"）⇒ S4b 的渲染块是**两个**，anthropic 侧 `body.system` 会变**数组**，别按 A1 的单块 string 期望写（与 §4 勘正 3 同源）。

**误因报告（生产代码零改动，仅报告）**：`src/injection/index.ts:308-310` 注释写 "Calls **/v3/skill/search** at prewarm time"、并把块称作 `<cloud_skills>`；而 `skill-injector.ts` 类头写的是 **`listListing` + `<available_skills>`**。生产注释自身陈旧且不一致，正是我照它写错端点的来源。按协议未动生产代码，建议单开一条工单（属测试范围外）。

**复跑核对（编码侧，node v22.19.0）**：S4 冒烟 **5 passed**；`vitest run src/injection` → 9 files / **88 passed**；全量 → 16 files / **242 passed**；`typecheck:baseline` → `PASS — 55 errors, all within allow-list`。`git status --porcelain` 确认**生产代码零改动**（仅 golden 被改 + 新增测试/helper + 5 份文档）。

**行为声明**：本轮只动两处注释 + 新增 1 个 **S4a 不可达**分支，行为零变化。S4a 正式收口；S4b 起手读 §5.7 + `s4-stubs.ts` 的 `/skill/listing` 分支注释。

---

## 处理记录（第四轮，2026-09-10，编码侧回传；正文、§5.7、§5.7.1、前三轮记录均未改）

**④ 机理更正接受：结论对，判据是锚点解析、不是块数。** 我自己压了源码逐条对上：`pipeline.ts:355-382`（命中 `:362-371` 重建单块 / 未命中 `:374-382` warn + `applyByPoint`）、`context.ts:87-89`（push 新块）、`anthropic.ts:198-205`（`textBlocks.length===1` → string）、`agents/claude-code/index.ts:41`（`skills → "Session-specific guidance"`）、`context-injector.ts:278-287`（string 基座 → `${system}\n\n${block}` / array → append）。**接受"别写成通则"**：我上轮那句"两块 ⇒ 数组"确是过度概括（1 块走 fallback 也 array、2 块走锚点仍 string）。

**落地（纯注释，行为零变化）**：

- `s4-stubs.ts` 的 ④ **拆为 ④ + ⑤**：④ = 连带注册 `SkillToolsInjector` ⇒ 渲染块是**两个**（`<skill_tools>` + `<available_skills>`，`injection/index.ts:307-320`）；⑤ = **形状由锚点决定**，含两条分支的代码路径、"1 块 fallback 也 array / 2 块锚点仍 string"反例，并写明 S4b **先钉 unresolved 行 → 再由分支定形状 → 两条分支都加正向证据三件套**，**别按块数硬编**。指针给 §5.7.1。
- **自查同类问题**：`_helpers/attribution-window.ts:97-99` 我方原先也写成"一旦注入渲染块 ⇒ 数组"，同属过度概括 —— 已收紧为"取决于锚点是否解析成功，别按块数反推形态"。该处不在你的清单里，属编码侧自查；说明这个错法在我方文件里共两处。
- 生产代码**零改动**：误因工单按你的裁决**单开纯注释批、不并入 S4b**（草案已在 §5.7.1，我不再另写；实施只改 `injection/index.ts:308-310` 三行 + 复核基线不变 + 确认零行为改动）。

**口径澄清（接受）**：上轮"lint 零诊断"指 **IDE 诊断**（`read_lints`，3 文件 0 条），**不是** `npx eslint` —— 本仓库 flat-config 迁移问题使 eslint 跑不起来，属既有环境状态，不列为本轮验证证据。

**复跑核对（编码侧，node v22.19.0）**：S4 冒烟 **5 passed**；`vitest run src/injection` → 9 files / **88 passed**；全量 → 16 files / **242 passed**；`typecheck:baseline` → `PASS — 55 errors, all within allow-list`；`git status --porcelain` 生产代码零改动（仅 golden 被改 + 新增测试/helper + 5 份文档）。

**行为声明**：本轮只改三处注释（`s4-stubs.ts` 两处 + `attribution-window.ts` 一处），零行为变化。S4a 收口不变；S4b 起手按你定的顺序 **§5.7 → §5.7.1（先定分支，再定形状）**。

---

**设计侧记录约定（2026-09-10，第五轮后定）**：第五轮的「编码侧回执（第四轮追记后）」被追加在 **§5.7.1 小节内**（`## 6.` 之前）。内容无误，但 §5.7.1 是 S4b 的施工图，记录类内容进正文会把"活内容"稀释。**自本轮起：回执/记录一律追加到文末本记录区**，正文 §0–§7 只保留仍生效的设计与源码事实；若某轮记录改变了正文口径，**改的是正文**，记录里只写"改了什么 + 新指纹"。

---

## 7. 处理记录（第六轮 · S4b 落地，2026-09-10，编码侧）

**改了正文 3 处**（按上面第五轮约定：口径变了就改正文，不用记录稀释施工图）：

1. §5.7「要造的真实形状」→ 追加**字面标记勘误**：包裹后块首是 `## Skills (mandatory)`，**没有** `<available_skills>` 标签；该字面串只在 `<skill_tools>` 块的散文里 ⇒ 拿它当"块存在"的证据会**误绿**。
2. §5.7「正向证据」→ 追加**承重墙**段：`listingLen>0` 只证明 listing 非空、**不**证明块被渲染（`(none)` 哨兵在日志**之后**的 `:286` 才丢）；三件套里**字节断言是唯一承重墙**，`mode=full` 还只是 stub 的透传值。
3. §5.7.1 配方 → ① 补 **warn 捕获前提**：那行与 `degrading to empty` 都是 `console.warn`，而 S4a 的 `startLogCapture` 只 spy 了 `console.log` ⇒ 不扩捕获则"未命中"断言恒假、"命中"断言恒真（假绿）；② 把两条分支形状改成**实测口径**：未命中 **=3 块**且 `[0]` 已被 handler 拼上 `SEAM_GLUE`+session-context；命中 **=string** 且两块插在 `# Session-specific guidance` **之前**（原 `excluded + \n\n + tools + \n\n + available` 公式**不成立**，照它写必错）。

**落地（代码，未动生产代码）**：

- `_helpers/s4-stubs.ts`：`/skill/listing` → **1 条确定资产**（`S4_KERNEL_FIXTURE.skillId="skl-s4-smoke-0001"` 写进 `listing` 正文、hits 三字段给全、**不含 `(none)`**）；新增导出 `S4_SKILL_LISTING`；④/⑤ 注释更新（该分支现已可达）。
- `visible-archive-http-smoke.test.ts`：新增 `proxyS`（`injectors:["skill"]`）；`startLogCapture` **扩到 warn**；新增 3 个 S4b 断言助手（`skillAnchorUnresolvedLines` / `expectSkillListingInjected` / `expectNoSkillDegradation`）+ **B1（未命中→array）/ B2（命中→string）** 两用例，两条分支都带三件套。
- 你那条提醒照办：`SkillToolsInjector` 恒产 `<skill_tools>` 只用作**④ 元素构成**（解释为何是 3 块/两个渲染块），**没有**拿它推形状。

**变异测试（证明新断言非空转）**：把 stub 的 `listing` 换成含 `"(none)"` 的串 → **B1/B2 双双变红**，失败点正是**字节断言**；同时实测 `expectSkillListingInjected`（`hits=1 listingLen>0`）**照样通过** ⇒ 它不能单独当"块进来了"的证据（已写进代码注释 + 上面正文承重墙段）。随后已**还原**。

**数字（编码侧，node v22.19.0）**：S4 冒烟 **7 passed**（S4a 5 + S4b 2）；`vitest run src/injection` → 9 files / **90 passed**；全量 → 16 files / **244 passed**；`typecheck:baseline` → `PASS — 55 errors, all within allow-list`；`git status --porcelain` 生产代码零改动；IDE 诊断 0 条。

---

## 8. 处理记录（第七轮 · S4b 独立复核后收口，2026-09-10，编码侧）

**独立复核结论接受**：全量 244 / 冒烟 7 / `typecheck:baseline` PASS / 两份文档指纹一致 / 生产零改动 —— 双方数字逐项相同。

**① 别名残留已修（纯一致性，不动断言）**：`visible-archive-http-smoke.test.ts:105` 原把渲染块写成 `<skill_tools>` + `<available_skills>`，改为 `<skill_tools>` + **以 `## Skills (mandatory)` 开头的 listing 块**。顺带记一条自查结论：**相对序断言（`:732-734` 三条 `toBeLessThan`）是对的，不该写死 120/2415/3996** —— 那些偏移是当前 stub prompt 的产物，不是判据。

**② 采纳裁决：护栏按"泄漏"写，不按"可见性"写**（新增 1 条自足用例，`describe("S4b · 捕获器护栏…")`）：
- 形态即裁决给的那条：`startLogCapture()` → `stop()` → `before = lines.length` → `console.log/warn("guard")` → 断 `lines.length === before` + `vi.isMockFunction(console.{log,warn}) === false`。
- **不把"写进 stderr"当主判据**：vitest 自身也写 stderr，且本文件 `[identity]` / `[REQ…]` 那些行是 logger 直写（非 `console.*` 通道），捕获期间照旧可见 ⇒ 拿可见性判绿红会骗人。代码注释里已写明这一点。
- **护栏自身的变异测试**（证明它不是装饰，两次定向变异、均已还原）：
  1. 抽掉该用例里的 `log.stop()` → **立即红**，失败信息 `expected 2 to be +0`（正是被吞掉的 `guard` + `guard-warn` 两行）⇒ "数组不再增长"有牙；
  2. 把 `stop()` 里的 `logSpy.mockRestore()` 换成 `mockReset()`（换个失效模式：不再吞日志、但 mock 没摘）→ 数组断言**照常通过**，而 `vi.isMockFunction(console.log)` **单独变红**（`expected true to be false`）⇒ "已还原"这句也有独立牙，两条不是重复防线。
- 优先级确认：捕获只覆盖 `console.log`/`console.warn` 两条通道，proxy 结构化日志不受影响；`KNOWN_DRIFT` 现为空数组（`known-drift.ts:48`，合法终态）⇒ `:756` 那条 `console.warn` 暂不触发，与本护栏无交互。

**③ 误因工单范围修订（已改正文 §5.7.1 草案）**：扩为 **案①（`injection/index.ts:308-310`）+ 案②（`skill-injector.ts` 的 11 处同名残留）**，**仍单开、仍不并入 S4b 同批**。补一条耦合警示：`:280` 的降级 warn 文案是我方 `expectNoSkillDegradation` 的断言锚点，改它**必须保留 `degrading to empty` 前缀**，否则改文案与改断言会互相掩盖。

**数字（编码侧，node v22.19.0，本轮）**：S4 冒烟 **8 passed**（S4a 5 + S4b 2 + 护栏 1）；`vitest run src/injection` → 9 files / **91 passed**；全量 → 16 files / **245 passed**；`typecheck:baseline` → `PASS — 55 errors, all within allow-list`；`git status --porcelain` **生产代码零改动**（仍是 golden 被改 + 新增测试/helper + 文档），无临时 dump 残留。与预期（8 / 245）一致。

---

## 9. 设计侧施工单：误因工单登记（由 KNOWN_DRIFT 承载，2026-09-10）

> **状态：已销案**（2026-09-10，第九轮）。
> 本节描述的 `SKILL-DOC-ALIAS` 已在本轮修好并销案：`KNOWN_DRIFT` 回到 `[]`，判据函数
> `skillDocAliasViolations` 原样搬成 smoke 的一条**正面 `it`**。销案数字、变异测试与 1 处落点偏离见 **§13**。
> **本节与 §10/§11/§12 一律保留**（处置痕迹要留，勿删）；其中 9.3/9.4 各表的"现状"列是**登记当时**的实测快照，销案后已不成立 —— 属历史快照，不回改。

> **本节唯一的"活内容"目的**：把"误因工单"从"文档里的一句待办"改成**每次 `npm test` 都会经过的通道** —— 不依赖任何人的记性（`known-drift.ts:4-5` 的原始动机就是"人工记得回来改断言是不可靠的"）。生产代码与产品行为**零改动**。

### 9.1 登记项（编码侧可直接粘贴到 `known-drift.ts:48`）

```ts
export const KNOWN_DRIFT: readonly KnownDrift[] = [
  {
    id: "SKILL-DOC-ALIAS",
    ticket: "pending",
    doc: "docs/implementation/s4-smoke-design.md",
    summarize: () =>
      "skill 注入的文档/注释仍用旧块名 <available_skills>；injection/index.ts 仍称错端点 /v3/skill/search、旧块名 <cloud_skills>（runtime 文案 :280 为有意例外）",
    check: (root) => {
      const injIdx = fs.readFileSync(path.join(root, "src/injection/index.ts"), "utf8");
      expect(injIdx).toContain("/v3/skill/listing");
      expect(injIdx).not.toContain("/v3/skill/search");
      expect(injIdx).not.toContain("<cloud_skills>");

      const skillSrc = fs.readFileSync(
        path.join(root, "src/injection/injectors/skill-injector.ts"), "utf8",
      );
      const commentLines = skillSrc.split("\n").filter((l) => /^\s*(\*|\/\/)/.test(l));
      expect(commentLines.join("\n")).not.toContain("<available_skills>");
    },
  },
];
```

- **前置：`known-drift.ts` 当前没有任何 `import`**（纯接口 + 常量）。粘贴上面这段需在文件顶部补 `import fs from "node:fs";` 与 `import path from "node:path";`（与 smoke 用例的用法一致）。
- **`id` 字面量 `SKILL-DOC-ALIAS` 必须出现在本文档内**（即本节）—— `visible-archive-http-smoke.test.ts:789-793` 的联动断言就靠它。删漏本节 → 该断言变红，这是**有意**的。
- `doc` 指向本文档；开单后把 `ticket: "pending"` 换成真实单号。

### 9.2 机制改动（**必须**，否则登记项是空转的）

1. `KnownDrift` 接口**新增必填** `check: (root: string) => void`，语义 = "漂移被修好后**必须通过**的断言"。
2. 用例生成器（`visible-archive-http-smoke.test.ts:801-804`）改为 `it.fails(\`[KNOWN-DRIFT:${d.id}] ${d.summarize()}\`, () => { d.check(root); })`，并**删掉 `expect(false, …)` 恒假占位**。
   - 理由：恒假占位在 `it.fails` 语义下是"**永恒绿**"，登记项完全空转 —— 与 S4b 连撞的那个失效族（恒假/恒真）同源。用**类型必填**强制，不靠注释提醒。
3. `root` 复用 `:787-788` 既有解析（`[cwd, cwd/MemoryProxy]` 找 `package.json`），但要**提到 describe 作用域**（`:785` 下方）一次算好，供联动断言与 `check(root)` 共用 —— 现状它写在联动断言的 `it` 体内，生成器循环（`:796`）拿不到，直接照抄会传 `undefined`、`path.join` 抛错（而 `it.fails` 会把抛错也算"期望失败"⇒ **假绿**，正是同一族陷阱）。

### 9.3 `check` 断言为什么这样写（现状实测，2026-09-10）

| 断言 | 现状 | 修好后 |
|---|---|---|
| `injection/index.ts` 含 `/v3/skill/listing` | **不含**（0 处）⇒ `it.fails` 绿 | 含 ⇒ 通过 |
| 不含 `/v3/skill/search` | **含** 1 处（`:308`）⇒ 绿 | 不含 ⇒ 通过 |
| 不含 `<cloud_skills>` | **含** 3 处（`:308,310,316`）⇒ 绿 | 不含 ⇒ 通过 |
| `skill-injector.ts` **注释行**不含 `<available_skills>` | 含 10 处 ⇒ 绿 | 不含 ⇒ 通过 |

- 三条并列 ⇒ **半修不销案**（见 9.5）。
- **`check` 里那句 `commentLines` 过滤是必须的，不是洁癖**：`<available_skills>` 在 `:280` 是**运行时 warn 文案**，而 `expectNoSkillDegradation`（`:388`）正以 `degrading to empty` 为锚点。
- **有意排除 `:280`**：把它纳入断言会把工单目标指向一个**与断言锚点相冲突**的位置 —— 又是"字面锚点被改 ⇒ 断言静默恒真"那一族。改 `:280` 必须保留 `degrading to empty` 前缀，且属**另一条**工单。

### 9.4 验收口径（编码侧）

- **可改 = 10 处注释行**（实测行号，全为注释）：`skill-injector.ts` `:2,8,12,48,56,83,90,185,210,228`。措辞统一为 **"以 `## Skills (mandatory)` 开头的 listing 块"**（真首见 `:62`；块内**没有** `<available_skills>` 标签）。
- **例外 = `:280`**（运行时文案），本工单不动。
- **案①**：`injection/index.ts:308-310`（+ `:315-317` 的 `<cloud_skills>`）注释与实现对齐：**端点写明 `/v3/skill/listing`**、删掉 `<cloud_skills>` 旧块名、块名口径同本 9.4 第一条。"at prewarm time" 这句**先核 prewarm 真实调用路径再定**，别照抄。
- **销案动作**：`check` 转绿（= `it.fails` 报 `expected to fail but passed`，套件**红**）→ 删登记项 → 把 `check` 内容原样搬成 1 条**正面 `it`**（建议紧邻 B1/B2）。用例数不变。
- **不变量**：生产行为零改动；**登记期间 `npm test` 仍然全绿**（这是设计取舍，见 `known-drift.ts:21-24` 的诚实边界：本机制保证"漂移不能静默消失"，**不保证"漂移必须被修"**）。

### 9.5 变异测试（登记那一轮必须**实跑**，不接受口头声明）

1. **半修不销案**：只把 `skill-injector.ts:2` 一处注释改对 → 仍绿（案② 其余 9 处 + 案① 三条仍失败）。
2. **全修必销案**：10 处注释 + 案① 三行都改对、且**不碰** `:280` → `it.fails` 变红（`expected to fail but passed`）⇒ 销案路径有牙，且**不会误逼改 `:280`**。
3. **删锚点必红**：把本节里的 `SKILL-DOC-ALIAS` 字面量删掉 → 联动断言（`:786-794`）红。
4. （可选）**反向变异**：把 `check` 改成"连 `:280` 也干净" → 与 2 对照，证明例外口径被正确隔离。

### 9.6 数字预期

- **登记后**：冒烟 **9**（8 + 1 条 `it.fails`）；`vitest run src/injection` → 9 files / **92**；全量 16 files / **246**；`typecheck:baseline` **PASS — 55**；`git status --porcelain` 生产零改动。
- **销案后**：用例数不变（`it.fails` → `it`），仍是 9 / 92 / 246。
- 本节落地后本文档指纹变更，以新值为准。

---

## 10. 处理记录（第八轮 · 误因工单登记落地 + 三条变异，2026-09-10）

**范围**：只做 §9.1/§9.2 的登记与机制改动 + §9.5 三条变异。**生产行为零改动**（只动测试/helper/注释类文件）。
**执行方式**：本轮落地与变异**由 AI 会话直接执行**（编码侧委托）；下列数字全部为实跑输出，非声明。
**行号提示**：§9 中引用的 `:787-788` / `:796` 等是**施工前**的现状行号，落地后已漂移，以本节为准。

**落地（2 个文件）**：

- `_helpers/known-drift.ts`：顶部补 `node:fs` / `node:path` / `vitest` 的 `expect`（该文件此前**无任何 import**）；`KnownDrift` 新增**必填** `check: (root: string) => void`；`KNOWN_DRIFT` 登记第一条 `SKILL-DOC-ALIAS`（`ticket:"pending"`、`doc` 指向本文档）。
- `visible-archive-http-smoke.test.ts`（tripwire describe）：`root` 从联动断言的 `it` 体内**提到 describe 作用域**并加**硬校验**；生成器改为 `d.check(root)`，**删除 `expect(false)` 恒假占位**。

**两处比 §9.2 更严（都是闭洞，不是扩范围）**：

1. `check` 内部统一用 `expect.soft` ⇒ 半修时**一次列全全部未满足项**（销案进度可见）；已写进接口注释作为写法要求。
2. root 的硬校验必须**抛在 `it.fails` 之外** —— 抛在里面会被当成"期望失败"⇒ 基础设施坏了反而变绿（同一"恒假/恒真"族）。

**变异测试（三条全跑，均已还原）**：

| # | 变异 | 期望 | 实测 |
|---|---|---|---|
| 1a | 只改 `skill-injector.ts:2`（半修） | 不销案 | 冒烟 **9 passed** ⇒ 未误销案 |
| 1b | 同上 + 临时把生成器 `it.fails` 翻成 `it`（仅为看清单，已还原） | check 非空转 | **4 条 soft 违规一次列全**，第 4 条正是"剩余 9 处仍含 `<available_skills>`" ⇒ 确实读了文件 |
| 2 | 10 处注释 + `index.ts` 三行**全修**、且**不碰** `:280` | 销案红 | **1 failed \| 8 passed**，原文 `Error: Expect test to fail` ⇒ 有牙，且**不会误逼改 `:280`** |
| 3 | 删掉本文档里的 `SKILL-DOC-ALIAS` 字面量 | 联动断言红 | `expected '# S4 真实 HTTP 冒烟…' to contain 'SKILL-DOC-ALIAS'` |

**还原证明（无残留）**：被变异三份的 md5 与变异前**逐一相同** —— `skill-injector.ts` `a41846f3a80d1d82ad1ba18b9a00c816`、`src/injection/index.ts` `bf7e770a67728fe5284e88641494e519`、本文档 `54f6557d7e6eca65b6ee6b8d407ad3b6`；字面计数复原（`<available_skills>` 11、`<cloud_skills>` 3、`/v3/skill/search` 1，且剩余那 1 处 `<available_skills>` 正是 `:280` 运行时文案）；冒烟测试文件相对变异前备份的 diff **只有 §9.2 那两处**（root 提级 + `d.check(root)`）。

**数字（node v22.19.0）**：S4 冒烟 **9 passed**（S4a 5 + S4b 2 + 护栏 1 + 登记项 1）；`vitest run src/injection` → 9 files / **92 passed**；全量 16 files / **246 passed**；`typecheck:baseline` → `PASS — 55 errors, all within allow-list`；IDE 诊断 **0** 条；`git status --porcelain` **生产代码零改动**；无临时 dump 残留（迭代备份在仓库外，已删）。

**可从输出直接看到的效果**：每次 `npm test` 都会打出
`[known-drift] SKILL-DOC-ALIAS (pending) — skill 注入的注释仍用旧块名 <available_skills>；…`
—— 工单不再依赖任何人的记性。

**遗留**：`KNOWN_DRIFT` 现含 1 条。销案动作 = 按 §9.4 修注释 → 删登记项 → 把 `check` 原样搬成正面 `it`。工单本体（注释批）**仍未实施**。

---

## 11. 处理记录（第八轮补丁 · 落地推荐 1 与 3，2026-09-10）

**范围**：落地上轮汇报的推荐 **1（反向自证）** 与 **3（销案脚手架）**；推荐 **2（判据返回清单）** 作为 3 的副产品顺带落地；推荐 **4（`[known-drift]` 机读尾注）** 未做。只动 `_helpers/known-drift.ts` 与 smoke 用例 —— 生产代码继续零改动。
**执行方式**：同前，AI 会话直接执行；数字为实跑输出。

**#3 销案脚手架（判据与用法解耦）**

- 判据抽成命名导出 `skillDocAliasViolations(root): string[]`（返回**剩余违规清单**，`[]` = 已修好），语义一比一搬运（`index.ts` 3 条 + "仅注释行" 1 条）。
- 新增 `makeCheck(violations)` 工厂，登记项写 `check: makeCheck(skillDocAliasViolations)` ⇒ **断言层固化**："读了文件却忘了断言"这类空转在类型层面就写不出来；内部仍是 `expect.soft` + 数组 diff。
- 销案动作（§9.4）随之变成 `expect(skillDocAliasViolations(root)).toEqual([])` —— **判据只有一份**，杜绝"抄漏一条"。

**#1 反向自证（把"不许空转"从人工演示升级为常驻不变量）**

- 新增 smoke **表级**用例：对每条登记项用 `fs.mkdtempSync` 造的**空目录**当 root 调 `check`，断言**必须抛错**。
- 判据取"必须依赖 root"而非"必须断言"：真判据都要读 root 下的文件 ⇒ 读不到必抛。用**存在但为空**的目录（而非不存在的路径），连"只断言文件/目录存在"的伪判据也一并挡掉；临时目录在 `finally` 里 `rmSync` 清理。
- 表级用例由 1 条变 2 条（联动断言 + 反向自证），describe 标题同步改为「登记表为空时仍有两条表级断言」。

**变异矩阵（本轮 5 条，全部实跑并还原）**

| # | 变异 | 实测 |
|---|---|---|
| M1a | `skill-injector.ts:2` 半修 | **10 passed** ⇒ 新结构下仍不误销案 |
| M1b | 同上 + 生成器临时翻 `it` | `expected [ …(4) ] to deeply equal []` —— **4 条剩余违规一次列全**（数组 diff） |
| M2 | 10 处注释 + `index.ts` 三行全修、**不碰 `:280`** | **1 failed \| 9 passed**（`Expect test to fail`），两条表级断言仍绿 ⇒ 不误逼改 `:280` |
| M3 | 删本文档的 id 字面量 | 联动断言红：`expected '# S4 真实 HTTP 冒烟…' to contain 'SKILL-DOC-ALIAS'` |
| **M4（新）** | 判据写成 `() => []`（恒过 / 忽略 root） | **2 failed \| 8 passed**：反向自证红 —— `known-drift SKILL-DOC-ALIAS 的 check 在伪造 root 下居然通过 ⇒ 该登记项是空转（不读 root / 忽略 root / 恒过）`，`it.fails` 同步红。**上一轮只能靠人工演示的那件事，现在常驻** |

**还原证明**：被变异 5 份 md5 与变异前**逐一相同** —— `2849d7293e901cdd7f487650217b5780`（known-drift.ts）、`58759e5c59bf0d090e093dbf7c079f2f`（smoke）、`a41846f3a80d1d82ad1ba18b9a00c816`（skill-injector.ts）、`bf7e770a67728fe5284e88641494e519`（index.ts）、`0c7bc4aedeafdffdddb7e2646bf47e58`（本文档）；字面计数复原 11 / 3 / 1；`skill-injector.ts` 与 `index.ts` 相对备份 `diff` **无输出**。

**数字（node v22.19.0）**：S4 冒烟 **10 passed**（S4a 5 + S4b 2 + 护栏 1 + 表级 2）；`vitest run src/injection` 9 files / **93 passed**；全量 16 files / **247 passed**；`typecheck:baseline` → `PASS — 55 errors, all within allow-list`；IDE 诊断 0；`git status --porcelain` 生产代码零改动；无临时 dump 残留。

**仍留的建议（未做）**：④ `[known-drift]` 行加机读尾注（`id=`/`ticket=`）—— 等 automation 真要做时再加，零成本；以及"违规清单改违规码枚举"这种更细的度量（当前数组 diff 已够用）。

---

## 12. 交接书（给 coding session）—— SKILL-DOC-ALIAS 施工范围与销案操作卡（2026-09-10）

> 交给 coding session 前请先读 **12.1**：**不先落 commit 就不要交接**。
> 交付性质：**只改注释与日志文案，零行为改动**；销案凭证 = 用例数与基线数字**不变**。

### 12.1 落库前置（**硬阻断**，交接方负责）

工作树现状（`git status --porcelain` 实测）：S4 全套装置**全部 untracked** ——
`src/injection/__tests__/_helpers/`、`src/injection/__tests__/visible-archive-http-smoke.test.ts`、
`docs/implementation/{s4-smoke-design,s4-smoke-checklist,attribution-v2-review,p0-archive-review,s3-review}.md`，
另有 1 个 modified（`src/injection/__tests__/visible-archive-golden.test.ts`）。最后提交 `891a27a`（237 基线时代）。

- coding session 只看 git：**untracked 文件对它等于不存在**；切分支 / `stash` / `git clean` 一句话就没。
- 落 commit 后**行号才冻结**（12.2/12.3 的行号是该 commit 的实测值）。

### 12.2 案① 精确范围 —— `src/injection/index.ts`（只改 3 行）

| 行（当前实测） | 现状节选 | 要求 |
|---|---|---|
| `:308` | `// RAG-driven \`<cloud_skills>\` block. Calls /v3/skill/search at prewarm time.` | 端点改 **`/v3/skill/listing`**；块名改"以 `## Skills (mandatory)` 开头的 listing 块" |
| `:310` | `// will fail and the injector silently degrades to no <cloud_skills> block.` | 同上，去掉 `<cloud_skills>` |
| `:316` | `// dynamic \`<cloud_skills>\` block. Even when there are no skills to` | 同上 |

`:314`/`:307` 的 **`<skill_tools>` 是真块名，保留**（那是 `SkillToolsInjector` 的块）。

### 12.3 案② 精确范围 —— `src/injection/injectors/skill-injector.ts`

**待改 = 10 处注释行**（当前实测行号）：
`:2` `:8` `:12` `:48` `:56` `:83` `:90` `:185` `:210` `:228`

**⚠️ 别按"11 处"改**：实测 11 处同名里含 **`:280` 一处运行时文案**（`console.warn(… degrading to empty <available_skills> …)`）。它是我方 `expectNoSkillDegradation` 的**断言锚点**，按 11 处改会直接撞锚点 ⇒ 改注释与改断言互相掩盖。**`:280` 不动，且 `degrading to empty` 前缀必须保留**（改它属**另一条**工单）。

措辞口径：统一为「以 `## Skills (mandatory)` 开头的 listing 块」；**注释行里不得再出现 `<available_skills>` 字面量**（判据函数只扫注释行）。`wrapAvailableSkillsBlock` 这个**函数名不要改**（重命名有跨文件面，本工单只收敛注释与文案）。

### 12.4 越界清单（**不要动** —— 同名字面≠同一处漂移）

- `src/skill/core-client.ts:258`（`/v3/skill/search` 是**真 API**；`:5`/`:204`/`:297`/`:313` 同理）：这里写它**是对的**。
- `src/types.ts:315`（`<cloud_skills>` 描述）、`src/injection/injectors/skill-tools-injector.ts`（`:21`/`:24`/`:81`/`:92`/`:190`/`:195`）、`asset-reflection-injector.ts:16`、`agents/codebuddy/profile.ts:35`：兄弟 injector / 旁支注释，**不在本批**。
- `src/common/codex-injection.ts`、`common/workbuddy-injection.ts`、`agent-adapters/dsh.ts`、`session/codebuddy/init.ts:246`、`session/store.ts:684`、`codexHandler.ts:901`/`:905`：这些指的是**宿主客户端 prompt 模板**里的 tag（在那儿确实叫 `<available_skills>`），**不是**本 injector 的渲染块 —— 改它们是**语义错误**。

### 12.5 销案操作卡（5 步，按序）

1. 按 12.2 / 12.3 改注释。自检字面计数：
   `grep -c "<available_skills>" src/injection/injectors/skill-injector.ts` → **1**（只剩 `:280`）；
   `grep -c "<cloud_skills>" src/injection/index.ts` → **0**；`grep -c "/v3/skill/search" src/injection/index.ts` → **0**；`grep -c "/v3/skill/listing" src/injection/index.ts` → **1**。
2. 跑冒烟：`npx vitest run src/injection/__tests__/visible-archive-http-smoke.test.ts`
   → 期望 **1 failed | 9 passed**，且失败原文是 `Error: Expect test to fail` —— **这就是销案信号**。
   ⚠️ 若红的是「反向自证」或「联动断言」，那不是销案信号，是判据/基础设施坏了，不要顺势销案。
3. 销案：删 `KNOWN_DRIFT` 里那一条；加一条正面 `it` ——
   `expect(skillDocAliasViolations(root)).toEqual([])`（判据函数**原样 import**，`root` 用 describe 作用域里那个已硬校验的值）。**不要重写判据**。
   ⚠️ **落点是 known-drift tripwire describe 内，不是"紧邻 B1/B2"**（本条原写"B1/B2 附近"，已由设计侧确认**作废** —— 理由见 §13「设计侧确认」）。
4. 文档：§9 标为已销案 + 追加处理记录（工单号 / 行号 / 数字）；**不要删 §9 与 §11**（处置痕迹要留）。`KNOWN_DRIFT` 回到 `[]` 是**合法终态**；`known-drift.ts`、反向自证用例、`it.fails` 生成器**一律保留**。
5. 复跑并回传：冒烟 **10 passed**｜`src/injection` 9 files / **93**｜全量 16 files / **247**｜`typecheck:baseline` `PASS — 55 errors`｜`git status` 只有注释面改动。

**环境**：node **v22.19.0**（`export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"`）—— 否则 better-sqlite3 可能不可用 ⇒ `VisibleTextRepo` 静默降级 ⇒ **假绿**。

### 12.6 裁决（编码侧已定，2026-09-10；交接书自此不含待决项）

**1. `src/injection/index.ts:378` → 取（a）纳入本批。**

实测（本次复核）：`index.ts` 里 `<available_skills>` **恰好 1 处，且是注释行**（`:378`）；`<cloud_skills>` 3 处（`:308`/`:310`/`:316`）、`/v3/skill/search` 1 处（`:308`）、`/v3/skill/listing` **0 处**。⇒ 本批要改的 3 行 + 这 1 行，就是 `index.ts` 的全部漂移面。

- 取 (a) 的理由：**同一文件、同一不变量、同一 commit** —— 本批本来就要改该文件，多改 1 行边际成本≈0；留它会在**同一个文件里**留一处"只有它没改"的同名漂移（正是本轮勘误的同族，且更难发现）。判据扩展是**机械克隆**案②的"只扫注释行"技术，不引入新机制。
- 否 (b) 的理由：写"有意排除"的说明**比修 1 行还长**，且给未来读者留一个"这里为什么合法"的问题 —— 恰是 §9 要消灭的形态。
- **落地（判据第 4 条断言）**：`index.ts` 的**注释行**不得含 `<available_skills>`（沿用案②的 `commentLines` 过滤）。`:382` 的 `activeAssetTags.push("available_skills")` 是**代码字面量**、不受影响。
- **措辞**：注释须保留"资产 tag 名为 `available_skills`"这层信息（那是 wire contract，`:382` 不动），只是**不再用尖括号把它当块名**。

**2. `ticket` → 取 `"s4-smoke-design.md §12"`。**

- 理由：本仓是 **fork-local**（见 `764aa35` 提交信息"fork local"），**无外部 issue tracker** ⇒ 唯一"可追溯且不随 commit 漂移"的落点只能是**仓内**工单本体，而 §12 正是本工单的范围 + 销案操作卡。
- `pending` 的问题：它是 `it.fails` 标题与销案记录的落点，留 `pending` 会让销案记录**无处引用**。
- 落地（**实际未生效，如实记**）：本条原定把 `_helpers/known-drift.ts` 里该登记项的 `ticket: "pending"` 改成 `"s4-smoke-design.md §12"`，但**该串尚未落码，登记项就在本轮（第九轮）被销案删除** ⇒ `bf8af3d`（S4 装置落库那次提交）里它仍写作 `"pending"`。裁决值 `s4-smoke-design.md §12` 作为本条工单的追溯串记于本裁决与 §13。日后若开外部单，只需改这一个字符串（日志行与销案记录都从它派生）。

> §11 里 `[known-drift] SKILL-DOC-ALIAS (pending) — …` 那行是**第八轮实况**，按"处理痕迹要留"**不改**；本裁决自 §12.6 起生效。

---

## 13. 处理记录（第九轮 · SKILL-DOC-ALIAS 销案，2026-09-10，编码侧）

**前置**：先按 §12.6 定完两条裁决，再把 S4 全套装置落库为 **`bf8af3d`**（`test(proxy): S4 真实 HTTP 冒烟（接缝 A/B）+ known-drift 双向 tripwire（237→247）`，10 files）—— §12.2/§12.3 的行号即以该 commit 为基准；落库时 `git status --porcelain` 已干净（消掉"切分支 / stash 一句话就没"的硬阻断）。

**§12.6 裁决落地**
- **裁决 1 取 (a)**：判据新增**第 4 条断言** —— `injection/index.ts` 的**注释行**不得含 `<available_skills>`（机械克隆案②的 `commentLines` 过滤；`:382` 的 `activeAssetTags.push("available_skills")` 是**代码字面量**、不受影响）。⇒ 本批 `index.ts` 实改 **4 行**（`:308`/`:310`/`:316` + `:378`），不是 3 行。
- **裁决 2 未及落码（如实记）**：`ticket` 串 `"s4-smoke-design.md §12"` 尚未写进登记项，该登记项就在本轮被销案删除 ⇒ `bf8af3d` 里它仍写作 `"pending"`。追溯串记于 §12.6 与本节。

**施工（2 个生产文件，纯注释 / 文案，零行为改动）**
- `src/injection/index.ts`：`:308`/`:310`/`:316` —— 端点 `/v3/skill/search` → `/v3/skill/listing`、`<cloud_skills>` → "skills listing block"；`:378` —— `<available_skills>` → "skills listing 块（资产 tag 名为 `available_skills`）"，**保留** `<skill_tools>`（真块名）与 `available_skills`（tag 字面量，wire contract）。`:378` 由 2 行变 3 行 ⇒ 本文件净 **+1 行**。
- `src/injection/injectors/skill-injector.ts`：**10 处目标注释行等量替换**（`:2,8,12,48,56,83,90,185,210,228`），措辞统一为"以 `## Skills (mandatory)` 开头的 listing 块"；**`:280` 运行时文案不动**（`degrading to empty` 是 `expectNoSkillDegradation` 的锚点，归另一条工单）。
  - 口径校正（自查发现）：`git diff` 实测该文件是 **11 行改动**（`:2` **与 `:3`**、`:8`、`:12`、`:48`、`:56`、`:83`、`:90`、`:185`、`:210`、`:228`）—— `:3` 是 `:2` 那句的折行，随措辞变长一并调整。§12.3 的"10 处"是**目标行**数，不是 diff 行数，两者不冲突。

**自检字面计数（§12.5 步骤 1，逐项命中）**

| 表达式 | 期望 | 实测 |
|---|---|---|
| `skill-injector.ts` 里 `<available_skills>` | 1（只剩 `:280`） | **1** ✓ |
| `index.ts` 里 `<cloud_skills>` | 0 | **0** ✓ |
| `index.ts` 里 `/v3/skill/search` | 0 | **0** ✓ |
| `index.ts` 里 `/v3/skill/listing` | 1 | **1** ✓ |
| `index.ts` 里 `<available_skills>` | 0 | **0** ✓ |

**销案信号（§12.5 步骤 2，实跑）**：注释改完、登记表未动时跑冒烟 → **1 failed | 9 passed**，失败原文恰为 `Error: Expect test to fail`，红的正是 `[KNOWN-DRIFT:SKILL-DOC-ALIAS]` 那条 `it.fails`；**两条表级断言（联动断言 / 反向自证）仍绿** ⇒ 是销案信号，不是基础设施坏。

**销案动作（§9.4 原样执行）**
- 删登记项 ⇒ `KNOWN_DRIFT` 回到 `[]`（合法终态，非"待填"）。
- 判据函数 `skillDocAliasViolations` **原样 import**，在 smoke 加 **1 条正面 `it`**：`expect(skillDocAliasViolations(root)).toEqual([])`。**判据未重写**（只有一份）。
- `known-drift.ts` / `makeCheck` / 反向自证 / `it.fails` 生成器**全部保留**（下一条漂移复现时直接复用）。

**1 处落点偏离 —— 设计侧已确认：维持现状（2026-09-10）**：§9.4/§12.5 建议正面 `it` "紧邻 B1/B2"，但 §12.5 **同时**要求"`root` 用 describe 作用域里那个已硬校验的值" —— 那个 `root` 只在 **tripwire describe** 作用域里（`:793-799`，含 `throw` 硬校验）；搬到 S4b 附近必须再解析一份 root ⇒ 第二个真值源，与"单一硬校验"的设计相冲。故正面 `it` 落在 tripwire describe 内（`root` 现成），该 describe 标题相应改为"…两条表级断言 **+ 1 条已销案正面断言**"。

> **设计侧确认（2026-09-10，评审）**：**接受该偏离，维持现状**；§12.5 步骤 3 的"紧邻 B1/B2"**作废**。编码侧发现的是**我方规格内部矛盾**（那句"紧邻 B1/B2"与"单一硬校验"相冲），取**较强约束**解为正解。另三条支持理由：
> ① 本条断言的主题是**生产注释/端点的一致性**（仓级注释面），而 S4b describe 的主题是**接缝 A 的字节级 HTTP 真链路** ⇒ 放过去属**归类错误**，还会诱导后人以"跑题"为由清掉它；
> ② 销案产物的**同类**是两条表级断言与 `it.fails` 生成器 —— 四件套（联动 / 反向自证 / 正面断言 / 生成器）同处一个 describe，下一条漂移的登记人只需读**一个**地方就能拿到全套模板；打散一件反而削弱模板价值；
> ③ 可发现性不依赖位置：`known-drift.ts:20-28` 的两条硬约束注释 + describe 标题已点名"1 条已销案正面断言"。
>
> **残留边界（如实记）**：销案后这条正面 `it` 是**手写**的（不再是生成器产物）⇒ **删掉它不可检出**；而条目还在表里时用例由表生成、删不掉。这是销案固有的安全边界收窄，属"可接受但要知道"；若日后要恢复该性质需另设计（例如加一条"判据至少被 1 条用例消费"的表级断言），本次不做。

> 附带收益：登记表回空后，两条表级断言都是**空循环**（空转）—— 这条正面 `it` 成为判据**唯一非空转**的消费者，判据因此不会在销案后退化成摆设。

**变异测试（2 条，实跑后已还原）**

| # | 变异 | 实测 |
|---|---|---|
| M1 | 把 `skill-injector.ts:8` 改回 `<available_skills>` | **1 failed \| 2 passed \| 7 skipped**；`AssertionError: expected [ Array(1) ] to deeply equal []`，diff 点名"`skill-injector.ts` 注释仍用旧块名…" |
| M2 | 把 `index.ts:378` 改回 `<available_skills>`（专测**新加的第 4 条断言**） | 失败并点名 `injection/index.ts` 注释仍用旧块名 ⇒ 第 4 条断言不是备用轮胎 |

⇒ 案① / 案② / 新增第 4 条三个面**各自有牙**，正面 `it` 非空转。两次变异均已还原（现 `skill-injector.ts` 只剩 `:280` 一处字面、`index.ts` 为 0）。

**数字（编码侧，node v22.19.0，销案后）**：S4 冒烟 **10 passed**；`vitest run src/injection` → 9 files / **93 passed**；全量 → 16 files / **247 passed**；`typecheck:baseline` → `PASS — 55 errors, all within allow-list`。**与 §12.5 步骤 5 的期望（10 / 93 / 247）逐项相同** —— 销案前后用例数不变（`it.fails` → `it`），符合 §9.6 口径。

**顺带勘误 1 条（仅文档分项，不改代码）**：§10/§11 写"S4a 5 条"，实测 S4a 是 **4 条**（A1–A4）；冒烟 10 条的准确构成 = S4a 4 + S4b 2 + 护栏 1 + 表级 2 + 登记项 1。分项口径记于此，历史小节不回改。

### 54 · 既有 `typecheck:baseline` 红灯登记（2026-09-11，零行为）

> 登记目的：该门在**本系列（51/52/53）基线上就是 FAIL**，逐轮登记防下一轮把它误判成"本系列引入"。

- **实测原文**（`3b8f783` 上实跑；`f1df854`（51/52 落档）上复跑**逐字同一**）：
  `UNALLOWED  src/config.ts(527,41): error TS2339: Property 'skipAssetConfirm' does not exist on type '{ enabled?: boolean | undefined; maxRetries?: number | undefined; … }'.`
  `tsc-baseline: FAIL — 1 file|code outside allow-list (total 60 errors).`
- **归属**：`config.ts:527` 与 `types.ts:284` 同属 **`220af622`（chrishuan，2026-09-07，`feat: release v2.0.2-beta.1`）**；**upstream base 既有**：`git merge-base --is-ancestor 220af622 origin/feat/server_team` ⇒ exit 0（YES）；`git show origin/feat/server_team:MemoryProxy/src/types.ts | grep skipAssetConfirm` ⇒ 仅 `:284` 一处（即上游的 `RawYamlConfig.sessionInit` **同样缺**该字段声明）。
- **性质**：`loadYamlConfig` 是 `return parsed as RawYamlConfig`（当时实测 `config.ts:200`，**cast 非校验**）⇒ 运行时未知键不被裁剪、该字段照样读得到；**纯类型门**，非功能缺失。
- **本系列口径（51/52/53 三轮同一）**：同一条 UNALLOWED + allow-list（`scripts/qa/tsc-baseline.json`）**零新增** + 该门在 base 与每轮落档后同为 FAIL；`config.ts` / `types.ts` / `tsc-baseline.json` 在三轮的 diff 中**均未出现**（`git show --stat` / `git log --name-only` 分母式核对）。
- **处置**：**保持现状**。建议单开 upstream-facing 1 行修（`RawYamlConfig.sessionInit` 补 `skipAssetConfirm?: boolean`，注释照 `types.ts:284`）或上游提 issue —— **不在本系列做**（PR 主题污染 / 上游或自行修 → 冲突）。**不 re-baseline**：allow-list 是给"有意保留"的历史错误，此处是漏写的类型缺口，入清单 = 把上游缺口洗成有意。
- **回归窗口**：S4 期间该门为 **`PASS — 55 errors, all within allow-list`**（本文 §12 多处记录）⇒ 现在的 `FAIL（60 errors / 1 UNALLOWED）` 是**后续上游提交 `220af622` 那一行**带入，**不是 S0–S4 的遗产**。
- **行号位移口径（69 复核跟进 append；2026-09-12，append-only）**：本条的行号随 `config.ts` 增长而位移
  （527@3b8f783 → 553@67 → 566@69）；**判据 = 同一 UNALLOWED 条目（`config.ts|TS2339`，
  `skipAssetConfirm`）+ total 60 不变，不是行号**。（69 工单 §6 曾写"`typecheck:baseline` 逐字同"
  ——与同单 C3"config 三处同改（+13 行）"互斥、数学上不可达，**该措辞作废**，以本条为准；
  处置仍按上条"保持现状 / 不 re-baseline"——工具判据本就是 `file|code` 级，不涉行号。）
- **真库级断言附证据口径（69 复核跟进 append 2；2026-09-12，append-only）**：任何"真库未碰 /
  未增行"的声明，须附 **`shasum -a 256` + `.backup` 前后快照 + 三计数**（`attribution_events` /
  `attribution_status_events` / `attribution_judge_queue`）**前后各一份**；**只给文字断言不算证据**。
  （由来：69 P-0b 期间真库 mtime 两次跳动、写入者未定位而**行级内容可证未变**——首次冻结指纹
  `sha256=2858c0fb…`｜`size=339968`｜`events=192 / status=0 / judge_queue=1`，供今后前后比对。
  本条为**通用口径**，后续工单验收节直接引用即可。）
- **证书精度（复核二轮补强 append 3；2026-09-12，append-only）**：`proxy.db` 本体的 `sha256`
  **仅在 `-wal` 为空/不存在时**才是完整内容证书（WAL 未 checkpoint 的写入不在主文件里）；
  三计数为逻辑读（SQLite 自动合并 WAL）⇒ **逻辑级始终稳**。⇒ **取证姿势定死**：**字节级凭证 =
  `.backup` 快照的 `sha256`**（backup 产物自洽、不含未合并 WAL；且是本系列一直在用的取证手段，
  非新步骤）；**`.db` 本体 `sha256` 仅作参考**。（样例：本轮 `.backup` 的
  `sha256=e5865666fa878ddf26b12bf1634adecbccda44dc2ca284c9c38932b413361aed`，与复核方上一轮
  独立快照**逐字相同**；`wal_checkpoint(PASSIVE)=0|0|0` 时主文件证书与 backup 等价。）
- **上游 1 行修已独立开出（70 append；2026-09-12，append-only）**：该 UNALLOWED 已由**独立单**
  `fix/raw-yaml-skip-asset-confirm`（**`dfb676e`**；base `906b582`）修掉——`RawYamlConfig.sessionInit`
  补 `skipAssetConfirm?: boolean`（类型声明 + 照抄 `SessionInitConfig` 注释；**`+6/−0`**）；
  **只推 fork、未并入上游、不发 PR**。**本分支（`feature/attribution-v2`）保持红灯不变**：
  **不 cherry-pick、不 rebase、不改判据**。**判据分叉**：主系列 = "同一 UNALLOWED + total 60"
  （**仍 FAIL**）；修复分支 = "**59 + PASS**"。⚠️ **该门在修复分支上已由 FAIL 翻转为 PASS**
  ——留痕目的 = 防下一轮把"绿灯"当异常（或以"两处不一致"误判为漂移）。
  （实测注：`typecheck:baseline` 工具与测试套均为 **fork-local 产物、不在 `906b582`** ⇒ 修复分支上
  以 `tsc=59` + 主系列工作区**临时同款 patch** 实测 `PASS — 59 errors` / `544 passed`（已还原）为证。）
- **测试隔离与取证时机（73 append；2026-09-12，append-only）**：本系列曾长期**测试直连默认真库**
  （33 文件裸跑 ⇒ 真库主文件 sha/mtime 随每次 `npm test` 变；**逻辑三计数稳定、页/头部被改写**）。
  **隔离前**：任何"真库未碰"声明**必须在未跑 `npm test` 的窗口内取证**。
  **隔离后（73 落地起，见 73 报告 commit）**：该限制**解除**——`setupFiles` 每文件独享临时库（C1）
  + `getDb()` 真库守卫（C2，`try` 之外、`VITEST==="true"` 且解析到默认真库 ⇒ throw）
  + 10 文件 `delete → restoreIsolatedDbPath()`（C3）；**C4 实测**：跑全量前后 `.backup` sha256 /
  **主文件 sha256+mtime** / 三计数**逐字不变**（三套对照：跑前 / 全量后 / 反向控制后）。
  **取证清单升级为四件**：`.backup` sha256 + **主文件 sha256/mtime** + 三计数 + 无持有者。
- **真库守卫不可被吞（78 · O12；2026-09-12，append-only）**：73 的守卫靠 `throw`——**调用链上任意
  `try/catch` 都能把它降级成 warn**（73 C5 格 1 实测到过这种形态）。78 起改为**先记录、后 throw**：
  守卫触发时先写入模块级**违规账本**（路径 + 时间戳；`db/index.ts` 的 `_realDbGuardViolations`），
  再由 `isolate-db.ts` 的 `afterAll`（**在还原 env 之前**）断言两件：① **账本为空**；②
  `resolveDbPath() !== 默认真库`（抓"测试里 delete/覆盖过 env"的裸跑窗口）。
  **判据刻意不写严**：只要求"不是默认真库"——**不是**"等于 setup 的隔离路径"（13 个文件自设临时
  路径是合法做法）。决定性测试 = **故意 `catch {}` 吞掉 throw 后账本仍为 1** ⇒ "漏设必红"在该路径上
  **不再依赖调用链的 catch 行为**。**为什么需要它**：结构信号优先于人的自觉——不让防线强度取决于
  "没人手滑把它包进 try/catch"。同批残漏补齐：`teardownTempDb()` 的裸 `delete` 改为
  `restoreIsolatedDbPath()`（与 73 C3 同向）。
- **契约随代码入库口径（74 append 4；2026-09-12，append-only）**：任何**新增/改变行为或接口**的单，
  **验收证据里必须同批出现契约文件的 diff**（本系列契约 = `docs/implementation/*.md` 的对应段落；
  接口类 = 端点 + 字段级形状；口径类 = 对应 spec 的 append 段）。**只写在报告里不算**（报告不是
  契约载体）⇒ 这类遗漏从"复核时才被发现"提前到"**验收阶段就过不了**"。
  由来：S6→S7 交接时**接连两次**出现契约悬空（`69` 的 L1 接线契约、`72` 的 S7-a DTO 契约
  **均只在报告里**；且 `l1-wiring.ts` 曾引用**不存在的** `50 spec §20`）——说明"契约落仓"当时
  只靠当次执行者记得，缺结构性保证。
- **凭证分层口径（79 append；2026-09-12，append-only）**：本系列"真库未碰"的取证自本条起**分层**——
  **跨窗口/跨单**凭证 = **逻辑指纹**（`sqlite3 <backup 快照> .dump | shasum -a 256`）+ **全表计数**；
  **单窗口前后**凭证 = `.backup` 快照 `sha256`（+ 主文件 `sha256`/`mtime`；见 append 3 与 73 的"四件"清单）；
  **`.db` 本体 `sha256` 与 `mtime` 仅作参考**——WAL 打开/`checkpoint` 会改其字节与时间，
  **与"是否写入数据"无关**。
  由来（78 复核实测；**悬案收尾**）：69 P-0b 起挂了两轮的"真库 mtime 两次跳动、写入者未定位"，本轮定位为
  **WAL 打开-关闭 + checkpoint/truncate 的产物**——`proxy.db` 与 `proxy.db-wal`（**0 B**）**同刻**
  `mtime=05:45:11`；而全库时间戳最大值 = **2026-09-11 17:04:42Z**（`attribution_block_seen` /
  `attribution_message_snap` / `attribution_block_text` / `hook_cache` / `attribution_events` **全表一致**）
  ⇒ **字节与 mtime 会变而逻辑零变**。⇒ **观测姿势定死：只比逻辑指纹与全表计数，不比 `mtime`。**
  另：**三计数有盲区**——只覆盖全库 **11 张表里的 3 张**；`attribution_block_seen`（60）/
  `attribution_message_snap`（28）/ `hook_cache`（8）等**写得最多的表恰在盲区** ⇒ **跨窗口一律用全表计数
  或逻辑指纹**。（78 复核取样：`.dump` sha256=`eee69819…`、`.backup` sha256=`f00ab826…`、本体
  `sha256=23212979…`；**落库时必须当场重取**，不得照抄本节数值。）
  **待办（随单条，不单独排期）**：`src/__tests__/o12-db-guard-unguardable.test.ts` 的 **T1** 现把
  `PROXY_DB_PATH` 指向**真实字面路径**——守卫正常时不打开真库；但**守卫若被回归删除，该用例会真打开
  用户真库**（并执行 `journal_mode=WAL` + `runSchema`）。**下次动 `isolate-db.ts` / 该测试 / `db/index.ts`
  任一单时顺手改为临时 `HOME` 沙箱**（`os.homedir()` 跟随 `HOME` ⇒ 判据里的"默认真库"落在沙箱内；
  守卫照常触发、账本照常记、**断言与判据不变**）。
- **"全库时间戳最大值"取数精度（79 复核 append 2；2026-09-12，append-only）**：上一轮"由来"里写的
  `2026-09-11 17:04:42Z` 取自 **TEXT 列**（`attribution_block_seen` / `attribution_message_snap`，
  **秒精度**）；**全库最大实为** `attribution_events.created_at = 1789146283084`（**INTEGER epoch ms**）
  = **2026-09-11T17:04:43.084Z**（晚 1.084 s）。⇒ **取证口径："全库时间戳最大值"必须取所有时间列的
  最大**，并标明精度来源（TEXT 秒 vs INTEGER ms）——差 1 秒即可能改判"最后一次写入时刻"。
