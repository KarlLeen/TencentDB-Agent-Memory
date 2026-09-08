/**
 * SQLite schema for MemoryProxy local persistence.
 *
 * Tables:
 *   - sessions:            persists session metadata (sessionInfo / agentDetail / taskDetail).
 *   - hook_cache:          persists prewarmed injection blocks per (session_id, hook_id).
 *   - attribution_events:  persists injection lifecycle / decision-unit events produced by
 *                          the attribution capture chain (v1 S2 EventObserver / S3 extractor).
 *                          No producer is wired yet (S1 is the receiver only), so the table is
 *                          intentionally dormant — nobody writes, nobody reads.
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
  msg_seq      INTEGER,            -- 决策单元首条消息下标（S3 幂等用），非决策事件为 NULL
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
`;
