# P0 spec（正式 40 spec，v2 定稿）— 可见证据统一归档（U：两档 + 拼接窗口）

> 状态：正式 spec v2 定稿（2026-09-09）。v1 经评审：**通过、无 blocker**，5 条 B 级 + 4 条 C 级；
> v2 逐条落实 B1–B5，采纳 C1（四表命名冻结 = 本稿正文）。随 V2 分支（DR-9，
> `feature/attribution-v2` @ 基线 `764aa35`）落档为 `MemoryProxy/docs/implementation/40-visible-text-archive.md`，
> 正文即草稿 v2，不再另等一轮命名确认。因本稿占用 40 号，master spec §9 中原 40 号 S4 文档
> **顺延为 `45-bridge-telemetry-sink.md`**（编号更新已在 00-master-spec §9 同步）。
> 依据：立项 spec `attribution-v2-boundary-scope.md` §1 P0 行、§5 锚点表、§7 DR-2/DR-10、§4 红线；
> 量级采样 `v2-init/p0sample-sampling.md`（仓库外 scratch，可能已清理）。仓库基线 `feature/attribution-event-capture` @ `764aa35`（采样已还原，零残留）。

## 0. R1 评审修订对照

| 条目 | 评审要点 | v2 落实 |
|---|---|---|
| B1 | 档①"全部渲染 block"是假设：anthropic `systemAppend`（session-context）直改 `body.system`，不经 hook.done，两档同漏 | §3 新增合成块捕获点 + **§3a 可见正文来源→接缝对照表**；验收③升级为**转发前 injectedBody 全文 golden 字节硬比对**（§8.3） |
| B2 | 互斥断言会在合法数据误红（skill_view 返回含注入段全文的 tool_result） | §7.7 收窄为"**本回合非 tool 新消息 vs 本回合 blocks**" + 违规分类输出；tool/system 行合法例外 |
| B3 | runner 无 turnSeq 参数，档② 拿什么落 turn_seq 未定义 | §4.2 与 extractor **共用轮次推导**（`countHumanTurns` 前缀计数，实证同源）；runner 侧不透传 turnSeq 参数，改由档② 模块在调用点推导 |
| B4 | DB 水位未继承 runner 内存水位 compaction 归零；compaction 后拼接窗口是归档超集 | §4.1 **epoch + 归零重放**（镜像 runner.ts:126-127 判定）；§5 改**分侧诚实表述** + S5 交接 |
| B5 | 去重键文案与 SQL 打架；§5 跨档去重 schema 不可实现；order 列不存在；source 取值未定 | §3/§6 统一 `content_hash` 全局唯一、source 纯标注；跨档去重移到 **read 期**选项；排序承诺改 API 层；source 取值规则明确 |
| C1 | 命名应在本稿冻结 | §6 四表命名冻结（DDL 首稿即定名） |

实证（2026-09-09，代码核验）：基线 `764aa35` 零残留；两条 handler 均 runner < pipeline.process
（anthropic `~:971` < `~:1189`；openai 对称）；`systemAppend` 合并点 `anthropicHandler.ts:935-942`；
`countHumanTurns`（`turnSeq.ts`）= extractor `turnSeqOf`（`decision-unit-extractor.ts:779-786`）=
注入管线 `meta.turnSeq`（`anthropicHandler.ts:1192`）**同源同语义**，compaction 后随窗口一起重算
（guard-adapter 的单调 turnSeq 仅供 langfuse/cost-guard，不落 attribution）→ 档①/档②/extractor 三路对齐成立。

## 1. 一句话

把"该轮模型实际见过的正文"沿**两条现成接缝**归档为可拼接可见窗口：档① = 注入管线 observer 落全部渲染
block 全文 + session-context 合成块；档② = 决策 runner 调用点落消息流增量（fetched tool_result 在历史内）。
S5 引用验证锚定拼接窗口；v3/校准语料即此归档。

## 1b. 范围（in / out）

**in**：
- 档① block 全文 + 会话内 `content_hash` 去重 + 轮次链接；**session-context 合成块捕获**（B1 关漏）；
- 档② 消息增量（cap + chars 诚实截断 + **epoch/compaction 语义**，B4）；
- 拼接 read API `visibleText.window()`（分侧诚实返回 + read 期去重选项，B5）；
- 四表 schema + repo + 清理 SQL 骨架；toggle 缺省 off；tsc 零新增错误；验收③ injectedBody golden 硬比对。
**out**：S5 判定本身；spans/metadata.assets 契约改动（红线 3 只消费）；retention 数字运营定档；v3 语料导出；
hook_cache 底座（DR-2：不依赖）；guard-adapter 单调 turnSeq 的接入（口径已声明不采用，见 §0 实证）。

