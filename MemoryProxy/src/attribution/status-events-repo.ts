/**
 * AttributionStatusEventsRepo — 状态事件落点表（50 spec §14；DR-3 新表）。
 *
 * 纪律（违反即失去意义）：
 *   - **锚 = 派生主键** `status_id = "se_" + sha1(unit_id|asset_id|round).slice(0,12)`
 *     （asset_id 为 null ⇒ `""` 占位；**不用可空列 UNIQUE** —— SQLite NULL 互不相等 = R2 陷阱）。
 *   - **三态**判别（inserted / duplicate / failed）由定向 upsert 承担：
 *     `ON CONFLICT(status_id) DO UPDATE … RETURNING created_at` + 严格单调 created_at。
 *     **没有 anomaly**：锚 = 主键全等（unit_id/asset_id/round 三者全同），不存在"同锚不同 asset"
 *     的异常面（与 judgement 的 `(unit_id, round)` 锚不同）。
 *   - `turn_seq` / `msg_seq` **恒 NULL**（F4：不伪造轮次）。
 *   - **只回指、不复制判定内容**：payload 只有链接字段（单一真相在 judgement_details）。
 *   - **汇总 = 查询层，不物化**（listByAsset / rollupByAsset；避免第二份真相）。
 */
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

import { getDb } from "../db/index.js";

/** 本单唯一事件型（validated / corrected 属消费侧，禁写）。 */
export const STATUS_EVENT_TYPE_ASSET_USED = "asset_used";

export interface NewStatusEvent {
  unitId: string;
  sessionKey: string;
  spaceId?: string;
  /** 本单恒非空（仅 confirmed+非空才写）；类型留 null 口子只为派生占位语义显式。 */
  assetId: string;
  assetType: string | null;
  round: number;
  /** 单元自带 resultStatus 时落；否则 null（不猜）。 */
  outcome: string | null;
  /** 链接字段（只回指不复制判定内容）：{ judgement_id, verdict, match_level, coverage, prompt_sha256, judge_impl, unit_id }。 */
  payload: unknown;
}

export interface StatusEventRow {
  status_id: string;
  unit_id: string;
  session_key: string;
  space_id: string;
  asset_id: string;
  asset_type: string | null;
  round: number;
  event_type: string;
  outcome: string | null;
  turn_seq: number | null;
  msg_seq: number | null;
  payload_json: string;
  created_at: number;
}

export type StatusEventInsertKind = "inserted" | "duplicate" | "failed";

export interface StatusEventInsertResult {
  statusId: string;
  kind: StatusEventInsertKind;
}

/** 写/不写都有可观测计数（F5：refuted/unconfirmed 不写也要计数）。 */
export interface AttributionStatusEventsCounters {
  inserted: number;
  duplicate: number;
  failures: number;
  /** 护栏违反：confirmed + assetId null（构造上不可能，出现即 bug）。 */
  guardViolations: number;
  skippedRefuted: number;
  skippedUnconfirmed: number;
}

const counters: AttributionStatusEventsCounters = {
  inserted: 0,
  duplicate: 0,
  failures: 0,
  guardViolations: 0,
  skippedRefuted: 0,
  skippedUnconfirmed: 0,
};

export function getAttributionStatusEventsCounters(): AttributionStatusEventsCounters {
  return { ...counters };
}

/** 确定性主键派生。空 assetId 用 "" 占位（与 judgement repo 同姿势，见 R2 说明）。 */
export function deriveStatusId(unitId: string, assetId: string | null, round: number): string {
  const digest = createHash("sha1").update(`${unitId}|${assetId ?? ""}|${round}`, "utf8").digest("hex");
  return `se_${digest.slice(0, 12)}`;
}

/**
 * 不写路径的显式计数（F5）：worker 对 refuted / unconfirmed 调用；guard 违反单独计数。
 * 这些不是"写入"，只累计 counters —— 保持"写/不写都可观测"。
 */
export function noteStatusSkipped(verdict: "refuted" | "unconfirmed"): void {
  if (verdict === "refuted") counters.skippedRefuted += 1;
  else counters.skippedUnconfirmed += 1;
}

export function noteStatusGuardViolation(message: string): void {
  counters.guardViolations += 1;
  console.warn(`[attribution-status] guard violation (confirmed with null assetId): ${message}`);
}

export interface RollupRow {
  asset_id: string;
  /** asset_used 行数。 */
  used_count: number;
  /** 去重会话数（口径同 §3.5 信用分聚合：按 (asset_id, session_key) 去重）。 */
  session_count: number;
}

