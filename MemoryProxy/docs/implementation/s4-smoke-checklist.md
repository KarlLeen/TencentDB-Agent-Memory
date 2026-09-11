# S4 真实 HTTP 冒烟清单（40 spec §8.3 前站）

> 目的：闭合 P0 唯一未闭合验收 —— **转发前 `injectedBody` 字节硬比对（真实 proxy + 上游捕获）**。
> 依据：`MemoryProxy/docs/implementation/40-visible-text-archive.md` §8.3（:259-265）与 §3a 胶水例外（:102-103）。
> 本清单只描述"跑什么、怎么起、断言在哪、要哪些 stub"，不改生产代码。

---

## 0. 目标与通过标准

| # | 判定 | 依据 |
|---|---|---|
| A | 上游收到的请求体字段（anthropic `body.system` / openai `messages`）与归档侧 `window()` 还原串，**同规则剥离胶水后逐字节一致**（length + `Buffer.byteLength` + 内容三重断言） | §8.3 |
| B | 归档 piece 数 == 来源数；任一接缝漏档 → 还原串缺字节并带来源归属 diff（fail） | §8.3 |
| C | excluded（客户端自带 system / 非注入用户文本）**不进档** —— 反向证明无超采 | §3a :91 |
| D | 胶水（string 拼接 `\n\n`）只允许出现在接缝，且两侧同规则剥离；剥离后仍有差 → fail | §3a :102-103 |
| E | 按锚点 `(epoch, turn)` 取窗不混代（§8.4 已在等价层闭合，S4 复验真链路） | §8 第 4 条 |

---

## 1. 底座：本地 stub 上游（取代 dump 文件）

**关键发现（决定方案）**

- `PROXY_DEBUG_DUMP_BODY` 的转发前全文 dump **只挂在 openai 侧**（`src/handler.ts:310-325`）；
  anthropic 侧只有 `PROXY_DEBUG_DUMP_OUTBOUND_MD5` 的 **md5 日志**，没有正文字节（`src/anthropicHandler.ts:399-400`）。
- 因此"捕获 injectedBody"**不要依赖 dump**：让上游 stub 记录它收到的 `rawBody` —— 那本身就是 injectedBody，**零侵入、零生产代码改动**。
- 断言粒度：对 `rawBody` `JSON.parse` 后的 `system` / `messages` 字段做**字符串级**比对；**不要**比 HTTP 原始字节（proxy 会重新 `JSON.stringify`，字节序/空白不可控）。

**Stub 形态**：`node:http` server（无新依赖，约 40 行），记录 `{path, headers, rawBody}`，按协议回 canned 响应：

```jsonc
// anthropic (/v1/messages)
{"id":"msg_stub","type":"message","role":"assistant","model":"stub",
 "content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1,"output_tokens":1}}
// openai (/v1/chat/completions)
{"id":"chatcmpl-stub","object":"chat.completion",
 "choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],
 "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}
```

- 全部 fixture 用 `stream:false`，避开 SSE 分支；响应必须严格合法，否则触发 proxy 重试/降级分支。
- 端口：上游 stub `18701`（openai）/ `18702`（anthropic）；内核 stub `18420`；proxy `18096`。
- 仓库现状：`src` 下**无** `createServer/listen` 先例，vitest 全是纯函数 + fake repo —— S4 是本仓库第一处真 HTTP 装置。
  `scripts/qa/cc-session-reset-smoke.py` 是 pexpect 起真 CC 的交互冒烟，可参考交互姿势，但本切片不复用。

---

## 2. 环境变量与 config

**启动**：`node --import tsx/esm src/index.ts --config config.s4.yaml`
（`scripts/proxy.sh` 硬读 `config.yaml` → S4 用独立 yaml + 独立端口，避免污染默认 `8096`，见 `src/config.ts:15`）

