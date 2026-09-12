# 共享基座（v2 前置骨架）设计与交接任务书

> **定位**：把 V2 立项 §1「共享基座」落成**可验收的三跳骨架** —— 入队 → worker 消费 → 幂等落库。
> **依据**：`codebuddy-scratch/v2-init/attribution-v2-boundary-scope.md`（下称"立项"）§1 共享基座 / DR-4（worker 拓扑）/ DR-5（mock judge）/ §4 新增红线 8（judge 幂等）。
> **前序**：P0（`40-visible-text-archive.md`）已闭 —— spec + 实现 + S4 真实 HTTP 冒烟验收（`bf8af3d`/`d0f44a6`/`22fad92`）。
> **后继**：S4 bridge sink（`45-`）/ S5 判定主链（`50-`）。
> **边界**：本文件是**设计侧任务书**，不改任何生产语义（缺省 off = 零行为回归）；实作交编码侧。
> **状态**：设计侧核到源码（2026-09-10）；锚点若与现状不符，按惯例在文末追加「勘正」，勿静默改。

---

## 0. TL;DR

| 问题 | 结论（一句话） |
|---|---|
| 做什么 | **基座-a**（队列表 + 独立轮询 worker 进程 + mock judge + 幂等落库）**＋基座-b**（prompt 版本管理 + 引用式日志）**＋基座-c**（引用验证纯工具层：归一化 / 渲染包装剥离 / n-gram 稀有度 / 排他性检查输入源 —— 2026-09-10 裁决**并入本期**，见 §8.1） |
| 验收物（立项硬要求） | **三跳闭环在真进程上连通**：真 proxy HTTP 入队 ≥1 → 真 worker `--once` 消费 → `attribution_judgement_details` **恰好 1 行** → 再跑一次**不增行** |
| 为什么不塞 in-process 定时器 | proxy 是**请求转发进程**（`index.ts:149-165` 优雅退出服务于请求）；判定是长跑消费，混进去 ⇒ 用户请求延迟/失败耦合判定。且 S5/S6 共用 ⇒ **独立进程**（DR-4） |
| 队列拓扑 | 同库表 `attribution_judge_queue` + `npm run worker:attribution`（轮询 + 租约 + 死信）；**单实例先够**，多进程靠 WAL + busy_timeout + CAS-UPDATE |
| **幂等锚（红线 8）** | 确定性 `judgement_id = "jd_" + sha1(unit_id\|asset_id\|round).slice(0,12)` 作**主键** + `INSERT OR IGNORE` |
| ⚠️ 幂等陷阱 | **不得**只靠 `UNIQUE(unit_id, asset_id, round)` —— SQLite 里 NULL 互不相等，`asset_id` 可空时该唯一索引形同虚设（v1 用 partial index 规避同类问题，见 `schema.ts:71-96`） |
| 触发源 | 基座只做 **per-decision-unit** 入队（runner 落库后）；`trigger`/`round` 列留占位；「任务边界精确化」留 50 spec（立项原文） |
| 并发语义 | better-sqlite3 是**同步**调用 ⇒ 进程内"并发"无收益。基座用 **串行逐条 + 每轮批量认领 `batchSize`**，**不**照搬 pipeline-worker 的 `concurrency: 60`（`pipeline-worker.ts:180`） |
| 落地面 | 新增 `src/attribution/`（queue repo / judge / prompts / worker）；**不动** v1 表语义、**不动** `SCHEMA_VERSION = 1`（`schema.ts:16`） |
| 基座-c 形态 | **纯函数 + 可注入 provider**（`src/attribution/citation/*`）：进字符串、出**度量**；**不出阈值、不做判定**（阈值/裁决留 50 spec） |
| 基座-c 语料 | 只读 P0 归档（档① `content_utf8` ∪ 档② `content_json` 文本投影），采样上限 + 稳定排序 ⇒ 稀有度表**可复现**（记 `table_sha256`） |
| ⚠️ 基座-c 纪律 | 归一化/剥离是**有损比较层**，必须返回所用级别（`match_level`）并落进判定明细；**不得升格为主判据**（`stripGlue` 的"只用于诊断"边界见 F31） |
| 待你拍板 | **0 处**（基座-c 并入 = 2026-09-10 裁决；代价与理由留档见 §8.1；新登记的 P0 交接缺口见 §8.3） |

---

## 1. 范围

### 1.1 本期做（in）

| # | 交付 | 验收物 |
|---|---|---|
| a-1 | 队列表 `attribution_judge_queue`（additive DDL）+ repo（入队/认领/完成/失败 + counters） | 单测 + 三跳冒烟 |
| a-2 | 独立 worker 进程 `src/attribution/worker.ts` + `npm run worker:attribution`（`--config` / `--once` / `--retry-failed`） | `--once` 真跑 |
| a-3 | 落点表 `attribution_judgement_details` + **幂等落库**（红线 8） | 二次消费不增行 |
| a-4 | `Judge` 接口 + `DeterministicMockJudge`（可注入、无网络、无随机/时钟） | 同输入两次逐字节相同 |
| b-1 | prompt 版本管理：`JUDGE_PROMPT_V1` + `buildJudgePromptRef()`（`prompt_sha256`） | sha256 稳定 + 变 prompt 即变 |
| b-2 | 引用式日志（复用 `FileLogger`，字段对齐 `MemoryGenerationLog` 最小子集） | 每次消费 1 行 |
| b-3 | golden 门禁（固定 corpus → verdict 序列 + prompt bytes） | prompt 改动必须刷新快照才绿 |
| c-1 | 归一化（`normalizeForMatch`：空白折叠 + **显式标点映射表**，非 NFKC）+ 三级 `match_level` | 纯函数单测 + `match_level` 落库断言 |
| c-2 | 渲染包装剥离（**模板表**驱动 + 删除字节**审计** `removed[]` + 幂等；胶水口径复用 P0 唯一实现） | 真实 golden 串的删字节审计 |
| c-3 | 区分性 n-gram + 稀有度查表（`buildRarityTable` / `rarity` / `distinctiveGrams` / `gramCoverage`） | 确定性 + `table_sha256` golden |
| c-4 | 排他性检查**输入源**（`CitationSourceProvider`：会话窗口 + 按资产分组的同会话可见文本 + 稀有度表；**只供输入不做判定**） | fake provider 单测 + 只读断言 |
| — | 触发源：runner 落库后入队（独立 toggle，fire-and-forget，绝不 throw） | 单测 + 冒烟 |
| — | config/toggles（缺省 off）+ DB 清理 SQL + 开启 checklist | 见 `attribution-base-checklist.md` |

### 1.2 本期不做（out）—— 明确写下来，避免"顺手做"

