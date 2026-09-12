/**
 * AttributionJudgementDetailsRepo — 归因判定落点表（design §4.3）。
 *
 * **落点唯一性锚 = `(unit_id, round)`**（唯一索引 `idx_ajd_unit_round`）：
 *   同单元同轮只允许一行；同 `(unit_id, round)` 再来一条**不同 asset_id** ⇒ 判定异常 anomaly。
 *   确定性主键 `judgement_id = "jd_" + sha1(unit_id|asset_id|round).slice(0,12)` 保留不变。
 *
 * 幂等/异常判别由定向 upsert 承担（一条语句给出四态，不靠日志文案）：
 *   RETURNING 行.created_at === 本次传入值 ⇒ `inserted`；返回旧值 ⇒ `duplicate`；
 *   无返回行（WHERE 不匹配）⇒ `anomaly`；抛错 ⇒ `failed`。
 *
 * ⚠️ 明确**不**使用 `UNIQUE(unit_id, asset_id, round)` 当锚（R2）：`asset_id` 可空，
 * 而 SQLite 的 NULL 互不相等，未归因行（asset_id IS NULL）会无限重复插入 ——
 * 那会制造"看起来有唯一约束、其实对未归因无条件放行"的假安全。
 * 本仓的锚 `(unit_id, round)` **不含** asset_id ⇒ 未归因行同样被唯一性覆盖。
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

export type JudgementDetailInsertKind = "inserted" | "duplicate" | "anomaly" | "failed";

export interface InsertIdempotentResult {
  judgementId: string;
  /**
   * 四态判别（机器可读；调用方不得靠日志文案/last_error 区分）：
   *   inserted  — 本次新落一行
   *   duplicate — 同 (unit_id, round) 且同 asset 的重放（预期路径，info 级，不是失败）
   *   anomaly   — 同 (unit_id, round) 已被**另一个 asset** 占用（判定异常，不是重放）
   *   failed    — 写入异常/未点名约束冲突（例：sha1 截断后撞主键、DB 降级）
   */
  kind: JudgementDetailInsertKind;
}

export interface AttributionJudgementDetailsCounters {
  inserted: number;
  /** 重放（duplicate）计数。字段名沿用既有 `ignored`，A4 口径不变。 */
  ignored: number;
  /** 判定异常（anomaly）：同 (unit_id, round) 已被别的 asset 占用。 */
  anomaly: number;
  failures: number;
}

const counters: AttributionJudgementDetailsCounters = { inserted: 0, ignored: 0, anomaly: 0, failures: 0 };

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
  /** 61 · 取最新轮（50 spec §16 C4；查询层，不物化）：`round DESC` 首行 + 主键 tie-break。 */
  latestByUnit(unitId: string): JudgementDetailRow | null;
}

/**
 * 进程内**严格单调**的 created_at（毫秒）。
 *
 * 为什么不用裸 `Date.now()`：判别 inserted/duplicate 依据是"RETURNING 的 created_at 是否等于
 * 本次传入值"，而同一毫秒内的重放会与库里旧值相等 ⇒ 被误判成 inserted（只错一格计数，
 * 不造成静默丢数据；见 50 spec 的 known limitation）。这里保证每次调用严格递增以消掉该歧义。
 * ⚠️ 跨进程仍可能与别的时间戳相等（残留边界，已登记）。
 */
let lastCreatedAt = 0;