| 变量 | 值 | 作用 / 证据 |
|---|---|---|
| `PROXY_DB_PATH` | `/tmp/s4-smoke/proxy.db` | 隔离归档四表；优先于 `~/.tdai-memory-proxy/proxy.db`（`src/db/index.ts:32`） |
| `PROXY_DATA_DIR` | `/tmp/s4-smoke/data` | 注入层 fs 后端 / 绑定态隔离（`src/injection/index.ts:225`） |
| `PROXY_DEBUG_DUMP_BODY` | 可选 `/tmp/s4-smoke/outbound` | openai 侧转发前全文 dump（anthropic 无；见 §1） |
| `PROXY_DEBUG_DUMP_OUTBOUND_MD5` | `1` | 两侧 md5 日志，做跨轮前缀稳定性对照（KV cache 前提） |

**`config.s4.yaml` 关键段**（最小外部依赖面）

```yaml
server: { port: 18096 }
upstream:
  url: "http://127.0.0.1:18702"        # 按协议切 18701/18702
auth: { enabled: false }                # 免 /v3/meta/auth/verify；debug 路径 userId 空也走 forcedUserId
sessionInit:
  enabled: true
  debugForceIdentity: { team_id: "t-debug", agent_id: "a-debug", task_id: "k-debug" }
injection:
  enabled: true
  injectors: ["knowledge"]              # ⚠️ 不能为空：pipeline 仅在 ≥1 injector 时执行。勘正 2026-09-10：原写 ["skill"]——SkillToolsInjector 对 "skill" 无条件注册且总是产块，会把 anthropic body.system 变数组；knowledge 默认 enabled=false ⇒ gate 开但零 hook 产块（见 design §4 勘正）
  visibleArchive: { enabled: true }     # 可选 maxBlockChars/maxMessageChars 调小以覆盖截断
  attributionEvents: { enabled: false }   # 隔离矩阵
  decisionUnitExtractor: { enabled: true } # 档② 依赖该调用区被激活（40 spec §4/§1b）
redis: { enabled: false }
storage: { enabled: false }
costGuard: { enabled: false }
extraction: { enabled: false }
langfuse: { enabled: false }
opik: { enabled: false }
clickhouse: { enabled: false }
rateLimit: { tpm: 100000000, qpm: 100000 }   # 防 429
skill: { endpoint: "http://127.0.0.1:18420", serviceToken: "local" }
tdai:  { endpoint: "http://127.0.0.1:18420", enabled: false }
```

**内核 stub 端点（session-context 详情必需 —— 否则 `systemAppend=null`，seam B 不成立）**

| 端点 | 回包 | 证据 |
|---|---|---|
| `POST /v3/meta/agent/get` | 外层 `{code:0,message,data}`，**`data` 就是实体本体** `{agent_id, name, description, prompt}` | `src/meta/client.ts:294,472-479,562-566`（勘正 2026-09-10：**别**再包一层 `{agent:{...}}`，`getOne` 直接 return `data`，包错只静默 undefined → 假绿）；`session/claude-code/init.ts:422`+ 内 `metadataClient.getAgent` |
| `POST /v3/meta/task/get` | 同上；实体是 `{task_id, title, description, ...}`（**勘正 2026-09-10**：`TaskEntity` 没有 `name`/`goal`，只有 `title`，下游映射 `name: task.title`） | `src/meta/client.ts:299,74-82`；`src/session/store.ts:579` |
| `POST /v3/meta/participation-log/append` | 200（fire-and-forget） | `src/meta/client.ts:390` |
| `POST /v3/skill/listing` | 1 条 skill：返回 `ListingResult { mode:"full", listing:"<core 预渲染文本，须含稳定 asset id>", hits:[{skill_id,version,name}] }`（产生确定性档① 渲染块） | `src/skill/core-client.ts:316-321`（**勘正 2026-09-10 第三轮**：原写 `/v3/skill/search` —— 那是本 injector **不用**的另一条 API；端点错了会落到 stub 兜底 `{}` → `listing` undefined → 0 块 → 假绿。详见 design §5.7） |
| 可选 `POST /v3/meta/team/list\|agent/list\|task/list` | 列表 | `src/meta/client.ts:255/274/285` |

- `debugForceIdentity` **只绕过交互表单，不绕过详情获取**：`completeRegistration` 仍打 `getAgent`/`getTask`（`src/session/claude-code/init.ts:632-683`）。
- 确认 pipeline 真跑了：看 `[injection-debug] ... injectionEnabled= injectors=`（`src/anthropicHandler.ts:727` / `src/handler.ts:813`）。