- **真模型 provider**（HTTP judge）→ 50 spec。基座只留接口 + mock；DR-5 的"真实小模型冒烟 = 可选加分"不在此期。
- **判定语义**（三道机械锚点 / 候选分档 / shortlist 成本截断）→ 50 spec。基座对"判什么"保持**零主张**。
- **基座-c 的阈值与裁决**：n-gram 稀有度**阈值**、`gramCoverage` 合格线、"是否算不排他"、引用命中的最终裁决 —— 全部 50 spec。基座-c 只交**度量 + 所用级别**（`match_level` / `coverage` / `idf` 数值），不交布尔判定。
- **另两张表** `attribution_status_events` / `attribution_audit` → 50 spec 前定稿（DR-3）。基座只冻结**队列 + 判定明细**两张（三跳最小面）。
- **任务边界精确化**（任务结束/用户批准等触发规则）→ 50 spec；基座只留 `trigger` 占位。
- **`round > 0` 的生产路径**（compaction 重判）→ 30 spec §9 开放问题 3；基座只保证 `round` 列与唯一键**支持**它。
- v1 表（`attribution_events` 等）**零改动**。

---

## 2. 源码事实（本设计的全部依据）

> 均为设计侧现场核到（2026-09-10），带 `file:line`。

| # | 事实 | 锚点 |
|---|---|---|
| F1 | DB 打开方式：懒初始化单例 `getDb()`，**失败返回 null** ⇒ 全仓以"null = 降级不写"为纪律 | `src/db/index.ts:71`、`:10` 注释 |
| F2 | PRAGMA 已就绪：`journal_mode=WAL` / `foreign_keys=ON` / **`busy_timeout=2000`** | `src/db/index.ts:85-87` |
| F3 | 纯 additive DDL 口径：`SCHEMA_VERSION` **保持 1**，`IF NOT EXISTS` 幂等，**无 migration runner** | `src/db/schema.ts:16`、`:68-70` |
| F4 | `attribution_events` DDL 段落（含 partial unique index `idx_ae_unit_dedupe`） | `src/db/schema.ts:71-96` |
| F5 | P0 四表 + 水位表段落（档①/档②/seen/snap/watermark） | `src/db/schema.ts:100-145` |
| F6 | 事务内逐行跳过冲突的 repo 姿势（单事务不因一行重复回滚）+ `skipped` info 日志 + `failed` warn | `src/db/attributionEventRepo.ts:186-221`（tx `:189`、skipped `:211`、failed `:217`） |
| F7 | repo 三件套：`get…Repo()` / `set…Repo()` / `__reset…ForTests()` + Null 实现 | `src/db/attributionEventRepo.ts:252,263,271,276` |
| F8 | 幂等写法先例：`INSERT OR IGNORE` + 冲突=**预期路径**（info 非 warn） | `src/db/visibleTextRepo.ts:189,200,242,291` |
| F9 | 可注入单例（测试可换 fake） | `src/db/visibleTextRepo.ts:411,419,424` |
| F10 | 写路径计数先例（观测入口） | `getAttributionWriteCounters()`（10 spec §5.2/§10 引用） |
| F11 | 进程优雅退出范式：`shutdownGuard` + 逐个 flush/shutdown | `src/index.ts:149-165` |
| F12 | 触发点：两条 handler 在转发前调 runner（守卫在拦截判定后） | `src/anthropicHandler.ts:995-1012`、`src/handler.ts:1114-1132` |
| F13 | runner 落库 = 一次事务 `appendMany`（文件头注释第 5 步），落库前有 pure 推导 | `src/decision-units/decision-unit-runner.ts:9-11` |
| F14 | runner 水位是**进程内 Map**（`watermarks`，上限 2048 淘汰最早），compaction 归零 | `src/decision-units/decision-unit-runner.ts:42,48-51,125-130` |
| F15 | config 默认值集中 `DEFAULT_CONFIG`（toggle 缺省 false） | `src/config.ts:89-93` |
| F16 | yaml → config 逐字段解析（`typeof … === "boolean"` 守卫）；`buildConfig()` 为唯一构造口 | `src/config.ts:277,410-426` |
| F17 | 本地小模型调用先例（跨仓）：`callLlm` 用 `AbortSignal.timeout` | `MemoryCore/src/offload/local-llm/llm-caller.ts:43,51,70` |
| F18 | 轮询 worker 参考实现（跨仓）：`pollIntervalMs`/`lockTtlMs`/`maxRetries`/`pendingRecoveryIntervalMs` + `deadLetterQueue` | `MemoryCore/src/services/pipeline-worker.ts:132,156,180-186`（默认值）、`:122-123`（退避窗口注释） |
| F19 | 自查重排 + `unref()` 姿势（不阻塞进程退出） | `MemoryCore/src/offload/index.ts:946-953,1284-1300` |
| F20 | prompt 版本/引用日志形状：`MemoryGenerationPromptRef{ memory_prompt_id, version, source, prompt_sha256 }`；sha256 计算在解析处 | `MemoryCore/src/core/memory-generation-log/types.ts:12-16,31`、`store.ts:60`（另有兜底 `:54`） |
| F21 | golden 装置先在（脚本 + 测试 + 快照） | `MemoryProxy/scripts/qa/record-render-golden.ts` + tsc 基线机检 `scripts/qa/tsc-baseline-check.mjs` |
| F22 | 真 HTTP 测试装置先在（stub + 端口纪律） | `src/injection/__tests__/_helpers/s4-stubs.ts`、s4 checklist §1-§2 |
| F23 | ⚠️ **命名冲突**：`src/judge-client.ts` 是既有 **CostGuard 的 judge**（`JudgeServiceConfig`/`judgeAgentTurn`，`AbortController` 超时 `:114-115`），**与本基座的归因 judge 无关** ⇒ 新代码一律 `attribution-` 前缀 | `src/judge-client.ts:10,88,106-115,142-152` |
| F24 | **渲染包装实测形态**（四类 case 全文 golden）：块标签 `<knowledge_tools>` / `<tdai_profile_memory>` / `<l3_core_memory>` / `<l2_scene_index>` / `<memory-tools-guide>` / `<tdai_recalled_l1_memories>`；嵌套 `<agent name=… role=… agent_id=…>`；**自闭合资产标记** `<knowledge type="wiki" id="wiki-1" url=… name=… about=… />`；列表前缀 `1. [episodic] [self score=0.900] `；skill listing 段首 `## Skills (mandatory)` + `skill-x — 说明` | `src/injection/injectors/__tests__/render-golden.snap.json:2-5`；case 表 `render-golden-cases.ts:20-26` |
| F25 | **P0 归档读面 API（已实现）**：`windowVisibleText(repo, sessionKey, opts)` → `VisibleWindow{ epoch, pieces }`；中段 `listBlockSeen`/`listMessageSnaps`/`listEpochs`/`getWatermark`；排序 `(turn_seq, tier, seq)`；另有 `archiveVisibleText` / `dedupePiecesByContentHash` | `src/db/visibleTextRepo.ts:118-139,437-454,488-548,550-556` |
| F26 | 档① occurrence 带 **`asset_ids`**（JSON，`collectAssets` identity 摘要）⇒ 可按资产分组同会话可见文本（= 排他性检查的物料） | `src/db/schema.ts:183-193`（`asset_ids` 在 `:191`） |
| F27 | 档② `content_json` 是**消息原文的 JSON 字符串**（非纯文本）⇒ 需要文本投影；且 `tool_call` 参数载荷**不属**快照面（引用验证不得期望覆盖） | `src/db/visibleTextRepo.ts:100-103`；`40-visible-text-archive.md` §4.3 |
| F28 | **P0 已把接口许给基座**：「引用验证的归一化/剥离/查引工具在共享基座，本模块只出窗口」＋「S5 归一化工具在共享基座处理渲染包装」 | `40-visible-text-archive.md` §5（L164）、§10（L290） |
| F29 | 档① `content_hash = sha256(utf8(content))` **全局唯一**（跨会话/跨轮去重）⇒ 稀有度语料天然去重 | `40-visible-text-archive.md` §3 规则 2；`src/injection/visible-block-archive-observer.ts:97` |
| F30 | QA 已有 golden 联动装置（case 表 + snap + recorder），模板表可挂同一装置 | `scripts/qa/record-render-golden.ts`、`src/injection/injectors/__tests__/render-golden-cases.ts:20-26`、`render-golden.test.ts` |
| F31 | ⚠️ **"可见正文提取 / 胶水"的唯一实现现居测试目录**：`SEAM_GLUE`(`\n\n`) / `visibleTextOfPiece` / `restoredVisibleText` / `stripGlue` / `rebuildInjectedBodyFromArchive`；文件头自述「只能有一份实现……改动本文件等于同时改动两处断言口径」；`stripGlue` 自我标注为**有损投影**、"只用于辅助诊断，主断言一律用带位置的精确重建"；胶水源头 = `context-injector.ts` 的 `appendBlockToAnthropicSystem`/`appendBlockToOpenAISystem`（`${prev}\n\n${block}`） | `src/injection/__tests__/_helpers/attribution-window.ts:24-60,104-145`（注释 `:5-16,48-57`） |
| F32 | 消息侧**生产代码**已有文本面工具可复用（不新造第二份口径）：`messageTextFingerprint` / `truncateMessageContent` / `deriveSegmentTurnSeqs` / `classifySameTurnWholeContainment` | `src/decision-units/message-increment-archive.ts:34,52,89,141` |

