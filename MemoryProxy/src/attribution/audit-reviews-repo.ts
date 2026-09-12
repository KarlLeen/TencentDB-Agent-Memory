/**
 * 74 · S7-b 抽查状态写口 repo（**append-only**；70 spec §2.4）。
 *
 * - 幂等锚 = `review_id`（公式含 `prev_status` ⇒ 同一迁移重放 ⇒ duplicate；多次**真实迁移**
 *   各得其锚、天然防重放）；
 * - 冲突姿势照 `insertIdempotent`：定向 upsert `ON CONFLICT(review_id) DO UPDATE … RETURNING
 *   created_at` + 严格单调 `created_at`（判别 inserted / duplicate）；
 * - 状态**只服务审计**：本模块不写任何判定/状态事件行、不入队（硬边界，70 spec §2.4）。
 */
import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import { getDb } from "../db/index.js";

export const AUDIT_STATUSES = ["confirmed", "dismissed", "needs_fix"] as const;
export const AUDIT_PREV_STATUSES = ["unreviewed", "confirmed", "dismissed", "needs_fix"] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];
export type AuditPrevStatus = (typeof AUDIT_PREV_STATUSES)[number];

/** 状态迁移表（写死；其余 ⇒ 400。自迁移全禁）。 */
export const AUDIT_TRANSITIONS: Record<AuditPrevStatus, readonly AuditStatus[]> = {
  unreviewed: ["confirmed", "dismissed", "needs_fix"],
  confirmed: ["needs_fix", "dismissed"],
  dismissed: ["needs_fix"],
  needs_fix: ["confirmed", "dismissed"],
};

export interface AuditReviewRow {
  review_id: string;
  audit_key: string;
  status: string;
  prev_status: string;
  actor: string;
  note: string | null;
  created_at: number;
}

export interface NewAuditReview {
  auditKey: string;
  status: string;
  prevStatus: string;
  actor: string;
  note?: string | null;
}

export interface AuditReviewInsertResult {
  reviewId: string;
  kind: "inserted" | "duplicate" | "failed";
}

/** 幂等锚（公式照 70 spec §2.4；`.slice(0, 12)` 与全仓姿势一致）。 */
export function deriveReviewId(
  auditKey: string,
  prevStatus: string,
  status: string,
  actor: string,
): string {
  const sha = createHash("sha1").update(`${auditKey}|${prevStatus}|${status}|${actor}`, "utf8").digest("hex");
  return `ar_${sha.slice(0, 12)}`;
}

/** 写路径计数（inserted / duplicate / failures；同 status repo 姿势，让"不写"也可观测）。 */
export interface AuditReviewsCounters {
  inserted: number;
  duplicate: number;
  failures: number;
}
const counters: AuditReviewsCounters = { inserted: 0, duplicate: 0, failures: 0 };

export function getAttributionAuditReviewsCounters(): AuditReviewsCounters {
  return { ...counters };
}

export interface AttributionAuditReviewsRepo {
  insertIdempotent(review: NewAuditReview): AuditReviewInsertResult;
  getById(reviewId: string): AuditReviewRow | null;
  /** 读侧 latest（按 created_at, review_id 定序）。 */
  latestByAuditKey(auditKey: string): AuditReviewRow | null;
  count(): number;
}

/** 进程内**严格单调**的 created_at（同 status repo 姿势：消同毫秒重放误判）。 */
let lastCreatedAt = 0;
function nextCreatedAt(): number {
  lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
  return lastCreatedAt;
}

const SELECT_COLUMNS = "review_id, audit_key, status, prev_status, actor, note, created_at";

class SqliteAttributionAuditReviewsRepo implements AttributionAuditReviewsRepo {
  private readonly insertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly latestStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  constructor(db: Database.Database) {
    // 定向 upsert：冲突目标 = review_id（锚全等，无异常面）；RETURNING created_at 是
    // 判别 inserted/duplicate 的唯一依据（同 judgement/status repo 姿势）。
    this.insertStmt = db.prepare(`
INSERT INTO attribution_audit_reviews
  (review_id, audit_key, status, prev_status, actor, note, created_at)
VALUES
  (@reviewId, @auditKey, @status, @prevStatus, @actor, @note, @createdAt)
ON CONFLICT(review_id) DO UPDATE SET status = excluded.status
RETURNING created_at
`);
    this.getStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM attribution_audit_reviews WHERE review_id = ?`);
    this.latestStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM attribution_audit_reviews WHERE audit_key = ? ORDER BY created_at DESC, review_id DESC LIMIT 1`,
    );
    this.countStmt = db.prepare("SELECT COUNT(*) AS n FROM attribution_audit_reviews");
  }

  insertIdempotent(review: NewAuditReview): AuditReviewInsertResult {
    const reviewId = deriveReviewId(review.auditKey, review.prevStatus, review.status, review.actor);
    const createdAt = nextCreatedAt();
    try {
      const row = this.insertStmt.get({
        reviewId,
        auditKey: review.auditKey,
        status: review.status,
        prevStatus: review.prevStatus,
        actor: review.actor,
        note: review.note ?? null,
        createdAt,
      }) as { created_at: number } | undefined;
      if (row && Number(row.created_at) === createdAt) {
        counters.inserted += 1;
        return { reviewId, kind: "inserted" };
      }
      counters.duplicate += 1;
      return { reviewId, kind: "duplicate" };
    } catch (err) {
      counters.failures += 1;
      console.warn(
        `[attribution-audit] insert failed (audit_key=${review.auditKey}):`,
        err instanceof Error ? err.message : String(err),
      );
      return { reviewId, kind: "failed" };
    }
  }

  getById(reviewId: string): AuditReviewRow | null {
    try {
      return (this.getStmt.get(reviewId) as AuditReviewRow | undefined) ?? null;
    } catch {
      return null;
    }
  }

  latestByAuditKey(auditKey: string): AuditReviewRow | null {
    try {
      return (this.latestStmt.get(auditKey) as AuditReviewRow | undefined) ?? null;
    } catch {
      return null;
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

class NullAttributionAuditReviewsRepo implements AttributionAuditReviewsRepo {
  insertIdempotent(review: NewAuditReview): AuditReviewInsertResult {
    // 无 DB ⇒ 一行都没落：既不是 inserted（不伪造成功），也不是 duplicate，归 failed。
    return {
      reviewId: deriveReviewId(review.auditKey, review.prevStatus, review.status, review.actor),
      kind: "failed",
    };
  }
  getById(): AuditReviewRow | null {
    return null;
  }
  latestByAuditKey(): AuditReviewRow | null {
    return null;
  }
  count(): number {
    return 0;
  }
}

let _repo: AttributionAuditReviewsRepo | null = null;

export function getAttributionAuditReviewsRepo(): AttributionAuditReviewsRepo {
  if (_repo) return _repo;
  const db = getDb();
  _repo = db ? new SqliteAttributionAuditReviewsRepo(db) : new NullAttributionAuditReviewsRepo();
  return _repo;
}

/** Reset singleton + counters — tests only. */
export function __resetAttributionAuditReviewsRepoForTests(): void {
  _repo = null;
  lastCreatedAt = 0;
  counters.inserted = 0;
  counters.duplicate = 0;
  counters.failures = 0;
}