---

## 3. fixture 形态（对齐 §8.3 三形态 + §8.4 compaction）

**会话锚定**：优先用 `x-claude-code-session-id`（`src/session/session-key.ts:9-17`，优先级高于 agent-profile 推导），一个 fixture 一个 id，跨轮复用。

| ID | 形态 | 期望（剥离断言点） |
|---|---|---|
| **F1** | anthropic **string system**（CC 形态，无胶水，B1 主战场）：`system:"You are Claude Code."` + 1 user | 上游 `body.system` == excluded 原文 + `\n\n` + session-context 块；归档还原侧同规则 → 逐字节一致；块内容与 `initResult.systemAppend` 逐字节相同（`src/anthropicHandler.ts:939-962`） |
| **F2** | anthropic **array system**（末块带 `cache_control`） | 追加 **plain** text block；原块字节未动、`cache_control` 位置不变、**新块无 cache_control**（`context-injector.ts:82-84`、`appendBlockToAnthropicSystem:278-287`） |
| **F3** | openai **string system** + 两轮重注入（胶水主战场） | 第二请求同 system → `\n\n` 拼接处剥离后一致；**次轮 text 行 0 新增 / seen +1**（§8 第 1 条） |
| **F4** | openai **array system** | `messages[0].content` 为数组且长度 +1，原块字节不变（`context-injector.ts:87-92`） |
| **F5** | 跨轮工具循环：req1 `system+user` → req2 追加 `assistant` + `tool_result`(role=tool) | 水位推进、`tool_result` 原样入 `message_snap`、`turn_seq` 与档① 同步 |
| **F6** | compaction：req3 把 messages 截断为更短 | `epoch+1` / `last_seen=0` 重放；`window()` 默认只含新代消息；`archive()` 两代并存（§8 第 4 条真链路复验） |
| **F7** | cap：一条 ~24k `tool_result`（< cap）+ 一条 > `maxMessageChars` | 前者 `truncated=0`/`chars=原长`/`content_json` 逐字节一致；后者 `truncated=1`/`chars=原长`/前段落库（§8 第 2 条） |

**每形态统一断言 4 步**

1. `stripGlue(上游 system/messages 文本串)` == `stripGlue(window() pieces 拼接串)`，逐字节（3 重断言）
2. `pieces` 数与来源数一致；excluded 原文不出现在任何 piece
3. 直查 sqlite（四表 + `attribution_archive_watermark`）行数 / `epoch` / `turn_seq` / `truncated` 与期望
4. `PROXY_DEBUG_DUMP_OUTBOUND_MD5`：跨轮同前缀 md5 稳定（KV cache 前提）

**负例**：`visibleArchive.enabled=false` → 四表 0 行、上游 body 照常（缺省 off 回归）。

---

## 4. 前置改动评估

| 项 | 结论 |
|---|---|
| 生产代码改动 | **0**（stub 方案零侵入） |
| 若需留证文件 | 可给 anthropic forward 点加 env-gated dump（与 `handler.ts:310-325` 同款），**单独 commit、dev-only**；非必需 |
| 测试/脚本落地位置 | 建议 `scripts/qa/s4-smoke/`（stub + 断言脚本）+ 结果记录进 review 文档 §8 |

---

## 5. 运行步骤（骨架）

```bash
mkdir -p /tmp/s4-smoke/{data,outbound}
node scripts/qa/s4-smoke/kernel-stub.mjs &          # 18420
node scripts/qa/s4-smoke/upstream-stub.mjs &        # 18701/18702
cd MemoryProxy && PROXY_DB_PATH=/tmp/s4-smoke/proxy.db \
  PROXY_DATA_DIR=/tmp/s4-smoke/data \
  PROXY_DEBUG_DUMP_OUTBOUND_MD5=1 \
  node --import tsx/esm src/index.ts --config config.s4.yaml &
curl -sf http://127.0.0.1:18096/health                 # ready
# 逐 fixture：
curl -sS -X POST http://127.0.0.1:18096/claude-code/debug/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-claude-code-session-id: s4-f1' \
  -d @f1.json
sleep 0.3   # 等 fire-and-forget 归档落库
# 读 stub 记录 + sqlite，跑断言脚本
kill %1 %2 %3; rm -rf /tmp/s4-smoke
```