---

## 3. 关键风险（先说清，再设计）

| # | 风险 | 现实表现 | 对策 |
|---|---|---|---|
| **R1** | **假绿**：worker 消费 0 行也"成功退出" | 断言只断"退出码 0"⇒ 空队列也绿 | 冒烟断言必须有**正向证据**：入队 `pending ≥ 1` + 落库 `== 1`（S4 的"空 injectors 假绿"是同类教训） |
| **R2** | **SQLite NULL 唯一键陷阱** | `UNIQUE(unit_id, asset_id, round)` 中 `asset_id` 为 NULL ⇒ 不去重 ⇒ 同单元重复落库 | 幂等锚 = **确定性主键** `judgement_id` + `INSERT OR IGNORE`；唯一约束**只作兜底**且列 `NOT NULL` |
| **R3** | **租约过期 ⇒ 重复判定** | lease 到期被重认领 ⇒ 同 unit 判两次 ⇒ 真 provider 会重复花钱 | 落库幂等兜底（红线 8）；`attempts` 计数 + 超 `maxAttempts` 进 `failed` **死信**，绝不静默丢 |
| **R4** | **SQLITE_BUSY 抖动** | worker 轮询 + proxy 落库同库；`busy_timeout=2000`（F2）在高频轮询下可能不够 | 单轮事务**短**；失败退避 `backoffMs`；轮询间隔 200ms 起（对齐 F18） |
| **R5** | **中途被杀留 `processing` 僵尸行** | SIGTERM 落在处理中 | 基座用**租约**兜底（不追求零残留）；接 `SIGINT/SIGTERM` 先停认领再收尾（照 F11 范式） |
| **R6** | **golden 门禁空洞** | 只有 mock ⇒ 真 provider 的 golden 没被覆盖 | 如实声明：基座 golden 只锁 **(a) prompt bytes (b) mock verdict 序列**；真 provider golden 随 50 spec。**不假装已覆盖** |
| **R7** | **队列无限增长** | `done` 行只增 | 清理 SQL 三档（见 checklist §3）+ 保留策略口径随 50 spec |

---

## 4. 设计

### 4.1 队列表 DDL（additive，`SCHEMA_VERSION` 仍 1）

追加进 `src/db/schema.ts`（照 F3/F5 段落口径写注释）：

```sql
-- 归因判定队列（共享基座）。纯 additive DDL：SCHEMA_VERSION 仍为 1。
-- 入队幂等键 = (unit_id, round)：同单元同轮只入队一次；跨轮（round+1）= 重判。
CREATE TABLE IF NOT EXISTS attribution_judge_queue (
  queue_id         INTEGER PRIMARY KEY,              -- 单调：兼作消费游标（见 §4.6）
  unit_id          TEXT    NOT NULL,
  round            INTEGER NOT NULL DEFAULT 0,       -- 0=首次；>0=重判（生产路径留 50 spec）
  session_key      TEXT    NOT NULL,
  space_id         TEXT    NOT NULL DEFAULT '_default',
  trigger          TEXT    NOT NULL DEFAULT 'decision_unit', -- 占位：task_boundary/manual（50 spec）
  payload_json     TEXT    NOT NULL,                 -- 自足最小摘要（沿用 v1「payload 自足」纪律）
  status           TEXT    NOT NULL DEFAULT 'pending', -- pending|processing|done|failed
  attempts         INTEGER NOT NULL DEFAULT 0,
  lease_owner      TEXT,
  lease_expires_ms INTEGER,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ajq_dedupe ON attribution_judge_queue(unit_id, round);
CREATE INDEX        IF NOT EXISTS idx_ajq_claim  ON attribution_judge_queue(status, lease_expires_ms, queue_id);
```

- `unit_id` 是 v1 的**内容哈希**（30 spec §4.6），天然跨重放稳定 ⇒ 是合适的入队幂等键。
- `payload_json` 自足：worker **只读队列行**，不回查 `attribution_events`（解耦 + 崩溃可重放）。

### 4.2 认领（CAS）与状态机

**状态**：`pending → processing → done | failed`；`processing` 租约过期 ⇒ 可被再认领回到 `processing`。

认领必须在**一个事务**里（照 F6 姿势），两步：

```sql
-- ① 选候选（pending，或 processing 且租约已过期）
SELECT queue_id FROM attribution_judge_queue
 WHERE status = 'pending' OR (status = 'processing' AND lease_expires_ms < :now)
 ORDER BY queue_id LIMIT :batchSize;

-- ② 逐条 CAS 抢占（changes()==1 才算抢到）；failed 只能由 --retry-failed 显式复位
UPDATE attribution_judge_queue
   SET status='processing', lease_owner=:owner, lease_expires_ms=:now+:leaseTtlMs,
       attempts=attempts+1, updated_at=:now
 WHERE queue_id=:id
   AND (status='pending' OR (status='processing' AND lease_expires_ms < :now));
```

- **`failed` 不再自动认领**（死信），避免无限重试；`--retry-failed` 是显式运维复位。
- 完成：`UPDATE … SET status='done', updated_at=:now WHERE queue_id=:id AND lease_owner=:owner`
  （带 `lease_owner` 条件 ⇒ 别人抢走后不会被我误标）。
- 失败：`status='failed'` + `last_error`；**未超** `maxAttempts` 时回到 `pending` 并退避（下一轮再抢）。
- **多进程安全**：WAL（F2）+ 事务 + CAS-UPDATE 三重足够；`busy_timeout` 抖动按 R4 退避。

