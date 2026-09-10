/**
 * AttributionJudgementDetailsRepo — 归因判定落点表（design §4.3）。
 *
 * **幂等由确定性主键承担**（硬约束 / 红线 8）：
 *   `judgement_id = "jd_" + sha1(unit_id|asset_id|round).slice(0,12)`
 *   `INSERT OR IGNORE` 命中主键 ⇒ `ignored`（预期路径，info 级），不是失败。
 *
 * ⚠️ 明确**不**使用 `UNIQUE(unit_id, asset_id, round)` 当幂等锚（R2）：`asset_id` 可空，
 * 而 SQLite 的 NULL 互不相等，未归因行（asset_id IS NULL）会无限重复插入 ——
 * 那会制造"看起来有唯一约束、其实对未归因无条件放行"的假安全。
 */

import type Database from "better-sqlite3";

import { getDb } from "../db/index.js";
import type { JudgeEvidenceSourceType, JudgeVerdictKind } from "./judge/types.js";
import { createHash } from "node:crypto";

export interface NewJudgementDetail {
  unitId: string;
  sessionKey: string;
  spaceId?: string;
  /** null = 未归因。 */
  assetId: string | null;
  assetType: string | null;
  round: number;
  verdict: JudgeVerdictKind;
  evidenceSourceType: JudgeEvidenceSourceType | null;
  /** 来自 judge.promptRef.prompt_sha256；不知道就 null，别猜。 */
  promptSha256: string | null;
  /** 如 "mock:v1"。 */
  judgeImpl: string;
  /** 任意 JSON：写进 detail_json（**不改 DDL** 加字段，硬约束）。 */
  detail: unknown;
}

export interface JudgementDetailRow {
  judgement_id: string;
  unit_id: string;
  session_key: string;
  space_id: string;
  asset_id: string | null;
  asset_type: string | null;
  round: number;
  verdict: JudgeVerdictKind;
  evidence_source_type: JudgeEvidenceSourceType | null;
  prompt_sha256: string | null;
  judge_impl: string;
  detail_json: string;
  created_at: number;
}

export interface InsertIdempotentResult {
  judgementId: string;
  /** true = 新落一行；false = 主键已存在（重放 / 租约重复判定，预期路径）。 */
  inserted: boolean;
}

export interface AttributionJudgementDetailsCounters {
  inserted: number;
  ignored: number;
  failures: number;
}

const counters: AttributionJudgementDetailsCounters = { inserted: 0, ignored: 0, failures: 0 };

export function getAttributionJudgementDetailsCounters(): AttributionJudgementDetailsCounters {
  return { ...counters };
}

/** 确定性主键派生。空 assetId 用 "" 占位（与 null 同形，见 R2 说明）。 */
export function deriveJudgementId(unitId: string, assetId: string | null, round: number): string {
  const digest = createHash("sha1").update(`${unitId}|${assetId ?? ""}|${round}`, "utf8").digest("hex");
  return `jd_${digest.slice(0, 12)}`;
}

export interface AttributionJudgementDetailsRepo {
  insertIdempotent(detail: NewJudgementDetail): InsertIdempotentResult;
  getById(judgementId: string): JudgementDetailRow | null;
  listByUnit(unitId: string, limit?: number): JudgementDetailRow[];
  listBySession(sessionKey: string, limit?: number): JudgementDetailRow[];
  count(): number;
}

const DEFAULT_SPACE_ID = "_default";
const SELECT_COLUMNS = `judgement_id, unit_id, session_key, space_id, asset_id, asset_type, round,
  verdict, evidence_source_type, prompt_sha256, judge_impl, detail_json, created_at`;