---

## 6. 风险 / 诚实说明

- **档② 依赖 `decisionUnitExtractor` 调用区激活**（40 spec §1b/§4）；若只开 visibleArchive 而 injectors 空，档②/档① 可能都不落 —— 先按 §2 的 `injectors: ["knowledge"]`（勘正 2026-09-10，原写 `["skill"]`）+ kernel stub 保证 pipeline 执行。
- 会话级 state 走 redis/storage 兜底 fs，**重复跑必须清 `/tmp/s4-smoke`**，否则 epoch/水位残留会让 F6 假红。
- `resolveSessionKey` 在无 conversation header 时回落 agent-profile / keyId（`src/guard-adapter.ts:386`）—— 所以 fixture 必须带 `x-claude-code-session-id`（或 `x-conversation-id`），否则归档键不可预期。
- 上游 stub 响应若非法会触发重试/降级分支，掩盖真实 body 对比。
- 本清单**不含** §8 其余四条（等价层已闭合）；S4 只补真实 HTTP 这一段。

---

## 7. 与已闭合验收的关系

| §8 验收 | 现状 | S4 动作 |
|---|---|---|
| 1 静态注入块首轮/次轮 | 等价层已闭合 | F3 真链路复验 |
| 2 fetched 召回样本还原 | 等价层已闭合 | F7 真链路复验 |
| 3 injectedBody 字节硬比对 | **待 S4** | F1/F2/F4 主战场 + 胶水剥离 |
| 4 compaction 合成会话 | 等价层已闭合 | F6 真链路复验 |
| 5 toggle 矩阵 + tsc | 已闭合 | 负例回归 + `typecheck:baseline` 复跑 |

---

## 处理记录（2026-09-10，编码侧回传；正文未改）

S4a 已实现并全绿。**逐条对照本 checklist 的偏差**（完整版见 `s4-smoke-design.md` 文末同节）：

1. **§2 kernel stub 响应形状要改**：`data` 必须是**实体本身**（`data.agent_id` / `data.title`），不是 `{agent:{...}}`。`MetadataClient.getOne` 直接返回 `data`，包一层不报错、只会静默把 detail 变成 undefined → 空块 → 假绿。另注意 codebuddy 侧 task 映射读的是 **`title`**（不是 `name`），stub 里两个字段都给最稳。
2. **S4a 的 injector 用 `["knowledge"]`（`knowledge.enabled=false`），不是 `["skill"]`**：`SkillToolsInjector` 对 `"skill"` 无条件注册且总是产块，会把 anthropic 的 `body.system` 变成数组，破坏 checklist §2 A1 的"上游 body.system == excluded + \n\n + 归档块"（string）断言。`["knowledge"]`+disabled 能做到"gate 打开但零 hook 产块"，正好只验接缝 B。
3. **负例期望修正**：`injectors=[]` 打掉的只是注入 pipeline；接缝 B 与 injectors 无关，负例下上游**仍含** `<session_context>`、档① 仍有 session-context 行。真正的 pin 是「**渲染块档① 行数 = 0** + 首行 `injectors=[]` + 无 `entering injection pipeline`」。
4. **§5 真链路断言只覆盖 string 形态 system**：array 形态（含 `cache_control`）走用例直接断块数组（A2），不进 `rebuildInjectedBodyFromArchive`。
5. **跑测命令**：需要用 node **v22.19.0**（`export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"`），否则 better-sqlite3 可能不可用 → VisibleTextRepo 静默降级 → 假绿。测试已自带 SQLite 落地断言。
6. **unifiedExtractor 等价例外（R4）**：本次 A1-A4 用 `injection.decisionUnitExtractor.enabled=true` 打开档②调用点；未覆盖 `unifiedExtractor` 的等价例外分支（属 R4 内容）。

---

## 处理记录（第二轮，2026-09-10，编码侧回传；正文未改）

三个钉子已落地（完整表格见 `s4-smoke-design.md` 同节）。与本清单直接相关的两点：