### 4.3 落点表 + 幂等落库（红线 8）

```sql
-- 归因判定明细（共享基座冻结此表；status_events / audit 留 50 spec 前定稿）。
-- 幂等锚 = judgement_id 主键（确定性派生） ⇒ 崩溃重放/租约重复判定都不会双记。
CREATE TABLE IF NOT EXISTS attribution_judgement_details (
  judgement_id   TEXT    PRIMARY KEY,   -- "jd_" + sha1(unit_id|asset_id|round).slice(0,12)
  unit_id        TEXT    NOT NULL,
  session_key    TEXT    NOT NULL,
  space_id       TEXT    NOT NULL DEFAULT '_default',
  asset_id       TEXT,                  -- 可空（未归因）；**不参与**唯一约束（见 R2）
  asset_type     TEXT,
  round          INTEGER NOT NULL DEFAULT 0,
  verdict        TEXT    NOT NULL,      -- confirmed | refuted | unconfirmed
  evidence_source_type TEXT,            -- fetched | injected | NULL
  prompt_sha256  TEXT,
  judge_impl     TEXT    NOT NULL,      -- "mock:v1"（真 provider 随 50 spec）
  detail_json    TEXT    NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ajd_unit    ON attribution_judgement_details(unit_id);
CREATE INDEX IF NOT EXISTS idx_ajd_session ON attribution_judgement_details(session_key, created_at);
```

**幂等实现**（红线 8 的落点）：

```ts
// judgement_id 确定性派生 ⇒ 同 (unit_id, asset_id, round) 永远同一主键
const judgement_id = "jd_" + createHash("sha1")
  .update(`${unit_id}|${asset_id ?? ""}|${round}`).digest("hex").slice(0, 12);
db.prepare("INSERT OR IGNORE INTO attribution_judgement_details (…) VALUES (…)").run(…);
// changes()==0 ⇒ 已存在 = 幂等命中（info 级，非错误）—— 照 F8 姿势
```

- 与 v1 的 `du_` / `h_` / `content_hash` 同族（12 hex 截断），**确定性派生**而非随机 id。
- `(unit_id × 候选 × round)` 三元组因此在**落库层**完整覆盖红线 8；`round` 让"重判"与"重放"语义可区分。
- counters：`inserted` / `ignored` / `failed`（照 F10 姿势，供 checklist 健康门槛用）。

### 4.4 Judge 接口 + deterministic mock

```ts
// src/attribution/judge/types.ts
export interface JudgeCandidate { assetId: string; assetType: string; evidenceSourceType: "fetched" | "injected" | null }
export interface JudgeInput {
  unitId: string; sessionKey: string; round: number;
  unit: { kind: string; payload: unknown };        // 队列 payload 解出
  candidates: JudgeCandidate[];                    // 基座可给空数组（候选分档属 50 spec）
  promptRef: PromptRef;
}
export interface JudgeVerdict { assetId: string | null; verdict: "confirmed" | "refuted" | "unconfirmed"; rationaleRef: string }
export interface Judge { readonly impl: string; readonly promptRef: PromptRef; judge(input: JudgeInput): Promise<JudgeVerdict> }
```

- `DeterministicMockJudge`：结论**只由输入决定**（禁 `Math.random` / `Date.now` / 网络 / 文件）。
  默认规则 = "候选 assetId 是否出现在 `unit.payload` 的文本里"；可用 `MockJudgeScript`（`byUnitId` 表）覆盖，供 golden 与边界用例。
- 工厂 `createJudge(config)`：`provider: "mock"` 为基座唯一实现；未知值 ⇒ **降级 mock + warn**（不抛，避免 worker 起不来）。
- `judge()` 返回 `Promise` —— mock 也 async，接口不为"现在是同步"而扭曲。

### 4.5 prompt 版本管理 + 引用式日志（基座-b）

- `src/attribution/prompts/judge-prompt.ts`：物理常量 `JUDGE_PROMPT_V1 = { memory_prompt_id: "attribution-judge-v1", version: 1, text: "…" }`
  （物理化而非文件读取 —— 与 v1 `skill-injector` 的 copy 同姿势，避免运行时 fs 依赖）。
- `buildJudgePromptRef()` → `{ memory_prompt_id, version, source: "attribution-judge", prompt_sha256 }`，
  `prompt_sha256 = sha256(text)`（照 F20 `store.ts:60`）。落进 `attribution_judgement_details.prompt_sha256`。
- **引用式日志**：复用 `src/report/file-logger.ts`（**不新写日志器**），`filename: "attribution-judge.log"`，
  每次消费一行，字段取 `MemoryGenerationLog` 最小子集：`log_id / generation_id / layer="attribution_judge" / status / prompt_ref / input_refs[{unit_id, queue_id}] / output_refs[{judgement_id}] / latency_ms`。
  日志失败**不得**影响判定与落库（FileLogger 自身 error-silent，见其文件头）。
- **golden 门禁**：`scripts/qa/record-judge-golden.ts` + `judge-golden.test.ts` + 快照（照 F21 R6 装置姿势），锁两样：
  (a) prompt `text` 的 `prompt_sha256`；(b) 固定 corpus（3–5 个 unit）上的 verdict 序列。
  ⇒ 改 prompt / 改 mock 规则**必须刷新快照**才绿（DR-6）。

### 4.6 触发源与"水位"占位

- **入队点**：`decision-unit-runner` 落库（F13 第 5 步 `appendMany`）**之后**，动态 `import` 入队模块，守卫 `config.attribution.judge.enqueue === true`；
  `try/catch` 吞掉一切异常（fire-and-forget）—— 与 v1 observer「绝不 throw」纪律同源。
- **不建水位表**：worker 按 `status`+`lease_expires_ms` 选行，`queue_id` 单调即消费游标；
  "水位线"在本基座**没有正确语义**（任务边界规则未定，50 spec 才定）—— 先立表 = 预设错误语义（P0 教训）。
  ⚠️ 50 spec 前复核一句：若任务边界需要"同单元多轮判定"，用 `round` 区分即可，仍无需水位表。
- `trigger` / `round` 两列是**占位**：本期只写 `'decision_unit'` 与 `0`。

### 4.7 config / toggles

```yaml
attribution:
  judge:
    enqueue: false          # proxy 侧：决策单元落库后是否入队（缺省 off ⇒ 零回归）
    provider: "mock"        # 基座唯一实现
    worker:                 # worker 进程侧
      pollIntervalMs: 200   # 对齐 F18 默认 200
      batchSize: 8          # 每轮认领条数（不是并发：better-sqlite3 同步，见 §0）
      leaseTtlMs: 600000    # 对齐 F18 lockTtlMs 默认
      maxAttempts: 3        # 对齐 F18 maxRetries 默认
      backoffMs: 1000
```

- 接入 `DEFAULT_CONFIG`（F15）+ yaml 逐字段守卫（F16，`typeof … === "boolean"` / `"number"`）。
- worker 启动：`npm run worker:attribution -- --config <yaml> [--once] [--retry-failed]`
  （`package.json` script 用 `node --import tsx/esm src/attribution/worker.ts`，与 proxy 启动方式一致）。