## 2. 架构

```
请求进入 handler（openai handler.ts / anthropic anthropicHandler.ts）
  │  session-init：anthropic 生成 systemAppend（session-context）→ 合并点 anthropicHandler.ts:935-942
  │      └ 档①合成块捕获（hook_id="session-context", point="system.prepend"）── B1 关漏
  ├─ S3 seam（注入前；anthropic ~:971 / openai ~:1073）
  │     档②：消息增量归档（epoch/compaction 判定同 runner.ts:126-127；turn_seq 用 §4.2 推导）
  │
  └─ pipeline.process（注入，anthropic ~:1189 / openai ~:1270）→ 各 hook.done
       档①：VisibleBlockArchiveObserver → attribution_block_seen + attribution_block_text（去重）
```

顺序事实已实证：档②在注入前、档①在注入中 → 档②天然不含本轮回合注入块。正文最终落在 `body.system`
（anthropic）或 role=system 提升（openai 经 AnthropicAdapter）→ system 层先行、消息层随后。

## 3. 档① — 注入块 + session-context 全文归档

接缝 A（注入块）：`injection/observer.ts` `onHookDone` 全量 `ContextBlock[]`。新 child
`VisibleBlockArchiveObserver extends NoopInjectionObserver`，装配点 `injection/index.ts` observer 列表，
config 门控（§6c）。

接缝 B（session-context，B1 修复）：anthropic 协议下 session_context 由 session-init 预构建、经
`appendBlockToAnthropicSystem` 直拼 `body.system`（`anthropicHandler.ts:935-942`），**不经过任何 hook**。
为关漏，在该合并点调用同一个归档入口 `recordArchivedBlock(...)`，写入合成块：
`hook_id = "session-context"`、`point = "system.prepend"`、`source = "session.context"`、`content =
systemAppend`（与合入 body.system 的字符串**逐字节相同**）。openai 协议对称点：session_context 以注入
消息形态进入 messages（codebuddy init），同样以合成块捕获，统一两协议口径，避免"system 层在档②当消息
归档 / 在档①当块归档"的双记或漏记。

处理规则（两种接缝共用）：

1. 缺 `meta.sessionKey` → 放弃（沿用 20 spec §4.2）。合成块用 sessionKey 直接传入。
2. 逐 block（仅 `type:"text"` 且 content 非空）：`content_hash = sha256(utf8(content))`；
   `attribution_block_text` 按 `content_hash` **全局唯一** upsert（B5：source 不参与去重键，只标注），
   已存在则跳过；`attribution_block_seen` 写 occurrence：
   `(session_key, turn_seq, hook_id, point, content_id, block_idx)`。
3. **source 取值规则（B5 定）**：`block.metadata?.source` 为非空 string 时取之，否则回退 `hook.id`
   （合成块固定 `session.context`）。
4. 资产身份沿用 `collectAssets`（identity 摘要，无 spans）。
5. cap：单 block > `maxBlockChars`（32,768，采样 §7）→ 存前段 + `truncated:true` + `chars` 原长。
   已含 span/记录完整性依赖：`metadata.assets`、`metadata.source` 原样落 occurrence 摘要。

## 3a. 可见正文来源 → 接缝 对照表（B1 要求；验收③逐字节比对的归因底表）

| 来源 | 到达模型的载体 | 协议 | 接缝 / 处理 | 档 |
|---|---|---|---|---|
| 客户端自带 system / 用户原语 | body.system 既有项 / 非注入用户文本 | 两 | **excluded 清单**（客户端正文非本代理注入面） | — |
| session-context（agent+task） | anthropic `body.system` 追加项 / openai 注入消息 | 两 | **合成块捕获**（§3 接缝 B） | ① |
| 注入渲染块（skill/knowledge/tdai-*/asset-reflection） | system 段/工具区，pipeline 渲染 | 两 | `onHookDone` blocks 全文 | ① |
| 消息流 user/assistant/tool（含 fetched tool_result、记忆工具 curl 返回） | messages | 两 | 档② 消息增量（§4） | ② |
| 过去轮 history（客户端完整历史重发） | messages 前段 | 两 | 档② 水位增量只取新段；重发段已归档（同 epoch 幂等） | ② |
| compact/aux 请求 | — | 两 | main 守卫跳过（无注入不归档） | — |