- **§2「kernel stub 端点」表的 `/v3/skill/search` 行**：`_helpers/s4-stubs.ts` 该分支已加「S4b 扩展点」注释 —— S4b 要让它返回 **1 条确定资产**、携带**稳定可识别 asset id**，且返回形状**先读 `src/skill/core-client.ts` 的真实解析再定形**（同 §2 勘正的教训：包错一层不报错、只静默假绿）。用例侧要断该 asset id **出现在上游 rawBody 字节里**，不要只断"块存在 / `block_seen` 行数 +1"。
- **覆盖边界**：本清单 §3「每形态统一断言 4 步」目前只在 `injectors=["knowledge"]` + `knowledge.enabled=false` 下验证了**接缝 B**；**渲染块档① 的归档 + 注入尚未验证**（S4b）。「S4a 全绿」不等于接缝 A 已验。

## 设计侧补注（第三轮，2026-09-10，核到源码）

上面第二轮记录里指向 `/v3/skill/search` 的那段**已被勘正**：S4b 的扩展端点是 **`/v3/skill/listing`**（返回 `ListingResult`，`core-client.ts:205-209,316-321`），`/v3/skill/search` 是该 injector 不走的另一条 API。另有三条**静默降级**必须在 S4b 先钉死（`(none)` 哨兵 / catch 降级 warn / 缺 identity 直接 skip），并沿用 `hasAgentDetail` 手法加正向证据（`[skill-injector] … mode=full hits=1 listingLen>0` + 上游 rawBody 含稳定 asset id + 无 `degrading to empty`）。完整起跑线见 `s4-smoke-design.md` §5.7。

**§5.7.1（同日追补，针对第三轮 ④）**：④「两个渲染块 ⇒ `body.system` 变数组」**结论对、机理要改** —— 判据不是块数，而是**锚点 `{slot:"skills"}` 是否解析成功**：命中（prompt 含 `# Session-specific guidance`）→ `pipeline.ts:362-371` 重建成**单块** ⇒ 仍 **string**；未命中（S4a 朴素 prompt）→ warn + `applyByPoint` push 新块（`context.ts:87-89`）⇒ **array**。所以 S4b 要**先断那行 anchor warn 在/不在**，再由分支定形状（细节 + 断言配方见 design §5.7.1）。另记一条工单草案：`injection/index.ts:308-310` 陈旧注释（`/v3/skill/search` + `<cloud_skills>`），纯注释修，**不并入 S4b 同批**。

---

## 处理记录（第三轮，2026-09-10，编码侧回传；正文与设计侧补注均未改）

- **代码已迁**：`_helpers/s4-stubs.ts` 现为 `if (path.endsWith("/skill/listing"))` 分支承载「S4b 扩展点」注释（S4a 不可达，行为零变化）；`/skill/search` 分支保留但改注为"本 injector 不走，S4b 不要在此造资产"。
- 上表 §2 的 `/v3/skill/listing` 行与本轮 ✅ 一致；**本清单 §2 勘正已生效**，无需再改。
- 第二轮记录里那句"§2 表的 `/v3/skill/search` 行 / 该分支已加注释"是**当时的实况**，保留以存历史（此处即为勘误痕迹）。
- **新增一条 S4b 前提**（§5.7 未含，建议补）：`injectors` 含 `"skill"` 时**连带**注册 `SkillToolsInjector`，它**总是**产出 `<skill_tools>` 块（`injection/index.ts:307-320`）⇒ 渲染块是**两个**、anthropic `body.system` 变**数组**，别按 A1 单块 string 写。
- 复跑：S4 冒烟 **5 passed**；`vitest run src/injection` 9 files / **88 passed**；全量 16 files / **242 passed**；`typecheck:baseline` `PASS — 55 errors`；`git status` 生产代码零改动。

---

## 处理记录（第四轮，2026-09-10，编码侧回传；正文与设计侧 §5.7.1 均未改）