- **`--once` = 消费一轮后退出** —— 冒烟与测试的主力入口（也避开"长跑进程在 CI 里挂死"）。

---

### 4.8 基座-c：引用验证工具（2026-09-10 裁决并入）

> 立项 §1 第 2 条原文：**引用验证工具（空白/标点归一化、渲染包装剥离）、区分性 n-gram 表 + 稀有度查表、排他性检查输入源。**
> 40 spec 已把接口许给基座（**F28**）：§5 L164「引用验证的归一化/剥离/查引工具在共享基座，本模块只出窗口」、§10 L290「S5 归一化工具在共享基座处理渲染包装」。
> **一句话边界**：基座-c 只把"原始字节"变成"可比较的**度量**"；**"多少算命中"的阈值与裁决一律属 50 spec**（§1.2）。
> 落地形态：`src/attribution/citation/`（`normalize.ts` / `wrapper-registry.ts` / `ngram.ts` / `source.ts`）+ `visible-text.ts`（上移，见下），**纯函数 + 可注入 provider**，全部单测可跑，**不进三跳冒烟**。

#### 4.8.1 与 P0 的"唯一实现"纪律（最重要的一条）

P0 的"可见正文提取 / 还原 / 胶水"口径现存**唯一一份实现**，但它放在**测试目录**里（**F31**）：
`src/injection/__tests__/_helpers/attribution-window.ts` —— `SEAM_GLUE`(`\n\n`) / `visibleTextOfPiece` / `restoredVisibleText` / `stripGlue` / `rebuildInjectedBodyFromArchive`，
文件头自述「只能有一份实现……改动本文件等于同时改动两处断言口径」。

⇒ **基座-c 必须"上移复用"，不得新造第二份**：

1. 把 `visibleTextOfPiece` 与 `SEAM_GLUE` 的**口径**上移到生产模块 `src/attribution/citation/visible-text.ts`
   （胶水源头：`src/session/context-injector.ts` 的 `appendBlockToAnthropicSystem` / `appendBlockToOpenAISystem`，string 载体拼 `${prev}\n\n${block}`，F31）；
2. 原测试 helper 改为**re-export**（golden 装置 + S4 真链路冒烟的 import 面**零改动** ⇒ 断言口径零漂移）；
3. **复跑** `visible-archive-golden.test.ts` + `visible-archive-http-smoke.test.ts`，证明逐字节仍一致（T26）。

⚠️ **不得把 `stripGlue` 升格为主判据**：helper 自己标注它是**有损投影**（无法区分"接缝胶水"与"正文本来就有的空行"），"只用于辅助诊断……主断言一律用带位置的精确重建"（F31）。基座-c 用 `match_level` 机制**替代**"模糊剥离当判据"——判定必须能声明"我靠的是哪一级归一化"。

#### 4.8.2 c-1 归一化（三级 `match_level`；显式表，不用 NFKC）

```ts
export type MatchLevel = "exact" | "whitespace" | "punctuation";
export function normalizeForMatch(text: string, level: MatchLevel): string;
export function describeMatchLevel(level: MatchLevel): { level: MatchLevel; ops: readonly string[] }; // 审计用
```

- `exact`：**原字节原样**（默认级；P0 字节硬比对口径）。
- `whitespace`：`[ \t\r\n\u00a0\u3000]+` 折叠为单个空格 + trim（**只折叠、不删除**）。
- `punctuation`：在 `whitespace` 之上按**显式映射表**折叠全/半角（`，。；：！？（）【】「」""''` → `,.;:!?()[]""''`）。
- **为什么不用 `NFKC`**：NFKC 连带折叠连字、罗马数字、上标、半/全角字母数字等一大票字符，改动面**不可枚举** ⇒ 归一化本身成为漂移源。显式表**可枚举、可 golden 锁**，新增映射必须改表 + 刷快照。
- **纪律**：产物**只用于比较**，绝不入库、绝不回写（P0 归档存原字节）；`match_level` 记进判定明细 `detail_json`（**不改 DDL**），使"某条 confirmed 靠了哪一级归一化"可事后审计（T17）。

#### 4.8.3 c-2 渲染包装剥离（模板表 + 删除字节审计）

**实测形态**（F24，全部取自真实渲染产物 golden，非推测）：块级标签 `<knowledge_tools>` / `<tdai_profile_memory>` / `<memory-tools-guide>` / `<tdai_recalled_l1_memories>` / `<l3_core_memory>` / `<l2_scene_index>` / `<skill_tools>`；嵌套 `<agent name=… role=… agent_id=…>`；自闭合资产标记 `<knowledge type="wiki" id="…" url=… name=… about=… />`；列表前缀 `1. [episodic] [self score=0.900] `；skill listing 段首 `## Skills (mandatory)`。

```ts
export interface StripResult {
  text: string;
  /** 审计：删掉的每一段都必须有模板认领（无可认领 = 不算剥离，宁留不误删） */
  removed: Array<{ rawStart: number; rawEnd: number; templateId: string }>;
}
export function stripRenderWrappers(text: string, reg?: WrapperRegistry): StripResult;
```

- 模板表 `src/attribution/citation/wrapper-registry.ts`：每条 = `{ templateId, kind: "block-tag" | "marker-tag" | "list-prefix" | "seam-glue", matcher }`；
  **首稿只收录 F24 实测形态**，未知形态**不猜、不剥**（宁可留包装，也不误删正文）。
- 胶水类条目的实现**直接引用** `visible-text.ts` 的 `SEAM_GLUE`（单一来源），**不重写**字面量 `"\n\n"`。
- **可审计**：`removed[]` 必须能证明"删掉的每一段都等于某条模板的展开"——单测对**真实 golden 渲染串**逐条断言（T18）。
- **幂等**：`strip(strip(x)) === strip(x)`（T19）。
- ⚠️ **过度剥离风险（R8）**：`list-prefix` 类模板会误吃"资产正文自己就以 `1. ` 开头"的行。对策：前缀类模板**只在已进入某块标签的上下文内**生效，并配**反例 golden**（正文首行 `1. something` 必须原样保留，T20）。

#### 4.8.4 c-3 区分性 n-gram + 稀有度查表

```ts
export interface RarityTable {
  n: number;                          // 默认 4（CJK 友好；不引入分词）
  docCount: number;                   // 文档数（文档 = 一条归档行）
  df: ReadonlyMap<string, number>;    // gram → 文档频次
  tableSha256: string;                // 表可复现 ⇒ golden 可锁
  corpusRows: { blocks: number; messages: number; capped: boolean };
}
export function buildRarityTable(corpus: Iterable<string>, opts?: { n?: number; cap?: number }): RarityTable;
export function rarity(table: RarityTable, gram: string): { df: number; idf: number };
export function distinctiveGrams(text: string, table: RarityTable, opts?: { topK?: number }): Array<{ gram: string; idf: number }>;
export function gramCoverage(windowText: string, quote: string, table: RarityTable, opts?: { minIdf?: number }): { coverage: number; distinct: number; covered: number; n: number };
```