function nextCreatedAt(): number {
  lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
  return lastCreatedAt;
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
  private readonly latestByUnitStmt: Database.Statement;

  constructor(db: Database.Database) {
    // 定向 upsert：冲突目标 = 唯一索引 idx_ajd_unit_round 的 (unit_id, round)。
    // · WHERE 用 `IS`（不是 `=`）：asset_id 为 NULL 时也能正确判"同 asset"。
    // · WHERE 不匹配 ⇒ DO UPDATE 不执行 ⇒ 无返回行 ⇒ 调用方判为 anomaly。
    // · RETURNING created_at 是判别 inserted/duplicate 的**唯一**依据（不能用 changes：
    //   inserted 与 duplicate 的 changes 都是 1）。
    this.insertStmt = db.prepare(`
INSERT INTO attribution_judgement_details
  (judgement_id, unit_id, session_key, space_id, asset_id, asset_type, round, verdict,
   evidence_source_type, prompt_sha256, judge_impl, detail_json, created_at)
VALUES
  (@judgementId, @unitId, @sessionKey, @spaceId, @assetId, @assetType, @round, @verdict,
   @evidenceSourceType, @promptSha256, @judgeImpl, @detailJson, @createdAt)
ON CONFLICT(unit_id, round) DO UPDATE SET verdict = excluded.verdict
  WHERE attribution_judgement_details.asset_id IS excluded.asset_id
RETURNING created_at
`);
    this.getStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM attribution_judgement_details WHERE judgement_id = ?`);
    this.byUnitStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM attribution_judgement_details WHERE unit_id = ? ORDER BY created_at ASC, judgement_id ASC LIMIT ?`,
    );
    this.bySessionStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM attribution_judgement_details WHERE session_key = ? ORDER BY created_at ASC, judgement_id ASC LIMIT ?`,
    );
    this.countStmt = db.prepare("SELECT COUNT(*) AS n FROM attribution_judgement_details");
    this.latestByUnitStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM attribution_judgement_details WHERE unit_id = ? ORDER BY round DESC, judgement_id ASC LIMIT 1`,
    );
  }

  insertIdempotent(detail: NewJudgementDetail): InsertIdempotentResult {
    const round = Math.max(0, Math.trunc(detail.round));
    const judgementId = deriveJudgementId(detail.unitId, detail.assetId, round);
    // 时间戳单位 = 毫秒（硬约束）；单调递增，避免同毫秒重放被误判为 inserted。
    const createdAt = nextCreatedAt();
    try {
      const row = this.insertStmt.get({
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
        createdAt,
      }) as { created_at: number } | undefined;

      if (!row) {
        // 无返回行 = WHERE 不匹配 = 同 (unit_id, round) 已被**另一个 asset** 占用。
        counters.anomaly += 1;
        console.warn(
          `[attribution-judge] judgement detail anomaly — (unit_id, round) already held by a different asset (${judgementId})`,
        );
        return { judgementId, kind: "anomaly" };
      }
      if (row.created_at === createdAt) {
        counters.inserted += 1;
        return { judgementId, kind: "inserted" };
      }
      counters.ignored += 1;
      console.info(`[attribution-judge] judgement detail idempotent skip (${judgementId})`);
      return { judgementId, kind: "duplicate" };
    } catch (err) {
      counters.failures += 1;
      console.warn(
        `[attribution-judge] judgement detail insert failed (${judgementId}):`,
        err instanceof Error ? err.message : String(err),
      );
      return { judgementId, kind: "failed" };
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

  latestByUnit(unitId: string): JudgementDetailRow | null {
    try {
      return (this.latestByUnitStmt.get(unitId) as JudgementDetailRow | undefined) ?? null;
    } catch {
      return null;
    }
  }
}

class NullAttributionJudgementDetailsRepo implements AttributionJudgementDetailsRepo {
  insertIdempotent(detail: NewJudgementDetail): InsertIdempotentResult {
    // 无 DB ⇒ 一行都没落：既不是 inserted（不伪造成功），也不是 duplicate（库里并无该行），
    // 故归入 failed。对照见 db-degraded-singletons 矩阵 5/6。
    return { judgementId: deriveJudgementId(detail.unitId, detail.assetId, detail.round), kind: "failed" };
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
  latestByUnit(): JudgementDetailRow | null {
    return null;
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
  counters.anomaly = 0;
  counters.failures = 0;
  lastCreatedAt = 0;
}