- **④ 机理更正接受**：`body.system` 形状的判据是**锚点 `{slot:"skills"}` 是否解析成功**，**不是块数**（完整推导见 design §5.7.1）。`s4-stubs.ts` 的 ④ 已拆为 ④（连带注册 ⇒ 两块：`<skill_tools>` + `<available_skills>`）+ ⑤（锚点决定形状 + 两条分支的代码路径 + "1 块 fallback 也 array / 2 块锚点仍 string"反例 + S4b 先钉 unresolved 行再由分支定形状）。
- **编码侧自查同类**：`_helpers/attribution-window.ts` 先前也把该机理写成"注入渲染块 ⇒ 数组"，已一并收紧（该文件不在本清单内）。
- 本轮仅注释改动，**零行为变化**；生产误因工单按裁决**单开纯注释批、不并入 S4b**。
- 复跑：S4 冒烟 5 passed｜`vitest run src/injection` 9/88｜全量 16/242｜`typecheck:baseline` `PASS — 55 errors`｜`git status` 生产代码零改动。

### 第四轮追记后的两处收尾（2026-09-10，编码侧）

- **smoke `:418` 同款措辞已修**：补限定"本例块独立来自客户端 array + handler 层 append（`context-injector.ts:278-287`），不经 pipeline 锚点路径；锚点路径会重建成单块，形状判据是锚点解析、不是块数"。断言未动。
- **消歧**：`s4-stubs.ts` 5 处裸 `core-client.ts` → **`src/skill/core-client.ts`**（另有 `src/knowledge/core-client.ts` 同名）；`skill-injector.ts` 全仓唯一，保留短写。
- 同一错法编码侧共 3 处（`s4-stubs.ts` ④ / `attribution-window.ts` / smoke `:418`），口径已统一为"**形状由锚点解析决定**"，详见 design §5.7.1。

### S4b 落地（2026-09-10，编码侧；详见 design §7）

- **三件事按顺序做完**：读 §5.7 → §5.7.1；先钉锚点分支（`console.warn` 行，**须先给 `startLogCapture` 加 warn spy**，否则断言恒假/恒真）；再把 `/skill/listing` 换成 1 条资产（asset id 进 `listing` 正文、避开 `(none)`）。
- **B1 未命中 → array 3 块**：`[0]`=客户端 string+`SEAM_GLUE`+session-context（handler 先拼）、`[1]`=`<skill_tools>`、`[2]`=`## Skills (mandatory)` 开头的 listing 块。
- **B2 命中 → string**：两块插在 `# Session-specific guidance` **之前**（**不是**追加末尾）。
- **两个字面坑**：① `<available_skills>` **不存在**于渲染块，用它当证据会误绿（真标记是 `## Skills (mandatory)`）；② `listingLen>0` 不证明块被渲染（`(none)` 哨兵在日志之后才丢）⇒ **字节断言是唯一承重墙**。
- 变异测试：listing 换成 `(none)` → B1/B2 双红、失败点即字节断言 ⇒ 断言非空转（已还原）。
- 数字：S4 冒烟 **7 passed**｜`src/injection` 9 files / **90**｜全量 16 files / **244**｜`typecheck:baseline` `PASS — 55`｜生产代码零改动。

### S4b 收口（2026-09-10，编码侧；独立复核后）

- **独立复核一致**：全量 244 / 冒烟 7 / typecheck PASS / 文档指纹一致 / 生产零改动 —— 双方逐项相同。
- **别名残留已修**：`:105` 的 `<available_skills>` → "以 `## Skills (mandatory)` 开头的 listing 块"（纯一致性，断言未动）。相对序断言（`:732-734`）保持**相对**、不写死偏移 —— 这点处理正确。
- **护栏按"泄漏"写**（新增 1 条自足用例）：`stop()` 后断"数组不再增长 + `console.log/warn` 已还原"，**不**拿 stderr 可见性当主判据（vitest 自身写 stderr、`[identity]`/`[REQ]` 是 logger 直写）。护栏自身变异测试：抽掉 `stop()` → 立即红（`expected 2 to be +0`），已还原。
- **误因工单扩为 2 条**（仍单开、不并入）：案① `injection/index.ts:308-310`；案② `skill-injector.ts` 的 **11 处**同名残留（实测量；非 12）。⚠️ `:280` 的 `degrading to empty` 是我方断言锚点，改文案须保留该前缀。
- 数字（本轮）：S4 冒烟 **8**｜`src/injection` 9 files / **91**｜全量 16 files / **245**｜`typecheck:baseline` `PASS — 55`｜生产代码零改动。

