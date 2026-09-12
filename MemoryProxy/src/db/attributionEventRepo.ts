/**
 * AttributionEventRepo — persistence layer for the attribution capture chain
 * (v1 S1-S3). The `attribution_events` table is the single landing point for
 * injection lifecycle events (S2 EventObserver) and decision-unit events (S3
 * extractor). S1 itself wires no producer: the table exists as the receiver,
 * so nobody writes/nobody reads until a later slice starts appending.
 *
 * See MemoryProxy/docs/implementation/10-event-table.md for the DDL contract.
 *
 * Failure semantics: any DB error degrades silently (no throw). SQLite unique
 * violations on the S3 dedupe anchor `idx_ae_unit_dedupe` are *expected* on
 * crash replay — they are swallowed at **info** level (dedupe = 预期路径, 与真实
 * 失败区分开：真实失败才 warn，见 v1.1 最小观测 / getAttributionWriteCounters)。
 *
 * Row shape follows the repo convention: snake_case columns returned as-is;
 * `payload_json` is handed to the caller, who parses it (repo layer does not
 * decode business objects — same discipline as hookCacheRepo/sessionRepo).
 */

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { getDb } from "./index.js";

/** Write input for a single event row. Optional identifiers are omitted by
 *  producers when unresolvable — never fabricated (see docs §4.1). */
export interface NewAttributionEvent {
  spaceId?: string; // 缺省 "_default"
  userId?: string;
  agentSource?: string;
  sessionKey: string;
  turnSeq?: number | null;
  msgSeq?: number | null;
  eventType: string;
  assetId?: string | null; // 真实资产外部 id（skill_id / knowledge_id / chat_memory- 复合 id）
  assetType?: string | null; // skill / llm_wiki / code_graph / chat_memory
  unitId?: string | null;
  payload: unknown; // JSON.stringify 存 payload_json
}

/** Persisted row, snake_case columns (payload_json stays a raw string). */
export interface AttributionEventRow {
  event_id: string;
  space_id: string;
  user_id: string | null;
  agent_source: string | null;
  session_key: string;
  turn_seq: number | null;
  msg_seq: number | null;
  event_type: string;
  asset_id: string | null;
  asset_type: string | null;
  unit_id: string | null;
  payload_json: string;
  created_at: number;
}

/** `listBySessionWithRowid` 的行形状：全部列 + `rowid`（插入序，50 spec §10 的唯一定序键）。 */
export interface AttributionEventRowWithRowid extends AttributionEventRow {
  rowid: number;
}

export interface AttributionEventRepo {
  /** 追加单条。event_id 由实现生成（randomUUID）。写失败静默降级（console.warn）。 */
  append(e: NewAttributionEvent): void;
  /** 批量追加（事务），供 S3 一轮多单元一次性落库。冲突行静默跳过。 */
  appendMany(events: NewAttributionEvent[]): void;
  /** 按会话倒序取事件，供调试/冒烟断言（v2 消费端另立查询）。 */
  listBySession(
    sessionKey: string,
    opts?: { eventType?: string; limit?: number },
  ): AttributionEventRow[];
  /** 按真实资产维度取事件（v1 S0/S2 填充后即有数据）。 */
  listByAsset(assetId: string, opts?: { limit?: number }): AttributionEventRow[];
  /**
   * 50 spec §10 C4② 锚定专用读口：显式取 `rowid`、按插入序升序、**会话全量（无 LIMIT）**。
   * （既有 `listBySession` 是 `SELECT *` 不含 rowid、按 created_at 倒序且有 LIMIT，不能复用。）
   */
  listBySessionWithRowid(sessionKey: string): AttributionEventRowWithRowid[];
  /**
   * 69 · 会话枚举读口（70 spec §3.1；**只读、无副作用**）：
   * `created_at >= sinceMs` 水位内出现过的 session（去重、确定性排序；sinceMs 缺省 0 = 全量）。
   * DB 降级 ⇒ 空数组（与 Null repo 姿势一致）。
   */
  distinctSessionKeys(sinceMs?: number): string[];
}

const DEFAULT_SPACE_ID = "_default";