- **char n-gram**（默认 `n=4`）：仓内无分词器，中文按字更稳；`n` 参与 `tableSha256`（换 n 必换表）。
- `df` 是**文档频次**（文档 = 一条归档行，不是 gram 总数）⇒ 防长文本主导。
- **确定性**：语料按 `content_id` / `msg_id` **升序**取前 `cap` 条（缺省 blocks 2000 / messages 2000）；
  `table_sha256 = sha256(n + corpusRows + 排序后的 gram|df 列表)`；落进 `detail_json.ngram_table_sha256`（**不改 DDL**）。
- **只出度量**：`gramCoverage` 返回**覆盖率数字**，**不返回**"是否命中"；`minIdf`/`topK` 只是过滤参数（缺省值属基座），"覆盖率多少算过"属 50 spec（T24 的接口形状即断言）。

#### 4.8.5 c-4 排他性检查输入源（取数，不判定）

```ts
export interface CitationSourceProvider {
  sessionWindow(sessionKey: string, opts?: WindowOpts): VisibleWindow;   // 只读，复用 P0 §5 API
  sessionAssetTexts(sessionKey: string): Map<string, string[]>;          // assetId → 该资产在同会话的可见文本片段
  rarityTable(): RarityTable;                                            // 懒构建 + 进程内缓存（key = tableSha256）
  excludedCategories(): readonly string[];                               // §3a excluded 类别（缺口见 §8.3）
}
```

- 默认实现 `archiveCitationSource(repo, opts?)`：`sessionWindow` 直复用 `windowVisibleText`（F25）；
  `sessionAssetTexts` 走档① occurrence 的 `asset_ids`（F26）⋈ `attribution_block_text.content_utf8`——**只读**，且**不 JOIN 档②消息**（消息面无资产身份）。
- **只读硬约束**：c-4 全路径**零写**（不 upsert、不动水位、不建表）；T25 用"写计数全 0 + 水位行不变"锁。
- **不判定**：`sessionAssetTexts` 只给"同会话各资产的可见文本集合"；"引文同时也出现在别的资产里 ⇒ 不算排他"这一步属 50 spec。
- 可注入：`setCitationSourceProvider()` / `__reset…ForTests()`（照 F7/F9 三件套），单测走 fake（语料 3 行、表可手算）。

#### 4.8.6 语料来源与"不增量"

- 语料 = 档① `attribution_block_text.content_utf8` ∪ 档② `attribution_message_snap.content_json` 的**文本投影**
  （复用生产侧 `messageTextFingerprint`/`truncateMessageContent` 同区的文本面口径，F32；**不新造**，也只取 text/tool_result 面，F27）。
- **不随判定期增量重建**：worker 启动时构建**一次**快照表（cap + 稳定序）⇒ 表 sha256 稳定、可 golden；增量/分片/淘汰策略属 50 spec（"用多少、怎么取样"是判定侧决策）。
- 档① `content_hash` 全局唯一（F29）⇒ 语料天然去重，无需二次去重。
- **缺 DB / 空语料**：`buildRarityTable([])` 合法（`docCount=0`，`idf` 取哨兵），调用方（50 spec）自行处理"无表"分支——基座不抛（与 F1 降级纪律一致）。

---

## 5. 单测清单（vitest，新增文件）

| # | 用例 | 断言要点 |
|---|---|---|
| T1 | 入队幂等 | 同 `(unit_id, round)` 二次入队 → **1 行** + `dedupeConflicts` +1 |
| T2 | 认领 CAS | 两个 owner 同轮抢 → 只有 1 个 `changes()==1`；另一 owner `changes()==0` |
| T3 | 租约恢复 | `lease_expires_ms` 过期行可被再认领；未过期行**不可** |
| T4 | 死信 | `attempts` 达 `maxAttempts` → `failed`；再跑 `--once` **不动**它；`--retry-failed` 才复位 |
| T5 | 落库幂等（红线 8） | 同 `judgement_id` 二次 `INSERT OR IGNORE` → **1 行** + `ignored` +1 |
| T6 | judgement_id 确定性 | 同三元组两次派生的 id 逐字节相同；`asset_id=null` 与 `""` 的取舍**明确**（当前取 `""`） |
| T7 | mock 确定性 | 同输入两次 verdict 逐字节相同；输出不含时间/随机字段 |
| T8 | prompt ref | `prompt_sha256` 与字面量一致（golden）；改 `text` → sha256 变 |
| T9 | worker `--once` | 无待办 → 0 行 + 退出码 0；有待办 → 处理完即退出（不挂死） |
| T10 | 处理抛错 | `attempts+1`、回到 `pending` 或进 `failed`；**不被吞成成功** |
| T11 | DB 降级 | DB 不可用（`getDb()` → null，F1）⇒ 入队/消费静默降级、不抛 |
| T12 | 缺省回归 | `enqueue=false` ⇒ 决策单元落库照常、队列 **0 行** |
| T13 | 触发接线 | runner 落库后调用入队（fake queue 计数 = 落库单元数）；入队抛错**不影响**落库 |
| T14 | 引用日志 | 每次消费 1 行，字段最小集齐；日志初始化失败不影响判定 |
| T15 | golden | 固定 corpus verdict 序列 + prompt sha256 与快照逐字节一致 |
| T16 | 归一化级别（c-1） | `exact` 原字节不变；`whitespace` 折叠 `\t\r\n\u00a0\u3000`；`punctuation` 按**显式表**折叠，**表外字符一律不动** |
| T17 | 归一化只用于比较（c-1） | 跑完整消费路径后 `attribution_block_text.content_utf8` 与写入时**逐字节相同**（防"顺手净化"）；`match_level` 已落 `detail_json` |
| T18 | 删字节审计（c-2 核心） | 对**真实 golden 渲染串**（render-golden 四 case）`removed[]` 每段都等于某条模板展开；出现**无认领删除**即 fail |
| T19 | 剥离幂等 + 真包装净除（c-2） | `strip(strip(x))===strip(x)`；四 case 剥离后不再含 `<…>` 块标签与 `1. [episodic]` 前缀 |
| T20 | **剥离反例（R8）** | 资产正文本身以 `1. ` 开头、或正文里含 `</knowledge_tools>` 字面量 → **必须原样保留** |
| T21 | 稀有度表确定性（c-3） | 同语料两次构建 → `tableSha256` 逐字节相同；换 `n` → 变；**语料输入顺序打乱 → 不变**（内部排序） |
| T22 | `cap` 语义（c-3） | 超 cap → `corpusRows.capped=true` 且取"按 id 升序前 cap 条"，可复现 |
| T23 | `df`/`idf` 正确性（c-3） | 3 行手算语料逐 gram 校验 `df`；`idf` 随 `df` 单调不增 |
| T24 | 度量接口形状（c-3） | 罕见引文 coverage 高、通用短语 coverage 低；**返回值必须是数字/数组，不含布尔判定** |
| T25 | 输入源只读（c-4） | fake + 真 repo 各跑一遍：`getVisibleArchiveWriteCounters()` 全 0、`readWatermark` 结果不变 |
| T26 | 上移零漂移（§4.8.1） | 上移后 `visible-archive-golden` + `visible-archive-http-smoke` 字节断言全绿；helper 仅 re-export（import 面未变） |
| T27 | 模板表完整性（golden 联动） | render-golden 四 case 中出现的包装构造，必须**被 registry 覆盖**或落在显式"资产正文不剥"白名单（防渲染器改了表不知情） |

