/**
 * SQLite schema for MemoryProxy local persistence.
 *
 * Tables:
 *   - sessions:            persists session metadata (sessionInfo / agentDetail / taskDetail).
 *   - hook_cache:          persists prewarmed injection blocks per (session_id, hook_id).
 *   - attribution_events:  persists injection lifecycle / decision-unit events produced by
 *                          the attribution capture chain (v1 S1 table → S2 EventObserver →
 *                          S3 decision-unit extractor). Producers are wired as of S2/S3;
 *                          when attribution capture is disabled the table stays dormant.
 *   - attribution_judge_queue / attribution_judgement_details:
 *                          shared-base (v2 pre-skeleton) judge queue + verdict details.
 *                          Producers/consumer are wired as of the base slice; when
 *                          `attribution.judge.enqueue` is false (default) both stay
 *                          dormant (no read, no write) —
 *                          see docs/implementation/attribution-base-design.md §4.1/§4.3.
 *
 * Schema is created with `IF NOT EXISTS` so it's safe to call on every startup.
 * `schema_version` row in `meta` table allows future migrations.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  -- Primary identifier. For pending_form / uninitialized rows we use the
  -- session_key as the id (since no real session_id exists yet); for
  -- initialized rows we use the control-plane returned session_id.
  session_id        TEXT PRIMARY KEY,
  session_key       TEXT NOT NULL,
  status            TEXT NOT NULL,
  agent_id          TEXT,
  task_id           TEXT,
  user_id           TEXT,
  -- Legacy column name; now stores the user_id from auth/verify (see sessionRepo.ts).
  -- Kept for backward compat with existing DB files.
  cb_user_id        TEXT,
  agent_detail_json TEXT,
  task_detail_json  TEXT,
  session_info_json TEXT,
  state_json        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_session_key ON sessions(session_key);
CREATE INDEX IF NOT EXISTS idx_sessions_status      ON sessions(status);

CREATE TABLE IF NOT EXISTS hook_cache (
  session_id  TEXT NOT NULL,
  hook_id     TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, hook_id),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

-- Attribution capture chain (v1 S1-S3) unified landing table. Spec:
-- MemoryProxy/docs/implementation/10-event-table.md.
--
-- Design notes (locked there, see §4):
--   * payload_json 归一列 + 少量过滤列，延续 sessions/hook_cache 的 JSON blob 风格；
--   * asset_id 不是本系统自造键，必须回指 meta 资产目录真实实体（skill_id /
--     knowledge_id / chat_memory- 复合 id，见 docs §4.1 契约），取不到时显式 NULL；
--   * msg_seq 只对决策单元事件非空，partial unique index 做 S3 幂等锚（重放安全），
--     非决策事件（msg_seq IS NULL）不受约束；
--   * space_id 为空段时由写入方兜底为 '_default'（与 sessionRowId 口径一致）。
--
-- SCHEMA_VERSION intentionally stays 1: this is pure additive DDL (IF NOT EXISTS is
-- idempotent on every startup) and runSchema has no migration runner. A future slice
-- that ALTERs an existing table must introduce a real migration mechanism — see docs §5.1.
CREATE TABLE IF NOT EXISTS attribution_events (
  event_id     TEXT PRIMARY KEY,   -- uuid v4 (node:crypto randomUUID)
  space_id     TEXT NOT NULL,      -- 权限/回执过滤段，写入方缺省 "_default"
  user_id      TEXT,
  agent_source TEXT,               -- codebuddy / claude-code / ...
  session_key  TEXT NOT NULL,      -- 会话隔离键（同 anthropicHandler resolveSessionKey）
  turn_seq     INTEGER,            -- 轮次；同 observer metadata.turnSeq 口径，类型事件可空
  msg_seq      INTEGER,            -- 决策单元编码 msg_seq = anchor×16 + slot（S3 幂等用），非决策事件为 NULL
  event_type   TEXT NOT NULL,      -- v1 词汇表见 00-master-spec §3
  asset_id     TEXT,               -- 真实资产外部 id（docs §4.1：skill_id / knowledge_id / chat_memory- 复合 id）
  asset_type   TEXT,               -- skill / llm_wiki / code_graph / chat_memory
  unit_id      TEXT,               -- 决策单元 id（S3 写）
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL    -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_ae_session_time ON attribution_events(session_key, created_at);
CREATE INDEX IF NOT EXISTS idx_ae_asset         ON attribution_events(asset_id);
CREATE INDEX IF NOT EXISTS idx_ae_unit          ON attribution_events(unit_id);
CREATE INDEX IF NOT EXISTS idx_ae_type          ON attribution_events(event_type);

-- S3 幂等锚：同一 (session_key, turn_seq, msg_seq) 只允许一条决策单元事件。
-- partial index（WHERE msg_seq IS NOT NULL）让非决策事件（msg_seq=NULL）不受约束。
CREATE UNIQUE INDEX IF NOT EXISTS idx_ae_unit_dedupe
  ON attribution_events(session_key, turn_seq, msg_seq)
  WHERE msg_seq IS NOT NULL;

-- ── P0 visible-text archive（docs/implementation/40-visible-text-archive.md §6，命名冻结）──
-- 档① = 注入渲染 block 全文（含 session-context 合成块）；档② = 消息流增量快照（epoch/compaction
-- 镜像 decision-unit-runner 内存水位语义）。纯 additive DDL：SCHEMA_VERSION 仍为 1。
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

CREATE TABLE IF NOT EXISTS attribution_block_seen (
  seen_id     INTEGER PRIMARY KEY,
  session_key TEXT NOT NULL,
  turn_seq    INTEGER NOT NULL,        -- countHumanTurns 窗口计数口径，compaction 后重算
  hook_id     TEXT NOT NULL,
  point       TEXT NOT NULL,
  content_id  INTEGER NOT NULL REFERENCES attribution_block_text(content_id),
  block_idx   INTEGER NOT NULL,
  asset_ids   TEXT,                    -- JSON：collectAssets identity 摘要（无 spans）
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ablk_seen ON attribution_block_seen(session_key, turn_seq);

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

CREATE TABLE IF NOT EXISTS attribution_archive_watermark (
  session_key     TEXT PRIMARY KEY,
  epoch           INTEGER NOT NULL DEFAULT 0,
  last_seen_count INTEGER NOT NULL DEFAULT 0   -- 镜像 runner 内存"已见消息条数"语义（B4）
);

-- ── 共享基座（v2 前置骨架）：judge 队列 + 判定明细 ──
-- docs/implementation/attribution-base-design.md §4.1（队列表）/ §4.3（落点表）。
-- 纯 additive DDL：SCHEMA_VERSION 仍为 1（IF NOT EXISTS 幂等；无 migration runner，见上方口径）。
-- 两张表都是**可重建的派生物**（状态可由全窗口重放重建）⇒ 本地清表零数据风险（checklist §3）。
-- 时间戳单位一律 **epoch 毫秒**（与 v1 created_at 同口径；别写成秒）。
CREATE TABLE IF NOT EXISTS attribution_judge_queue (
  queue_id         INTEGER PRIMARY KEY,               -- 单调：兼作消费游标（§4.2/§4.6，不另立水位表）
  unit_id          TEXT    NOT NULL,
  round            INTEGER NOT NULL DEFAULT 0,        -- 0=首次；>0=重判（生产路径留 50 spec）
  session_key      TEXT    NOT NULL,
  space_id         TEXT    NOT NULL DEFAULT '_default',
  trigger          TEXT    NOT NULL DEFAULT 'decision_unit', -- 占位：task_boundary/manual（50 spec）
  payload_json     TEXT    NOT NULL,                  -- 自足最小摘要（worker 只读本行，不回查 v1 表）
  status           TEXT    NOT NULL DEFAULT 'pending', -- pending|processing|done|failed
  attempts         INTEGER NOT NULL DEFAULT 0,
  lease_owner      TEXT,
  lease_expires_ms INTEGER,                           -- 租约到期时刻（epoch ms）；NULL = 无租约
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- 入队幂等键 = (unit_id, round)：同单元同轮只入队一次；跨轮（round+1）= 重判。
-- unit_id 是 v1 的内容哈希（30 spec §4.6），天然跨重放稳定 ⇒ 是合适的入队幂等键。
CREATE UNIQUE INDEX IF NOT EXISTS idx_ajq_dedupe ON attribution_judge_queue(unit_id, round);

-- 认领候选扫描：pending，或 processing 且租约已过期；队列序取 queue_id（单调游标）。
CREATE INDEX IF NOT EXISTS idx_ajq_claim
  ON attribution_judge_queue(status, lease_expires_ms, queue_id);

-- 归因判定明细（共享基座冻结此表；status_events / audit 留 50 spec 前定稿，DR-3）。
-- 落点唯一性锚 = (unit_id, round)（索引 idx_ajd_unit_round，见文件末）；确定性主键 judgement_id
--    仍保留 ⇒ 崩溃重放 / 租约重复判定都不会双记（红线 8）。
-- ⚠️ 不得改用 UNIQUE(unit_id, asset_id, round) 作锚：asset_id 可空，SQLite 里 NULL 互不相等，
--    该唯一索引在未归因（asset_id IS NULL）时形同虚设 —— 这正是 R2 的陷阱。
CREATE TABLE IF NOT EXISTS attribution_judgement_details (
  judgement_id   TEXT    PRIMARY KEY,   -- "jd_" + sha1(unit_id|asset_id|round).slice(0,12)
  unit_id        TEXT    NOT NULL,
  session_key    TEXT    NOT NULL,
  space_id       TEXT    NOT NULL DEFAULT '_default',
  asset_id       TEXT,                  -- 可空（未归因）；**不参与**任何唯一约束（见 R2）
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
-- 幂等/异常判别锚 = (unit_id, round)：同单元同轮只允许一个落点；
-- 该 (unit_id, round) 再来一条**不同 asset_id** ⇒ 判定异常（anomaly），由定向 upsert 识别。
-- ⚠️ 升级注意：旧语义（仅主键幂等）允许同一 (unit_id, round) 因 asset 不同而落多行；
--    存量库若已有这类行，本索引会创建失败 ⇒ 整个 SCHEMA_SQL 执行失败 ⇒ getDb() 返回 null（整库降级）。
--    属已登记的 known limitation（清掉重复行或重建该派生表即可；见 50 spec）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_ajd_unit_round
  ON attribution_judgement_details(unit_id, round);

-- 59 · 状态事件落点表（50 spec §14；红线 6：判定产物走新表，v1 attribution_events 只读）。
-- 纯 additive DDL：SCHEMA_VERSION 仍为 1（旧库无此表 ⇒ IF NOT EXISTS 自建，零迁移）。
CREATE TABLE IF NOT EXISTS attribution_status_events (
  status_id      TEXT    PRIMARY KEY,   -- "se_" + sha1(unit_id|asset_id|round).slice(0,12)（asset_id null ⇒ "" 占位）
  unit_id        TEXT    NOT NULL,
  session_key    TEXT    NOT NULL,
  space_id       TEXT    NOT NULL DEFAULT '_default',
  asset_id       TEXT    NOT NULL,      -- 本单恒非空（仅 confirmed+非空才写）；派生期 null ⇒ "" 占位（防未来事件型）
  asset_type     TEXT,
  round          INTEGER NOT NULL DEFAULT 0,
  event_type     TEXT    NOT NULL,      -- 本单唯一值 "asset_used"（validated/corrected 属消费侧，禁写）
  outcome        TEXT,                  -- 单元自带 resultStatus 时落；否则 NULL（不猜）
  turn_seq       INTEGER,               -- 恒 NULL（F4：不伪造轮次）
  msg_seq        INTEGER,               -- 恒 NULL
  payload_json   TEXT    NOT NULL,      -- 链接字段（只回指不复制判定内容；单一真相在 judgement_details）
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ase_unit    ON attribution_status_events(unit_id);
CREATE INDEX IF NOT EXISTS idx_ase_session ON attribution_status_events(session_key, created_at);
CREATE INDEX IF NOT EXISTS idx_ase_asset   ON attribution_status_events(asset_id, created_at);
`;