规则：**每个到达模型的正文字节必须能归因到（档① ∪ 档② ∪ excluded 清单）**——验收③对最终
`injectedBody` 做字节级硬比对，任何不可归因增量即失败（见 §8.3）。若未来出现新的直拼 body 路径而未
登记本表 → golden 比对暴露，强制补表或补捕获，防静默漏档。

唯一的不可归因例外 = **system/消息拼接胶水**（string 形态 `\n\n` 分隔等接缝伪影）——归因还原与
`injectedBody` 两侧**同规则剥离**后比对（约定见 §8.3），胶水不属任何归档来源、不得掩盖真实增量。

## 4. 档② — 消息增量归档（含 epoch / compaction）

接缝：decision-unit-runner 调用点（注入前）。新函数 `archiveMessageIncrement(...)` 与
`runDecisionUnitExtraction` 同区调用、同守卫（main / 有会话 / sessionKey 非空）；可见档案开关独立
门控，但**依赖 extractor 所在调用区被激活**（同 §1b 组合行为：decisionUnitExtractor 关 → 档②不写、
档①照常）。

### 4.1 水位与 compaction（B4 修复）

DB 水位**镜像 runner 内存水位语义**（`decision-unit-runner.ts:124-127,174`：存"已见消息条数"，
`messageCount < 水位` ⇒ compaction 归零全量重放）：

- `attribution_archive_watermark(session_key, epoch, last_seen_count)`，单行每会话。
  **水位口径 = 已处理 main 请求的消息条数 `messageCount`**（与 runner 内存水位同语义，
  §0 实证 `runner.ts:124-127`）；**仅 system 增量请求同样推进水位** —— system 行不入档但已见条数照计
  （§7 test 5/11 直证），否则水位会落后于消息流位置。
- 每次 main 请求：若 `messageCount < last_seen_count` ⇒ **compaction：`epoch += 1` 且
  `last_seen_count = 0`**（与 runner 内存判定同一规则、同请求触发）；否则正常续推。
- 新增归档段 = `messages[last_seen_count .. messageCount-1]`（lookback 不需要：上一轮末消息上轮已归档，
  minIndex-1 只对 extractor 的密封推导有意义，不属归档面）。unique `(session_key, epoch, message_index)`
  冲突静默跳（崩溃重放兜底，同 runner dedupe 纪律）。
- **compaction 后重发段以新 epoch 落行**（旧 epoch 行保留）：内容改写（压缩摘要占据旧索引）不会因
  `(session_key, message_index)` 撞唯一键被静默吞掉；归档是"收到的正文序列"，epoch 分层的原始与改写
  版本并存，拼接层按需取。

### 4.2 轮次推导（B3 修复，与 extractor 共用）

档② 不引入第二套 turn 语义：每条归档消息的 `turn_seq` = **与 decision-unit-extractor
`turnSeqOf(anchor)` 完全同源的前缀计数**（`countHumanTurns(messages.slice(0, m+1), protocol)`，
`turnSeq.ts`）。工具/助手消息落在其前置人类轮；compaction 后随新窗口从 0 重算，与档①/事件行同步重置
（§0 实证：三路同源）。逐消息推导在档② 模块内对 `[last_seen_count..]` 段做，纯函数可单测。

### 4.3 内容与 cap

每条消息：`role`（user/assistant/tool；**role=system 行不进档②**，system 层由档① + excluded 兜底，
见 §3a）、`content_json`（文本 / tool_calls / tool_result 原文）、`content_hash`、`chars`、`truncated`。
单条 > `maxMessageChars`（65,536，≈4× 采样最坏 21.3k）→ 截断 + `chars` 原长 + `truncated:true`。
assistant 消息仅含 tool_calls（content 为空/null）时 fingerprint 为空 → **不入档②**（该载荷由
decision-unit / attribution 行承载，不属正文快照面）；**快照面只保证 text / tool_result 可见正文**，
引用验证不得期望快照面覆盖 tool_call 参数载荷。

## 5. 拼接 read API（分侧诚实 + S5 交接，B4/B5）

`db/visibleTextRepo.ts`（get/set 单例 + 可注入 repo）：