---

## 6. 验收：三跳闭环（真进程）

**装置**：照 F22（`s4-stubs.ts` + 端口纪律，stub 上游 `18701/18702`、内核 `18420`）+ 独立 `PROXY_DB_PATH`/`PROXY_DATA_DIR`。

| 步 | 动作 | 通过标准（**每条都要正向证据**） |
|---|---|---|
| 1 | 起真 proxy：`injection.enabled=true`、`injectors: ["knowledge"]`（保证 pipeline 真跑，S4 勘正口径）、`decisionUnitExtractor.enabled=true`、`attribution.judge.enqueue=true`、`attributionEvents=false`（隔离） | `[injection-debug] … injectionEnabled= injectors=` 出现 |
| 2 | 打 1 次真实 HTTP 请求（anthropic 形态 + `x-claude-code-session-id`） | 决策单元落库 ≥1 **且** `attribution_judge_queue` `status='pending'` **≥ 1** |
| 3 | 起真 worker：`npm run worker:attribution -- --config … --once` | 退出码 0；`attribution_judgement_details` **恰好 1 行**；`judge_impl='mock:v1'`；`prompt_sha256` 非空且 == 字面量 |
| 4 | 再跑一次 `--once` | 判定明细**不增行**（红线 8）；队列该行 `status='done'` |
| 5 | 回归 | `git status` 生产语义零改动（新增文件 + additive DDL）；`npm test` / `typecheck:baseline` 数字与基线一致（`PASS — 55`） |
| 6 | 缺省回归 | `enqueue=false` → 队列 0 行、其余足迹与开 toggle 前逐项相同 |
| 7 | **基座-c（不进三跳冒烟）** | 纯函数单测 T16–T27 全绿；真实 golden 串的删字节审计（T18）+ 稀有度确定性（T21）已过；**上移后 P0 两套装置仍逐字节绿**（T26）；`git status` 生产语义零改动 |

**回滚口径**：`attribution.judge.enqueue=false`（缺省）⇒ 运行时零访问（DDL 仍 additive 建表，照 P0 C4 口径）；清理 SQL 见 checklist §3。

---

## 7. 锚点文件（实作对照用）

| 用途 | 文件（行号 = 设计侧核到） |
|---|---|
| 队列/落库 repo 姿势 | `src/db/attributionEventRepo.ts:186-221`（事务 + 冲突跳过）、`:252,263,271,276`（三件套 + Null） |
| 可注入单例 + 幂等写法 | `src/db/visibleTextRepo.ts:189,200,242,291,411,419,424` |
| DB + PRAGMA | `src/db/index.ts:6,71,85-87` |
| additive DDL 口径 | `src/db/schema.ts:16,68-70,71-96,100-145` |
| 优雅退出范式 | `src/index.ts:149-165` |
| 触发点 | `src/decision-units/decision-unit-runner.ts:9-11,42,125-130`、`src/anthropicHandler.ts:995-1012`、`src/handler.ts:1114-1132` |
| config | `src/config.ts:89-93,277,410-426` |
| 轮询 worker 参考（跨仓） | `MemoryCore/src/services/pipeline-worker.ts:132,156,180-186` |
| 自查重排 + `unref`（跨仓） | `MemoryCore/src/offload/index.ts:946-953,1284-1300` |
| 本地模型调用（跨仓，50 spec 用） | `MemoryCore/src/offload/local-llm/llm-caller.ts:43,51,70` |
| prompt ref + sha256（跨仓） | `MemoryCore/src/core/memory-generation-log/types.ts:12-16,31`、`store.ts:54,60` |
| 引用日志器（复用） | `src/report/file-logger.ts`（整文件；rotation + error-silent） |
| golden 装置 | `scripts/qa/record-render-golden.ts`（+ 对应 test/snap）、`scripts/qa/tsc-baseline-check.mjs` |
| 真 HTTP 测试装置 | `src/injection/__tests__/_helpers/s4-stubs.ts`、`docs/implementation/s4-smoke-checklist.md` §1-§2 |
| ⚠️ 命名冲突（勿混） | `src/judge-client.ts:10,88,106-115,142-152`（CostGuard judge） |
| 清理 SQL 姿势 | `docs/implementation/10-event-table.md` §10（`:209-235`） |
| 渲染包装实测形态（基座-c 模板表依据） | `src/injection/injectors/__tests__/render-golden.snap.json:2-5`、`render-golden-cases.ts:20-26` |
| 可见正文/胶水唯一实现（**待上移**） | `src/injection/__tests__/_helpers/attribution-window.ts:24-60,104-145` |
| 胶水源头（上移后的引用目标） | `src/session/context-injector.ts`（`appendBlockToAnthropicSystem` / `appendBlockToOpenAISystem`） |
| P0 读面 API（c-4 复用） | `src/db/visibleTextRepo.ts:118-139,437-454,488-548,550-556` |
| 按资产分组（c-4 物料） | `src/db/schema.ts:183-193`（`attribution_block_seen.asset_ids`） |
| 消息文本面工具（复用，不新造） | `src/decision-units/message-increment-archive.ts:34,52,89,141` |
| P0→基座 接口承诺 | `40-visible-text-archive.md` §5（L164）、§10（L290） |

---

## 8. 裁决留档 / 明确不做 / 缺口登记

### 8.1 基座-c：**已裁决并入本期**（2026-09-10）

**范围**（立项 §1 第 2 条）：引用验证工具（空白/标点归一化、渲染包装剥离）、区分性 n-gram 表 + 稀有度查表、排他性检查输入源。
**落地**：§1.1 的 c-1…c-4 + §4.8 设计 + T16–T27 单测；形态 = **纯函数 + 可注入 provider**。

**设计侧原建议（留档，未采纳）**：后置到 50 spec 前单开一期，三条理由 ——
① 接口形状由 S5 判定流程决定，50 spec 未定就做大概率返工（P0 的"先定接缝后改"即同类教训）；
② 稀有度语料的来源未定（用多少 / 怎么取样 / 是否增量，属判定侧决策）；
③ 不阻塞三跳闭环，立项本身也把它归为"纯基建、无事件语义"。

**裁决后成立的额外证据**（设计侧现场核到，反过来支持并入）：

1. **P0 已经把接口许给基座**（F28）：40 spec §5 L164 / §10 L290 明写"归一化/剥离/查引工具在共享基座，本模块只出窗口" ⇒ 后置 = 让 P0 的交接注释**长期指向空处**，S5 无接口可用。
2. **唯一实现纪律已存在、位置不对**（F31）：`visibleTextOfPiece` / `SEAM_GLUE` / `stripGlue` 现居**测试目录**，生产消费方无法合法 import ⇒ 不动它，S5 必然另写一份 ⇒ 两块实现各自自洽 = **假绿**。并入本期正好把"上移一次做完"（§4.8.1 / T26）。
3. **包装形态是可枚举的**（F24：真实 golden 四 case）——不是"等 50 spec 才知道"的未知；模板表 + 删字节审计足以把"剥离"钉成**机械可复核**的动作。

**并入的代价与处置（诚实记账）**：