class SqliteAttributionJudgementDetailsRepo implements AttributionJudgementDetailsRepo {
  private readonly insertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly byUnitStmt: Database.Statement;
  private readonly bySessionStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(`
INSERT OR IGNORE INTO attribution_judgement_details
  (judgement_id, unit_id, session_key, space_id, asset_id, asset_type, round, verdict,
   evidence_source_type, prompt_sha256, judge_impl, detail_json, created_at)
VALUES
  (@judgementId, @unitId, @sessionKey, @spaceId, @assetId, @assetType, @round, @verdict,
   @evidenceSourceType, @promptSha256, @judgeImpl, @detailJson, @createdAt)
`);
    this.getStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM attribution_judgement_details WHERE judgement_id = ?`);
    this.byUnitStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM attribution_judgement_details WHERE unit_id = ? ORDER BY created_at ASC, judgement_id ASC LIMIT ?`,
    );
    this.bySessionStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM attribution_judgement_details WHERE session_key = ? ORDER BY created_at ASC, judgement_id ASC LIMIT ?`,
    );
    this.countStmt = db.prepare("SELECT COUNT(*) AS n FROM attribution_judgement_details");
  }

  insertIdempotent(detail: NewJudgementDetail): InsertIdempotentResult {
    const round = Math.max(0, Math.trunc(detail.round));
    const judgementId = deriveJudgementId(detail.unitId, detail.assetId, round);
    try {
      const res = this.insertStmt.run({
        judgementId,
        unitId: detail.unitId,
        sessionKey: detail.sessionKey,
        spaceId: detail.spaceId && detail.spaceId.trim().length > 0 ? detail.spaceId.trim() : DEFAULT_SPACE_ID,
        assetId: detail.assetId,
        assetType: detail.assetType,
        round,
        verdict: detail.verdict,
        evidenceSourceType: detail.evidenceSourceType,
        promptSha256: detail.promptSha256,
        judgeImpl: detail.judgeImpl,
        detailJson: JSON.stringify(detail.detail ?? {}),
        // 时间戳单位 = 毫秒（硬约束）。
        createdAt: Date.now(),
      });
      if (res.changes === 1) {
        counters.inserted += 1;
        return { judgementId, inserted: true };
      }
      counters.ignored += 1;
      console.info(`[attribution-judge] judgement detail idempotent skip (${judgementId})`);
      return { judgementId, inserted: false };
    } catch (err) {
      counters.failures += 1;
      console.warn(
        `[attribution-judge] judgement detail insert failed (${judgementId}):`,
        err instanceof Error ? err.message : String(err),
      );
      return { judgementId, inserted: false };
    }
  }

  getById(judgementId: string): JudgementDetailRow | null {
    try {
      return (this.getStmt.get(judgementId) as JudgementDetailRow | undefined) ?? null;
    } catch {
      return null;
    }
  }

  listByUnit(unitId: string, limit = 1000): JudgementDetailRow[] {
    try {
      return (this.byUnitStmt.all(unitId, Math.max(1, Math.trunc(limit))) ?? []) as JudgementDetailRow[];
    } catch {
      return [];
    }
  }

  listBySession(sessionKey: string, limit = 1000): JudgementDetailRow[] {
    try {
      return (this.bySessionStmt.all(sessionKey, Math.max(1, Math.trunc(limit))) ?? []) as JudgementDetailRow[];
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
}

class NullAttributionJudgementDetailsRepo implements AttributionJudgementDetailsRepo {
  insertIdempotent(detail: NewJudgementDetail): InsertIdempotentResult {
    return { judgementId: deriveJudgementId(detail.unitId, detail.assetId, detail.round), inserted: false };
  }
  getById(): JudgementDetailRow | null {
    return null;
  }
  listByUnit(): JudgementDetailRow[] {
    return [];
  }
  listBySession(): JudgementDetailRow[] {
    return [];
  }
  count(): number {
    return 0;
  }
}

let _repo: AttributionJudgementDetailsRepo | null = null;

export function getAttributionJudgementDetailsRepo(): AttributionJudgementDetailsRepo {
  if (_repo) return _repo;
  const db = getDb();
  _repo = db ? new SqliteAttributionJudgementDetailsRepo(db) : new NullAttributionJudgementDetailsRepo();
  return _repo;
}

export function setAttributionJudgementDetailsRepo(repo: AttributionJudgementDetailsRepo): void {
  _repo = repo;
}

/** Reset singleton + counters — tests only. */
export function __resetAttributionJudgementDetailsRepoForTests(): void {
  _repo = null;
  counters.inserted = 0;
  counters.ignored = 0;
  counters.failures = 0;
}