- `window(sessionKey, { epoch?, turnFrom?, turnTo? })` → `{ epochs: Map<number,{ blocks, messages }>, ... }`；
  **分侧诚实语义（B4）**：默认以 `epoch = watermark 当前值` 返回"该会话当前 epoch 的归档"；
  跨 epoch 视图= `archive(sessionKey)` 给出归档**超集**（compaction 后含原始 + 压缩改写两个版本）。
  所谓"该轮模型实际可见的正文"只在**同 (epoch, turn_seq) 档位**成立；决策单元锚定某轮时，S5 按
  该单元的 epoch+turn 取窗（单元行与档位的时间一致），**不做"当前整条会话 = 模型当前可见"的承诺**。
  档① 无 epoch / 请求维度，窗口内的档① 集合是**"轮内出现集（非请求级）"**：工具循环中同一
  (turn_seq, hook_id, block_idx) 的多请求重复 occurrence 在窗口内并排、无请求级消歧；静态注入因
  `content_hash` 全局去重不重复计文本，动态注入源现为 0（§10），故 P0 感知不到该差异。若 S5 需要按
  请求重建"该请求的注入集合"，档① seen 的请求级区分留后续增强（低成本捕获时刻水位）。
- 排序：API 返回 `(epoch, turn_seq, tier, seq)` 升序，`tier` 缺省 blocks 先于 messages（system 层前置，
  与 anthropic body / openai 提升一致）；**DB 不做跨档排序承诺**（B5：order 列不存在于 schema，排序是
  API 语义）。
- read 期跨档去重（B5：schema 无法跨表 UNIQUE）：提供 `dedupeByContentHash` 选项（缺省关），开时按
  `content_hash` 折叠整条同内容（档①合成块与某消息逐字节相同等罕见情形）；引用验证按需开启。
- S5 交接注释：引用验证的归一化/剥离/查引工具在共享基座，本模块只出窗口；excluded 清单（§3a）随窗口
  返回，便于判定上下文完整归因。
  > ✅ **已兑现（2026-09-10）**：归一化/剥离/查引工具已交付 —— `attribution-base-design.md` §4.8（基座-c），
  > 落地 `src/attribution/citation/`（`normalize.ts` / `wrapper-registry.ts` / `ngram.ts` / `corpus-repo.ts` /
  > `source.ts`）+ `visible-text.ts`（可见正文/胶水口径已从测试 helper **上移**到生产模块，helper 仅 re-export，T26）。
  > ⚠️ **excluded 清单仍为缺口**：实现面 `windowVisibleText()` 未带 excluded 字段，基座以
  > `CitationSourceProvider.excludedCategories()` **留位**（当前返回 `[]`）⇒ 缺口与两种处置见 `attribution-base-design.md`
  > **§8.3**（本期不做选择，留 50 spec 定形状）。

## 6. schema（v2 — B5/C1 修订，命名冻结）

```sql
-- 档① 内容行：content_hash 全局唯一去重（B5：source 不再进唯一键，只作身份标注）
CREATE TABLE IF NOT EXISTS attribution_block_text (
  content_id   INTEGER PRIMARY KEY,
  source       TEXT NOT NULL,          -- §3 规则 3：block.metadata.source ?? hook.id（合成块 session.context）
  content_hash TEXT NOT NULL UNIQUE,   -- sha256(utf8(content))，跨会话/跨轮去重键
  content_utf8 TEXT NOT NULL,
  chars        INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  truncated    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 档① 轮次链接（含 session-context 合成块：hook_id='session-context'）
CREATE TABLE IF NOT EXISTS attribution_block_seen (
  seen_id     INTEGER PRIMARY KEY,
  session_key TEXT NOT NULL,
  turn_seq    INTEGER NOT NULL,        -- §0：countHumanTurns 窗口计数口径，compaction 后重算
  hook_id     TEXT NOT NULL,
  point       TEXT NOT NULL,
  content_id  INTEGER NOT NULL REFERENCES attribution_block_text(content_id),
  block_idx   INTEGER NOT NULL,
  asset_ids   TEXT,                    -- JSON：collectAssets identity 摘要（无 spans）
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ablk_seen ON attribution_block_seen(session_key, turn_seq);

-- 档② 消息快照：epoch 分层（B4），唯一键含 epoch（compaction 改写不吞行）
CREATE TABLE IF NOT EXISTS attribution_message_snap (
  msg_id        INTEGER PRIMARY KEY,
  session_key   TEXT NOT NULL,
  epoch         INTEGER NOT NULL DEFAULT 0,   -- compaction 时 +1（镜像 runner.ts:126-127 判定）
  turn_seq      INTEGER NOT NULL,             -- §4.2：与 extractor 同源前缀计数
  message_index INTEGER NOT NULL,
  role          TEXT NOT NULL,                -- user/assistant/tool（system 行不入档，见 §3a/§4.3）
  content_hash  TEXT NOT NULL,                -- read 期跨档去重选项用（§5）
  content_json  TEXT NOT NULL,
  chars         INTEGER NOT NULL,
  truncated     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_key, epoch, message_index)
);

-- 档② 水位：镜像 runner 内存"已见消息条数"语义（B4）
CREATE TABLE IF NOT EXISTS attribution_archive_watermark (
  session_key     TEXT PRIMARY KEY,
  epoch           INTEGER NOT NULL DEFAULT 0,
  last_seen_count INTEGER NOT NULL DEFAULT 0   -- 非"最后归档索引"：runner.ts watermark 即 messageCount
);

-- 清理 SQL 骨架（10 spec §10 姿势；数字由运营定档，P0 只立语句）
DELETE FROM attribution_message_snap WHERE created_at < datetime('now', '-90 days');
DELETE FROM attribution_block_seen   WHERE created_at < datetime('now', '-180 days');
DELETE FROM attribution_block_text   WHERE content_id NOT IN (SELECT content_id FROM attribution_block_seen);
DELETE FROM attribution_archive_watermark WHERE last_seen_count = 0 AND epoch = 0; -- 仅清从未写入的哨兵
```