export interface AttributionStatusEventsRepo {
  insertIdempotent(event: NewStatusEvent): StatusEventInsertResult;
  getById(statusId: string): StatusEventRow | null;
  listByUnit(unitId: string, limit?: number): StatusEventRow[];
  listByAsset(assetId: string, opts?: { limit?: number; eventType?: string }): StatusEventRow[];
  /** 汇总 = 查询层（不物化）：per-asset used 行数 + 去重会话数，确定性排序。 */
  rollupByAsset(opts?: { eventType?: string }): RollupRow[];
  count(): number;
  /** 61 · 取最新轮（50 spec §16 C4；查询层，不物化）：`round DESC` 首行 + 主键 tie-break。 */
  latestByUnit(unitId: string): StatusEventRow | null;
}

/** 进程内**严格单调**的 created_at（同 judgement repo 姿势：消同毫秒重放误判）。 */
let lastCreatedAt = 0;

function nextCreatedAt(): number {
  lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
  return lastCreatedAt;
}

const DEFAULT_SPACE_ID = "_default";
const SELECT_COLUMNS = `status_id, unit_id, session_key, space_id, asset_id, asset_type, round,
  event_type, outcome, turn_seq, msg_seq, payload_json, created_at`;

class SqliteAttributionStatusEventsRepo implements AttributionStatusEventsRepo {
  private readonly insertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly byUnitStmt: Database.Statement;
  private readonly byAssetStmt: Database.Statement;
  private readonly byAssetTypeStmt: Database.Statement;
  private readonly rollupStmt: Database.Statement;
  private readonly rollupTypeStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly latestByUnitStmt: Database.Statement;