### SKILL-DOC-ALIAS 销案（第九轮，2026-09-10，编码侧；详见 design §13）

- **前置（硬阻断）**：S4 全套装置先落库为 `bf8af3d`（10 files）—— 原先 `_helpers/`、smoke、4 份 docs 全是 untracked，切分支 / stash / clean 一句话就没；§12.2/§12.3 的行号自该 commit 冻结。
- **两处生产注释对齐（零行为）**：`injection/index.ts` **4 处目标行**（`:308`/`:310`/`:316` + `:378`——后者是 §12.6 裁决 1 决定纳入的）＋ `injectors/skill-injector.ts` **10 处目标行**（`:2,8,12,48,56,83,90,185,210,228`）。措辞统一为"以 `## Skills (mandatory)` 开头的 listing 块"。`git diff` 实测改动行数为 index.ts **13 行**、skill-injector.ts **11 行**（目标行语境折行所致，如 `:3` 随 `:2` 折行调整）—— 口径按"目标行"记。
- **`:280` 明确不动**：`degrading to empty` 是 `expectNoSkillDegradation` 的锚点 —— 若按"11 处"改会直接撞断言（§12.3 已纠偏为"10 处注释 + `:280` 不动"）。
- **判据第 4 条断言**（`index.ts` 的**注释行**不得含 `<available_skills>`）随裁决 1 加入；只扫注释行，`:382` 的 tag 字面量不受影响。
- **销案信号**：登记表未动时跑冒烟 = **1 failed | 9 passed**，原文恰为 `Error: Expect test to fail`，两条表级断言仍绿。
- **销案动作**：登记项删 ⇒ `KNOWN_DRIFT = []`（合法终态）；判据**原样 import** 成 1 条正面 `it`（未重写，判据只有一份）；`known-drift.ts` / `makeCheck` / 反向自证 / `it.fails` 生成器**全保留**。
- **1 处落点偏离**：正面 `it` 落在 tripwire describe（§12.5 要求复用的那份硬校验 `root` 仅此处有）；未按"紧邻 B1/B2"的建议搬去 S4b，以免造出第二个 `root` 真值源。
- **变异测试**：M1 塞回 `skill-injector.ts:8` → 红并点名该文件；M2 塞回 `index.ts:378` → 红并点名该文件（专测新第 4 条断言）。两次均已还原。
- 数字（销案后）：S4 冒烟 **10**｜`src/injection` 9 files / **93**｜全量 16 files / **247**｜`typecheck:baseline` `PASS — 55`｜生产代码零行为改动 —— 与 §12.5 步骤 5 期望逐项相同。
- 勘误（仅分项口径）：design §10/§11 的"S4a 5 条"实为 **4 条**（A1–A4）；冒烟 10 = S4a 4 + S4b 2 + 护栏 1 + 表级 2 + 登记项 1。

### 53 · 锚点重登：会话头名单（2026-09-11，编码侧）

- **被改的锚点**：§3 `:106`「会话锚定」按行号引 `src/session/session-key.ts:9-17`（= 该文件的会话头名单）。
- **变更**（`53-identity-deadcode`）：`resolveConversationId(c)` 退化为薄包装，名单挪进新函数
  `resolveConversationIdFromHeaders`；行号因此不再稳定。本轮实测快照（仅记录，不作判据）：
  薄包装 `:9-11`、新函数文档注释 `:13-20`、签名 `:21-23`、名单 `??` 链 `:24-31`、文件共 48 行。
- **重登口径**（沿用 45-bridge 勘正 10 的纪律）：后续判据**只按符号名引用**
  `src/session/session-key.ts` 的 `resolveConversationIdFromHeaders`，**不再抄行号**。
- **§3 `:106` 的语义未变**：`x-claude-code-session-id` 仍是名单里第 3 优先级（前两名 `x-conversation-id`
  → `x-session-id`）；fixture 只带这一个头时，取值结果与 53 前**逐字相同**（15 格同键矩阵 + 反向控制
  实测见 `53-identity-deadcode` 报告）。