命名冻结说明（C1）：以上四表名 + repo 模块名 `visibleTextRepo.ts` + read API `window()` 在本稿定稿，
本稿即正式 40 spec，直接作为实现依据；与 S5 判定表（`attribution_status_events` 等，50 spec 前定稿）正交。

### 6c. config / toggles

`injection.visibleArchive.enabled`（缺省 false），配套 `maxBlockChars`（32,768）/ `maxMessageChars`
（65,536）。装配点与 `attributionEvents` 并列 push；缺省关闭时模块不 import、零新表访问（参照 noop 轮）。

## 7. 单测清单（vitest，纯函数 + fake repo，沿用 20 spec §6 姿势）

1. **collectAssets 兼容**：档① occurrence 的 asset_ids 摘要与现 `collectAssets` 输出一致（golden）。
2. **content 去重**：同 hash 跨轮 → text 行 1 条、seen 每轮 1 条；source 不同但 hash 相同也共享行。
3. **cap/截断**：block/message 超 cap → `truncated=1`、`chars` 原长、content 前段。
4. **缺 sessionKey / observer 抛错隔离**：不落行；child 失败不阻断其它 child。
5. **水位与 epoch（B4）**：同批重放 0 新增；`messageCount < last_seen_count` → `epoch+1` 归零重放、
   旧 epoch 行保留、压缩改写内容落新 epoch 行不吞；turn_seq 重算 0 起。
6. **轮次推导（B3）**：合成多人类轮 + 工具循环 → 每条消息 turn_seq 与 extractor `turnSeqOf` 逐条一致。
7. **互斥断言收窄（B2）**：真实管线同轮下，档② **非 tool 新消息**（role∈{user,assistant}）不得**整块**
   包含档①任一 block.content；违规输出分类 `{blockHook, source, msgIndex, role, kind: whole|segment}`；
   role=tool / system 行合法例外不参与（skill_view 返回含注入段全文属合法，记录不红）。
8. **拼接单测**：`window()` 并集行数/内容正确、默认排序稳定、`dedupeByContentHash` 开/关行为、跨 epoch
   视图为超集而单 epoch 视图不跨代。
9. **turn_seq 对齐**：档①/档②/现有 attribution_events 同 (session_key, turn_seq) 口径（compaction 前后
   各一次）。
10. **session-context 捕获（B1）**：anthropic 首轮/恢复轮 `systemAppend` 落档① 合成块（source=
    `session.context`，hook=`session-context`），内容与 body.system 合并段逐字节一致。
11. 默认关闭回归：无 config → 不 import、零新表访问、attribution_events 照常。

## 8. 验收

1. 静态注入块：真实会话首轮落 text + seen；次轮 0 新 text、1 新 seen（对照采样：首轮 ≈25.2kB、后续仅链接）。
2. fetched 召回样本：一条**经记忆工具的召回 / 长 tool_result**（cap 内，采样 long-probe 21.3k 同量级）
   在 message_snap 原样还原 → 引用验证可在拼接窗口锚定。