- 需动**测试 helper 的 import 面**（上移 + re-export）⇒ 必须复跑 P0 两套装置证明零漂移（T26）。这是本期**唯一**触到已闭验收物的动作，也是本次范围变更的**唯一**新增风险。
- 基座-c 的**阈值**不在本期（§1.2）⇒ `gramCoverage` 只出数字；50 spec 定阈值时**可能要求换 `n` 或改语料采样** ⇒ 表结构已按可换设计（`n`/`cap` 可配 + `table_sha256` + `corpusRows`）。
- 若 50 spec 要的输入与 c-4 接口不符，改的是**接口实现**而非重写纯函数（纯函数只吃字符串）。

**范围守卫**：基座-c **不引入任何判定分支**（接口只返回数字/字符串/数组）；阈值与裁决留 50 spec（§1.2）。

### 8.2 本期明确不做

见 §1.2（真 provider / 判定语义 / 基座-c 阈值与裁决 / 另两张表 / 任务边界规则 / `round>0` 生产路径 / v1 表改动）。

### 8.3 缺口登记：40 spec §5 承诺的 `excluded` 清单未落地（**不扩范围，仅钉住**）

**缺口**：40 spec §5 L164 承诺「excluded 清单（§3a）随窗口返回，便于判定上下文完整归因」，但**实现面没有这个字段** ——
`windowVisibleText()` 返回 `VisibleWindow{ epoch, pieces }`（`visibleTextRepo.ts:451-454,488-548`），`archiveVisibleText()` 只多给 `epochs`；P0 的 golden 装置把 excluded 当**概念**用（断言其不入档），未随窗口交付（`visible-archive-golden.test.ts:11,164-168`）。

**处置建议（二选一，设计侧倾向 (b)，但**本期不做选择**）**：

- (a) 基座-c 的 `CitationSourceProvider.excludedCategories()` 返回 §3a 的 excluded **类别常量**（1 个常量 + 1 条测试）——成本极低，但"类别够不够用"由 S5 的归因完整性需求定；
- (b) **留 50 spec**：先定"归因完整性需要 excluded 的**枚举**还是**类别**"，再一次性加对形状（P0 的教训：schema 形状先定后改代价高）。

本期只把缺口钉在这里，避免 S5 撰写时才发现"窗口没带 excluded"。`excludedCategories()` 在 §4.8.5 接口里**先留位**（返回类型已定，实现可先返回 `[]` + TODO 注释指向本节）。

---

## 9. 交接纪律

- **分支**：`feature/attribution-v2`（当前 head `22fad92`，工作树干净）。
- **提交分组建议**（每片独立 commit + DCO `git commit -s`）：
  ① docs（本任务书 + `attribution-base-checklist.md` + M2 三处勘正）
  ② DDL + 队列 repo + counters
  ③ worker 进程 + CLI（`--once` / `--retry-failed`）
  ④ Judge 接口 + mock + prompt ref + 引用日志
  ⑤ 单测 T1–T15（三跳骨架）
  ⑥ **基座-c**：`visible-text.ts` 上移 + normalize / wrapper-registry / ngram / source + 单测 T16–T27
  ⑦ golden 装置 + 三跳冒烟证据 + 文档回填（checklist 勾选 + 数字）
- ⚠️ ⑥ 里的**上移**（`attribution-window.ts` 口径 → `src/attribution/citation/visible-text.ts` + helper re-export）**单开一个 commit**
  （建议 `refactor(proxy): 可见正文/胶水口径上移到生产模块`），与纯新增的基座-c 代码分开 —— 便于 reviewer 用 T26 单独验"零漂移"，也让"唯一触到已闭验收物"的动作**独立可回滚**。
- **文档待办（立项 §6 M2，建议本次顺手清）**：
  - `00-master-spec.md` **§1 L21-22** 仍把"设计文档 3.4/3.5 的排序反哺"列进 **v2 推迟段**，与 **§7 L111**「v3：信用分→排序 / 索引行 | S8」**矛盾** ⇒ 在 §1 加注"排序反哺以 §7 S8=v3 为准"。
  - `00-master-spec.md` **§9 L135** 文档清单仍把 `40-…` 写成"（v2 起）待写" ⇒ 改为 **已完成**，并补基座行（建议 `41-attribution-base.md` 或指向本任务书）。
  - 同源口径：`codebuddy-scratch/handoff/attribution-v1-progress.md` **§2 L55**（"推迟 v2：…、排序反哺"）⇒ 同样加注。
  - 这三处是**纯文档**，半页；可与 ① 合并，也可单开 `docs(proxy)` commit。
  - ⇒（81 核，2026-09-12）：**§1 与 §9 两条已执行**——`00-master-spec.md:23-25` 有"排序反哺以 §7 `S8=v3` 为准"勘正段；`:138` 的 `40-…` 已写"P0 已完成"，`:140-142` 基座行已补（指向 `attribution-base-design.md` + `attribution-base-checklist.md`，两者均实存；未用提议名 `41-attribution-base.md`——该名不存在）。**"同源口径"一条**：目标 `codebuddy-scratch/handoff/attribution-v1-progress.md` **已不在**（仓库外 scratch 已清理）⇒ **登记为不做（目标消失、无残留矛盾）**，非静默放着。
  - **基座-c 落地后**：在 40 spec §5（L164）/ §10（L290）的交接注释上标注"基座-c 已交付（`attribution-base-design.md` §4.8）"，把"许给基座"变成"已兑现"。
- **回填**：checklist §4 勾选 + 数字（`npm test` 全量 / `typecheck:baseline` / 冒烟证据路径）。
- **验收口径不变**（v1 起的惯例）：**单测 + 真实冒烟 + 缺省 off 回滚**。

---

## 勘正记录

（设计侧锚点/口径错误在此追加，勿静默回改正文。格式：日期 — 原文 → 实际 + 证据。）

- 2026-09-10 设计侧首次核定，暂无勘正。
- 2026-09-10 **范围变更（用户裁决）**：§8.1 基座-c 由"设计侧建议后置"改为**并入本期**；§0/§1.1/§1.2/§2/§4.8/§5/§6/§7/§9 已同步。原建议与其三条理由**保留在 §8.1**（痕迹留档，不回删）。
- 2026-09-10 **原理由 ① 被新证据弱化**：§8.1 原理由"接口形状由 S5 决定 ⇒ 后置"仍部分成立，但 **F28** 显示 P0 已把接口许给基座（40 spec §5 L164 / §10 L290），故"后置"实为**违约交付**。理由 ②③ 仍成立（语料采样策略、不阻塞三跳）。
- 2026-09-10 **缺口登记（非勘正）**：40 spec §5 L164 承诺的 `excluded` 清单随窗口返回，实现面缺失（证据 `visibleTextRepo.ts:451-454,488-548`）⇒ 见 §8.3。
- 2026-09-10 **新发现（本任务书新增约束）**：可见正文/胶水的**唯一实现现居测试目录**（`src/injection/__tests__/_helpers/attribution-window.ts`，F31）⇒ 基座-c 必须先**上移**到生产模块再复用（§4.8.1 / T26），这是本次范围变更引入的**唯一**已闭验收物触碰点。