/**
 * v1.1 最小观测（二轮评审 R1）：写路径计数，让"预期去重（dedupe）"与"真实失败"
 * 在运行时可区分 —— 退化开始时不再是静默的。
 */
export interface AttributionWriteCounters {
  appended: number;
  dedupeConflicts: number;
  failures: number;
}
const writeCounters: AttributionWriteCounters = { appended: 0, dedupeConflicts: 0, failures: 0 };

/** 读写路径计数快照（开启 checklist / 观测用；失败 > 0 即需人工介入）。 */
export function getAttributionWriteCounters(): AttributionWriteCounters {
  return { ...writeCounters };
}

/** SQLite throws SQLITE_CONSTRAINT_* for UNIQUE/PRIMARY KEY violations. */
function isConstraintViolation(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
  }
  return false;
}

function spaceIdOf(spaceId: string | undefined): string {
  return spaceId && spaceId.trim().length > 0 ? spaceId.trim() : DEFAULT_SPACE_ID;
}

function toInsertParams(e: NewAttributionEvent): {
  event_id: string;
  space_id: string;
  user_id: string | null;
  agent_source: string | null;
  session_key: string;
  turn_seq: number | null;
  msg_seq: number | null;
  event_type: string;
  asset_id: string | null;
  asset_type: string | null;
  unit_id: string | null;
  payload_json: string;
  created_at: number;
} {
  return {
    event_id: randomUUID(),
    space_id: spaceIdOf(e.spaceId),
    user_id: e.userId ?? null,
    agent_source: e.agentSource ?? null,
    session_key: e.sessionKey,
    turn_seq: e.turnSeq ?? null,
    msg_seq: e.msgSeq ?? null,
    event_type: e.eventType,
    asset_id: e.assetId ?? null,
    asset_type: e.assetType ?? null,
    unit_id: e.unitId ?? null,
    payload_json: JSON.stringify(e.payload ?? {}),
    created_at: Date.now(),
  };
}

const INSERT_SQL = `
INSERT INTO attribution_events (
  event_id, space_id, user_id, agent_source, session_key, turn_seq, msg_seq,
  event_type, asset_id, asset_type, unit_id, payload_json, created_at
) VALUES (
  @event_id, @space_id, @user_id, @agent_source, @session_key, @turn_seq, @msg_seq,
  @event_type, @asset_id, @asset_type, @unit_id, @payload_json, @created_at
)
`;