3. **转发前 injectedBody golden 字节硬比对（B1 升级）**：冒烟捕获 pipeline 后、forward 前的最终
   `injectedBody` 全文，按 §3a 归因表做字节级比对：`splice ∪ excluded` 还原体与 injectedBody 逐字节
   一致；任何多出/缺失字节即 fail 并输出缺失源归属 → 强制 source→seam 表完整、防静默漏档。
   **胶水剥离约定（§3a 例外落地）**：string 形态 system/上下文拼接的 `\n\n`（及等价连接伪影）为接缝
   伪影，还原侧与 `injectedBody` 两侧**同规则剥离**后比对——anthropic `systemAppend` 直拼整段无胶水，
   胶水出现形态主要在两协议 system 提升/数组拼接。S4/S5 真实冒烟断言嵌入字节时，补 system 为
   string / array 两形态 fixture 过真 builder（openai seam-B 重建块逐字节一致由此实证）。
4. **compaction 会话（B4）**：合成 compaction 会话（截断重发 + 压缩改写）验证 epoch 递增、旧行保留、
   单 epoch 视图不混代、跨 epoch 视图为归档超集并如实交付 S5。
5. toggle 缺省 off + 组合矩阵（× attributionEvents / × langfuse）零行为回归；tsc 零新增错误（55 错基线
   不变）；清理 SQL 随切片给出。

## 9. 锚点文件（实现前精读；行号以当时工作树为准）

| 用途 | 文件 / 符号 |
|---|---|
| 档① 接缝 A | `injection/observer.ts`（`onHookDone` 全量 blocks）；`injection/index.ts` observer 装配段 |
| 档① 接缝 B（合成块） | `anthropicHandler.ts:935-942`（systemAppend → body.system）；codebuddy init 注入点（openai 对称） |
| 资产摘要复用 | `injection/attribution-event-observer.ts` `collectAssets` |
| 档② 接缝 + 水位语义 | `decision-unit-runner.ts`（`~:117-176`：watermark Map、`compacted` 判定 `~:126-127`、minIndex）；`anthropicHandler.ts` runner 调用 `~:971` / pipeline `~:1189`；`handler.ts` `~:1073` / `~:1270` |
| 轮次推导（B3 共用） | `turnSeq.ts` `countHumanTurns`；`decision-unit-extractor.ts:779-786` `turnSeqOf`；`anthropicHandler.ts:1192` `meta.turnSeq`（三路同源实证） |
| repo 模式 | `db/attributionEventRepo.ts`（get/set 单例 + 可注入） |
| 清理 SQL 姿势 | `docs/implementation/10-event-table.md` §10 |
| config 门控姿势 | `injection/index.ts` attributionEvents push 段；`config.ts` 默认结构 |

## 10. 风险与诚实说明

- 档② 依赖 decision-unit-runner 激活区（组合行为见 §1b/§4）；解耦需自建消息水位，P0 不做。
- session-context 合成块是**新增命名捕获点**（非管线改写接缝），两协议 handler 各一处；若未来新增
  直拼 body 路径，验收③ golden 比对会先于数据漂移暴露。
- 档①内容与"模型最终序列化正文"之间的差异（如 anthropic system 数组与 openai 提升次序）由验收③
  逐字节校准；S5 归一化工具在共享基座处理渲染包装。
  > ✅ **已兑现（2026-09-10）**：渲染包装剥离已交付 —— `attribution-base-design.md` §4.8.3（基座-c c-2），
  > 模板表 `wrapper-registry.ts` + `stripRenderWrappers()`，对 **render-golden 四 case 真实渲染串**做
  > 删字节审计（每段被删字节必须由表内模板**整段认领**，无可认领 = 不算剥离）+ 幂等 + R8 反例（T18–T20、T27）。
  > 剥离产物**只用于比较，绝不回写**归档原字节（T17）。
- compaction 后跨 epoch 是归档超集，"该轮可见"只对同 (epoch, turn) 成立——S5 必须按决策单元锚点的
  epoch+turn 取窗（§5 已交接），否则会把压缩改写与原始版本混淆。
- 动态注入源现架构为 0（L1 recall 注入器已下线，`injection/index.ts:396-400`）；档① 按任意 hook 通用
  实现，注入式 recall 若回归自动覆盖；三分法② 验收样本落在 fetched 通道。
- 正文归档 = 敏感数据面扩大：toggle 缺省 off + 清理 SQL + chars 诚实标注是硬约束，超 cap 宁截断不静默丢。