  constructor(db: Database.Database) {
    // 定向 upsert：冲突目标 = 主键 status_id（锚全等，无 anomaly 面）。
    // RETURNING created_at 是判别 inserted/duplicate 的唯一依据（同 judgement repo）。
    this.insertStmt = db.prepare(`
INSERT INTO attribution_status_events
  (status_id, unit_id, session_key, space_id, asset_id, asset_type, round, event_type, outcome,
   turn_seq, msg_seq, payload_json, created_at)
VALUES
  (@statusId, @unitId, @sessionKey, @spaceId, @assetId, @assetType, @round, @eventType, @outcome,
   NULL, NULL, @payloadJson, @createdAt)
ON CONFLICT(status_id) DO UPDATE SET event_type = excluded.event_type
RETURNING created_at
`);
    this.getStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM attribution_status_events WHERE status_id = ?`);
    this.byUnitStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM attribution_status_events WHERE unit_id = ? ORDER BY created_at ASC, status_id ASC LIMIT ?`,
    );
    this.byAssetStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM attribution_status_events WHERE asset_id = ? ORDER BY created_at ASC, status_id ASC LIMIT ?`,
    );
    this.byAssetTypeStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM attribution_status_events WHERE asset_id = ? AND event_type = ? ORDER BY created_at ASC, status_id ASC LIMIT ?`,
    );
    this.rollupStmt = db.prepare(
      `SELECT asset_id, COUNT(*) AS used_count, COUNT(DISTINCT session_key) AS session_count
       FROM attribution_status_events GROUP BY asset_id ORDER BY asset_id ASC`,
    );
    this.rollupTypeStmt = db.prepare(
      `SELECT asset_id, COUNT(*) AS used_count, COUNT(DISTINCT session_key) AS session_count
       FROM attribution_status_events WHERE event_type = ? GROUP BY asset_id ORDER BY asset_id ASC`,
    );
    this.countStmt = db.prepare("SELECT COUNT(*) AS n FROM attribution_status_events");
    this.latestByUnitStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM attribution_status_events WHERE unit_id = ? ORDER BY round DESC, status_id ASC LIMIT 1`,
    );
  }

  insertIdempotent(event: NewStatusEvent): StatusEventInsertResult {
    const round = Math.max(0, Math.trunc(event.round));
    const statusId = deriveStatusId(event.unitId, event.assetId, round);
    const createdAt = nextCreatedAt();
    try {
      const row = this.insertStmt.get({
        statusId,
        unitId: event.unitId,
        sessionKey: event.sessionKey,
        spaceId: event.spaceId && event.spaceId.trim().length > 0 ? event.spaceId.trim() : DEFAULT_SPACE_ID,
        assetId: event.assetId,
        assetType: event.assetType,
        round,
        eventType: STATUS_EVENT_TYPE_ASSET_USED,
        outcome: event.outcome,
        payloadJson: JSON.stringify(event.payload ?? {}),
        createdAt,
      }) as { created_at: number } | undefined;

      if (!row) {
        // 主键冲突的 DO UPDATE 必有 RETURNING；无返回行只可能是写异常路径（防御性归 failed）。
        counters.failures += 1;
        console.warn(`[attribution-status] status insert produced no row (${statusId})`);
        return { statusId, kind: "failed" };
      }
      if (row.created_at === createdAt) {
        counters.inserted += 1;
        return { statusId, kind: "inserted" };
      }
      counters.duplicate += 1;
      console.info(`[attribution-status] status idempotent skip (${statusId})`);
      return { statusId, kind: "duplicate" };
    } catch (err) {
      counters.failures += 1;
      console.warn(
        `[attribution-status] status insert failed (${statusId}):`,
        err instanceof Error ? err.message : String(err),
      );
      return { statusId, kind: "failed" };
    }
  }

  getById(statusId: string): StatusEventRow | null {
    try {
      return (this.getStmt.get(statusId) as StatusEventRow | undefined) ?? null;
    } catch {
      return null;
    }
  }

  listByUnit(unitId: string, limit = 1000): StatusEventRow[] {
    try {
      return (this.byUnitStmt.all(unitId, Math.max(1, Math.trunc(limit))) ?? []) as StatusEventRow[];
    } catch {
      return [];
    }
  }

  listByAsset(assetId: string, opts?: { limit?: number; eventType?: string }): StatusEventRow[] {
    try {
      const limit = Math.max(1, Math.trunc(opts?.limit ?? 1000));
      const rows = opts?.eventType
        ? (this.byAssetTypeStmt.all(assetId, opts.eventType, limit) ?? [])
        : (this.byAssetStmt.all(assetId, limit) ?? []);
      return rows as StatusEventRow[];
    } catch {
      return [];
    }
  }

  rollupByAsset(opts?: { eventType?: string }): RollupRow[] {
    try {
      const rows = opts?.eventType ? this.rollupTypeStmt.all(opts.eventType) : this.rollupStmt.all();
      return (rows ?? []) as RollupRow[];
    } catch {
      return [];
    }
  }

  count(): number {
    try {
      const row = this.countStmt.get() as { n: number } | undefined;
      return row ? Number(row.n) : 0;
    } catch {
      return 0;
    }
  }

  latestByUnit(unitId: string): StatusEventRow | null {
    try {
      return (this.latestByUnitStmt.get(unitId) as StatusEventRow | undefined) ?? null;
    } catch {
      return null;
    }
  }
}

class NullAttributionStatusEventsRepo implements AttributionStatusEventsRepo {
  insertIdempotent(event: NewStatusEvent): StatusEventInsertResult {
    // 无 DB ⇒ 一行都没落：既不是 inserted（不伪造成功），也不是 duplicate（库里并无该行），归 failed。
    return { statusId: deriveStatusId(event.unitId, event.assetId, event.round), kind: "failed" };
  }
  getById(): StatusEventRow | null {
    return null;
  }
  listByUnit(): StatusEventRow[] {
    return [];
  }
  listByAsset(): StatusEventRow[] {
    return [];
  }
  rollupByAsset(): RollupRow[] {
    return [];
  }
  count(): number {
    return 0;
  }
  latestByUnit(): StatusEventRow | null {
    return null;
  }
}

let _repo: AttributionStatusEventsRepo | null = null;

export function getAttributionStatusEventsRepo(): AttributionStatusEventsRepo {
  if (_repo) return _repo;
  const db = getDb();
  _repo = db ? new SqliteAttributionStatusEventsRepo(db) : new NullAttributionStatusEventsRepo();
  return _repo;
}

export function setAttributionStatusEventsRepo(repo: AttributionStatusEventsRepo): void {
  _repo = repo;
}

/** Reset singleton + counters — tests only. */
export function __resetAttributionStatusEventsRepoForTests(): void {
  _repo = null;
  counters.inserted = 0;
  counters.duplicate = 0;
  counters.failures = 0;
  counters.guardViolations = 0;
  counters.skippedRefuted = 0;
  counters.skippedUnconfirmed = 0;
  lastCreatedAt = 0;
}