class SqliteAttributionEventRepo implements AttributionEventRepo {
  private insertStmt: Database.Statement;
  private bySessionStmt: Database.Statement;
  private bySessionTypeStmt: Database.Statement;
  private byAssetStmt: Database.Statement;
  private bySessionWithRowidStmt: Database.Statement;
  private distinctSessionsStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(INSERT_SQL);
    this.bySessionStmt = db.prepare(
      "SELECT * FROM attribution_events WHERE session_key = ? ORDER BY created_at DESC, event_id ASC LIMIT ?",
    );
    this.bySessionTypeStmt = db.prepare(
      "SELECT * FROM attribution_events WHERE session_key = ? AND event_type = ? ORDER BY created_at DESC, event_id ASC LIMIT ?",
    );
    this.byAssetStmt = db.prepare(
      "SELECT * FROM attribution_events WHERE asset_id = ? ORDER BY created_at DESC, event_id ASC LIMIT ?",
    );
    this.bySessionWithRowidStmt = db.prepare(
      "SELECT rowid, * FROM attribution_events WHERE session_key = ? ORDER BY rowid ASC",
    );
    // 69 · 会话枚举（只读；确定性排序）。
    this.distinctSessionsStmt = db.prepare(
      "SELECT DISTINCT session_key FROM attribution_events WHERE session_key != '' AND created_at >= ? ORDER BY session_key ASC",
    );
  }

  append(e: NewAttributionEvent): void {
    try {
      this.insertStmt.run(toInsertParams(e));
      writeCounters.appended += 1;
    } catch (err) {
      if (isConstraintViolation(err)) {
        // 幂等重放是预期路径（S3 崩溃重放）：info 级（与真实失败 warn 区分开）。
        writeCounters.dedupeConflicts += 1;
        console.info(
          `[attribution-events] append skipped dedupe conflict (session=${e.sessionKey} type=${e.eventType})`,
        );
        return;
      }
      writeCounters.failures += 1;
      console.warn(
        `[attribution-events] append failed (session=${e.sessionKey} type=${e.eventType}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  appendMany(events: NewAttributionEvent[]): void {
    if (events.length === 0) return;
    try {
      const tx = this.db.transaction((items: NewAttributionEvent[]) => {
        let conflicts = 0;
        for (const e of items) {
          try {
            this.insertStmt.run(toInsertParams(e));
            writeCounters.appended += 1;
          } catch (err) {
            // 唯一索引冲突（idx_ae_unit_dedupe）在崩溃重放是预期路径：跳过该行，
            // 其余行照常落库（单事务不能因一行重复把整批回滚）。非约束错误上抛。
            if (isConstraintViolation(err)) {
              conflicts += 1;
            } else {
              throw err;
            }
          }
        }
        return conflicts;
      });
      const conflicts = tx(events);
      writeCounters.dedupeConflicts += conflicts;
      if (conflicts > 0) {
        console.info(
          `[attribution-events] appendMany skipped ${conflicts}/${events.length} dedupe-conflict row(s)`,
        );
      }
    } catch (err) {
      writeCounters.failures += 1;
      console.warn(
        `[attribution-events] appendMany failed (count=${events.length}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  listBySession(
    sessionKey: string,
    opts?: { eventType?: string; limit?: number },
  ): AttributionEventRow[] {
    try {
      const limit = Math.max(1, Math.floor(opts?.limit ?? 100));
      const stmt = opts?.eventType ? this.bySessionTypeStmt : this.bySessionStmt;
      const rows = (stmt.all(
        opts?.eventType ? [sessionKey, opts.eventType, limit] : [sessionKey, limit],
      ) ?? []) as AttributionEventRow[];
      return rows;
    } catch {
      return [];
    }
  }

  listByAsset(assetId: string, opts?: { limit?: number }): AttributionEventRow[] {
    try {
      const limit = Math.max(1, Math.floor(opts?.limit ?? 100));
      const rows = (this.byAssetStmt.all(assetId, limit) ?? []) as AttributionEventRow[];
      return rows;
    } catch {
      return [];
    }
  }

  listBySessionWithRowid(sessionKey: string): AttributionEventRowWithRowid[] {
    try {
      return (this.bySessionWithRowidStmt.all(sessionKey) ?? []) as AttributionEventRowWithRowid[];
    } catch {
      return [];
    }
  }

  distinctSessionKeys(sinceMs = 0): string[] {
    try {
      const rows = (this.distinctSessionsStmt.all(Math.max(0, Math.trunc(sinceMs))) ?? []) as Array<{
        session_key: string;
      }>;
      return rows.map((r) => r.session_key);
    } catch {
      return [];
    }
  }
}

class NullAttributionEventRepo implements AttributionEventRepo {
  append(): void {}
  appendMany(): void {}
  listBySession(): AttributionEventRow[] {
    return [];
  }
  listByAsset(): AttributionEventRow[] {
    return [];
  }
  listBySessionWithRowid(): AttributionEventRowWithRowid[] {
    return [];
  }
  distinctSessionKeys(): string[] {
    return [];
  }
}

let _repo: AttributionEventRepo | null = null;

export function getAttributionEventRepo(): AttributionEventRepo {
  if (_repo) return _repo;
  const db = getDb();
  _repo = db ? new SqliteAttributionEventRepo(db) : new NullAttributionEventRepo();
  return _repo;
}

/** Replace the singleton (e.g. tests with an in-memory/alternate backend). */
export function setAttributionEventRepo(repo: AttributionEventRepo): void {
  _repo = repo;
}

/** Reset singleton — tests only. */
export function __resetAttributionEventRepoForTests(): void {
  _repo = null;
  writeCounters.appended = 0;
  writeCounters.dedupeConflicts = 0;
  writeCounters.failures = 0;
}
