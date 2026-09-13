/**
 * AttributionJudgeQueueRepo — 共享基座（v2 前置骨架）判队列的持久层。
 * docs/implementation/attribution-base-design.md §4.1（DDL）/ §4.2（CAS 认领与状态机）。
 *
 * 状态机：`pending → processing → done | failed`；`processing` 租约过期 ⇒ 可被再认领。
 * `failed` 是**死信**：不再被自动认领，只能由 `--retry-failed`（retryFailed()）显式复位。
 *
 * 失败语义与 v1 repo 同源（attributionEventRepo / visibleTextRepo）：
 *   - 任何 DB 错误静默降级，绝不 throw 到调用方；
 *   - 入队唯一键 (unit_id, round) 冲突 = **预期路径**（重放/重复触发），info 级；
 *   - 真实失败才 warn，并进 counters.failures（R1「假绿」的反面：退化必须可见）。
 *
 * 命名：本文件属 `src/attribution/`（v2 基座），与既有 CostGuard 的 `src/judge-client.ts`
 * 无关（design F23）⇒ 导出一律带 attribution / judge-queue 语义前缀，勿简写作 `JudgeQueue`。
 */

import type Database from "better-sqlite3";

import { getDb } from "../db/index.js";

// ── 行 / 输入形状 ────────────────────────────────────────────────────────────────

export type JudgeQueueStatus = "pending" | "processing" | "done" | "failed";

/** 入队输入。payload 自足：worker 只读队列行，不回查 v1 事件表（§4.1）。 */
export interface JudgeQueueItemInput {
  unitId: string;
  sessionKey: string;
  /** 0=首次；>0=重判（61 起已生产：`--rejudge` ⇒ `manual` + `round+1`，见 50 spec §16）。缺省 0。 */
  round?: number;
  /** 缺省 "_default"（与 sessionRowId / v1 事件表口径一致）。 */
  spaceId?: string;
  /** 三值均在生产（50 spec §16.3）：decision_unit（首判缺省）/ manual（--rejudge）/ task_boundary（66 起：runner 边界信号）。 */
  trigger?: string;
  payload: unknown;
}

/** 持久化行，snake_case 列原样返回（payload_json 由调用方解析）。 */
export interface JudgeQueueRow {
  queue_id: number;
  unit_id: string;
  round: number;
  session_key: string;
  space_id: string;
  trigger: string;
  payload_json: string;
  status: JudgeQueueStatus;
  attempts: number;
  lease_owner: string | null;
  lease_expires_ms: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface ClaimOptions {
  /** 租约持有者标识（进程/实例名）。 */
  owner: string;
  /** 单轮认领上限。注意这不是"并发"：better-sqlite3 同步，串行逐条消费（§0）。 */
  batchSize: number;
  /** 租约时长 ms（缺省对齐 pipeline-worker lockTtlMs）。 */
  leaseTtlMs: number;
  /** 测试可注入"当前时刻"（epoch ms）。缺省 Date.now()。 */
  now?: number;
  /**
   * 本轮**排除**的 queue_id（--once 抽干模式用）。
   *
   * 为什么需要：失败的行会回到 `pending`，抽干循环下一轮立刻又选中它 ⇒ attempts 被
   * 连续 +1 直到死信，"退避"完全失效（一条坏行一次 `--once` 就烧完 maxAttempts）。
   * 排除必须发生在 **CAS 之前**：若先 UPDATE 再丢弃，attempts 已被无意义地 +1。
   *
   * 语义边界：排除在 SQL 的 LIMIT 之后应用 ⇒ 排除较多时单批可能不满 batchSize（抽干循环会补）。
   */
  excludeQueueIds?: ReadonlySet<number>;
}

export interface FailOptions {
  /** 达此值进 failed（死信）；未达则回 pending 等下轮（§4.2）。 */
  maxAttempts: number;
  now?: number;
}

// ── counters（观测：让"预期去重"与"真实失败"可区分；F10 姿势）─────────────────────

export interface AttributionJudgeQueueCounters {
  enqueued: number;
  /** (unit_id, round) 命中唯一键 = 预期路径（重放 / 重复触发）。 */
  dedupeConflicts: number;
  claimed: number;
  completed: number;
  /** 进死信的次数（attempts >= maxAttempts）。 */
  deadLettered: number;
  /** 失败但未达上限（回 pending 退避）。 */
  requeued: number;
  /** --retry-failed 复位行数。 */
  retried: number;
  failures: number;
}

const counters: AttributionJudgeQueueCounters = {
  enqueued: 0,
  dedupeConflicts: 0,
  claimed: 0,
  completed: 0,
  deadLettered: 0,
  requeued: 0,
  retried: 0,
  failures: 0,
};

export function getAttributionJudgeQueueCounters(): AttributionJudgeQueueCounters {
  return { ...counters };
}

// ── 接口 ─────────────────────────────────────────────────────────────────────────

export interface AttributionJudgeQueueRepo {
  /** 入队。返回 true = 新插入；false = (unit_id, round) 已存在（幂等命中，非错误）。 */
  enqueue(item: JudgeQueueItemInput): boolean;
  /**
   * 单事务内"选候选 + 逐条 CAS 抢占"。只返回**真正抢到**的行（changes()==1）；
   * 被别的 owner 抢走的行静默跳过（不算失败）。
   */
  claimBatch(opts: ClaimOptions): JudgeQueueRow[];
  /** 带 lease_owner 条件完成 ⇒ 租约被抢走后不会被我误标（§4.2）。 */
  complete(queueId: number, owner: string, now?: number): boolean;
  /**
   * 消费失败：attempts 已达 maxAttempts ⇒ status='failed'（死信）并记 last_error；
   * 否则回 'pending' 等下轮退避。返回落到的状态；未持有租约（changes()==0）返回 null。
   */
  fail(queueId: number, owner: string, error: string, opts: FailOptions): "pending" | "failed" | null;
  /** 死信复位（等价 `--retry-failed` 的 SQL 版，checklist §3 档位 3）。返回复位行数。 */
  retryFailed(now?: number): number;
  get(queueId: number): JudgeQueueRow | null;
  listByStatus(status: JudgeQueueStatus, limit?: number): JudgeQueueRow[];
  countByStatus(): Record<string, number>;
  /** 61 · 该 unit 的最新轮（queue 为权威轮次账本；`round DESC` 首行）。 */
  latestByUnit(unitId: string): JudgeQueueRow | null;
  /**
   * 119 · A′：会话枚举（只读；确定性排序；`created_at >= sinceMs`，缺省 0 = 全量）。
   * DB 降级 ⇒ 空数组（**静默降级 = 可见性少而不报错**；同 events 仓姿势）。
   */
  distinctSessionKeys(sinceMs?: number): string[];
  /**
   * 119 · A′：按会话列行（`created_at ASC, queue_id ASC` 全序）。
   * 供 sessions 端点的 **space 派生（首行）** 与 **时间兜底**（F11）。
   */
  listBySession(sessionKey: string, opts?: { limit?: number }): JudgeQueueRow[];
}

const DEFAULT_SPACE_ID = "_default";

// ── 61 · trigger 枚举（50 spec §16 C3 穷举；未来值 = 常量 + 联合类型 + §16.3 表格同行）──────
/** 首判（缺省；行为不变）。 */
export const TRIGGER_DECISION_UNIT = "decision_unit";
/** 人工重判（61 开始生产；`--rejudge`）。 */
export const TRIGGER_MANUAL = "manual";
/** **66 起已由生产路径产出**（runner 观测到 compaction/epoch 切换时随批下发；122 · F2 更正：
 *  旧注释"只登记枚举值，生产路径禁产（A7 留给 S6）"已过期）。 */
export const TRIGGER_TASK_BOUNDARY = "task_boundary";
export type JudgeTrigger = typeof TRIGGER_DECISION_UNIT | typeof TRIGGER_MANUAL | typeof TRIGGER_TASK_BOUNDARY;

const DEFAULT_TRIGGER = TRIGGER_DECISION_UNIT;
/** SQLite 默认变量上限 999；调用方 batchSize 远小于此，这里只做兜底防御。 */
const MAX_BATCH_SIZE = 500;

const SELECT_COLUMNS = `queue_id, unit_id, round, session_key, space_id, trigger, payload_json,
  status, attempts, lease_owner, lease_expires_ms, last_error, created_at, updated_at`;

function spaceIdOf(spaceId: string | undefined): string {
  return spaceId && spaceId.trim().length > 0 ? spaceId.trim() : DEFAULT_SPACE_ID;
}

/**
 * CAS 认领的**唯一**判定式 —— 选候选与抢占必须同式，否则会出现
 * "选中了却在 UPDATE 时抢不到"的静默空转（`changes()==0`）。抽成常量的意义是
 * 让两条 SQL 不可能漂移。
 */
const CLAIMABLE_PREDICATE = `(status = 'pending' OR (status = 'processing' AND lease_expires_ms IS NOT NULL AND lease_expires_ms < @now))`;

class SqliteAttributionJudgeQueueRepo implements AttributionJudgeQueueRepo {
  private readonly enqueueStmt: Database.Statement;
  private readonly selectCandidatesStmt: Database.Statement;
  private readonly claimStmt: Database.Statement;
  private readonly completeStmt: Database.Statement;
  private readonly failStmt: Database.Statement;
  private readonly retryFailedStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly byStatusStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly latestByUnitStmt: Database.Statement;
  // 119 · A′：可见性来源（会话枚举 + 按会话列行）。
  private readonly distinctSessionsStmt: Database.Statement;
  private readonly bySessionStmt: Database.Statement;
  private readonly claimBatchTx: (items: Array<{ id: number; owner: string; leaseExpires: number; now: number }>) => number[];

  constructor(private readonly db: Database.Database) {
    this.enqueueStmt = db.prepare(`
INSERT OR IGNORE INTO attribution_judge_queue
  (unit_id, round, session_key, space_id, trigger, payload_json, status, attempts, created_at, updated_at)
VALUES
  (@unitId, @round, @sessionKey, @spaceId, @trigger, @payloadJson, 'pending', 0, @now, @now)
`);
    this.selectCandidatesStmt = db.prepare(`
SELECT queue_id FROM attribution_judge_queue
 WHERE ${CLAIMABLE_PREDICATE}
 ORDER BY queue_id ASC
 LIMIT @batchSize
`);
    this.claimStmt = db.prepare(`
UPDATE attribution_judge_queue
   SET status = 'processing',
       lease_owner = @owner,
       lease_expires_ms = @leaseExpires,
       attempts = attempts + 1,
       updated_at = @now
 WHERE queue_id = @id
   AND ${CLAIMABLE_PREDICATE}
`);
    this.completeStmt = db.prepare(`
UPDATE attribution_judge_queue
   SET status = 'done', last_error = NULL, lease_owner = NULL, lease_expires_ms = NULL, updated_at = @now
 WHERE queue_id = @id AND lease_owner = @owner AND status = 'processing'
`);
    this.failStmt = db.prepare(`
UPDATE attribution_judge_queue
   SET status = @next, last_error = @error, lease_owner = NULL, lease_expires_ms = NULL, updated_at = @now
 WHERE queue_id = @id AND lease_owner = @owner AND status = 'processing'
`);
    this.retryFailedStmt = db.prepare(`
UPDATE attribution_judge_queue
   SET status = 'pending', attempts = 0, last_error = NULL, lease_owner = NULL, lease_expires_ms = NULL,
       updated_at = @now
 WHERE status = 'failed'
`);
    this.getStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM attribution_judge_queue WHERE queue_id = ?`);
    this.byStatusStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM attribution_judge_queue WHERE status = ? ORDER BY queue_id ASC LIMIT ?`,
    );
    this.countStmt = db.prepare("SELECT status, COUNT(*) AS n FROM attribution_judge_queue GROUP BY status");
    // 61 · 权威轮次账本读取（重判入口用；tie-break 用 queue_id 保证排序全序稳定）。
    this.latestByUnitStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM attribution_judge_queue WHERE unit_id = ? ORDER BY round DESC, queue_id ASC LIMIT 1`,
    );
    // 119 · A′：可见性来源（会话枚举 + 按会话列行；确定性排序）。
    this.distinctSessionsStmt = db.prepare(
      "SELECT DISTINCT session_key FROM attribution_judge_queue WHERE session_key != '' AND created_at >= ? ORDER BY session_key ASC",
    );
    this.bySessionStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM attribution_judge_queue WHERE session_key = ? ORDER BY created_at ASC, queue_id ASC LIMIT ?`,
    );

    // 认领必须在一个事务里（§4.2；照 attributionEventRepo.appendMany 的 F6 姿势）：
    // 选候选与逐条 CAS 之间不能被别的连接插入新行，否则游标语义漂移。
    this.claimBatchTx = db.transaction(
      (items: Array<{ id: number; owner: string; leaseExpires: number; now: number }>) => {
        const claimed: number[] = [];
        for (const it of items) {
          const res = this.claimStmt.run({
            id: it.id,
            owner: it.owner,
            leaseExpires: it.leaseExpires,
            now: it.now,
          });
          // changes()==1 才算抢到；==0 = 已被别的 owner 抢走（正常竞争，不算失败）。
          if (res.changes === 1) claimed.push(it.id);
        }
        return claimed;
      },
    );
  }

  enqueue(item: JudgeQueueItemInput): boolean {
    try {
      const now = Date.now();
      const res = this.enqueueStmt.run({
        unitId: item.unitId,
        round: Math.max(0, Math.trunc(item.round ?? 0)),
        sessionKey: item.sessionKey,
        spaceId: spaceIdOf(item.spaceId),
        trigger: item.trigger && item.trigger.trim().length > 0 ? item.trigger.trim() : DEFAULT_TRIGGER,
        payloadJson: JSON.stringify(item.payload ?? {}),
        now,
      });
      if (res.changes === 1) {
        counters.enqueued += 1;
        return true;
      }
      // INSERT OR IGNORE 命中 idx_ajq_dedupe ⇒ 同单元同轮已入队：预期路径（非错误）。
      counters.dedupeConflicts += 1;
      console.info(`[attribution-judge] enqueue skipped dedupe conflict (unit=${item.unitId} round=${item.round ?? 0})`);
      return false;
    } catch (err) {
      counters.failures += 1;
      console.warn(
        `[attribution-judge] enqueue failed (unit=${item.unitId} session=${item.sessionKey}):`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }

  claimBatch(opts: ClaimOptions): JudgeQueueRow[] {
    try {
      const now = opts.now ?? Date.now();
      const batchSize = Math.min(MAX_BATCH_SIZE, Math.max(1, Math.trunc(opts.batchSize)));
      const candidates = (this.selectCandidatesStmt.all({ now, batchSize }) ?? []) as Array<{ queue_id: number }>;
      if (candidates.length === 0) return [];

      // 排除集在 CAS **之前**生效：不进事务的就不该被 bump attempts。
      const exclude = opts.excludeQueueIds;
      const candidateIds = candidates
        .map((c) => Number(c.queue_id))
        .filter((id) => !(exclude && exclude.has(id)));
      if (candidateIds.length === 0) return [];

      const leaseExpires = now + Math.max(1, Math.trunc(opts.leaseTtlMs));
      const claimedIds = this.claimBatchTx(
        candidateIds.map((id) => ({ id, owner: opts.owner, leaseExpires, now })),
      );
      counters.claimed += claimedIds.length;
      if (claimedIds.length === 0) return [];

      const rows: JudgeQueueRow[] = [];
      for (const id of claimedIds) {
        const row = this.get(id);
        if (row) rows.push(row);
      }
      return rows;
    } catch (err) {
      counters.failures += 1;
      console.warn(
        "[attribution-judge] claimBatch failed:",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  complete(queueId: number, owner: string, now?: number): boolean {
    try {
      const res = this.completeStmt.run({ id: queueId, owner, now: now ?? Date.now() });
      if (res.changes === 1) {
        counters.completed += 1;
        return true;
      }
      // 租约已被抢走（别人标过 done）或 status 已不是 processing：幂等场景，不算失败。
      return false;
    } catch (err) {
      counters.failures += 1;
      console.warn("[attribution-judge] complete failed:", err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  fail(queueId: number, owner: string, error: string, opts: FailOptions): "pending" | "failed" | null {
    try {
      const row = this.get(queueId);
      if (!row || row.lease_owner !== owner || row.status !== "processing") return null;
      // attempts 已在认领时 +1 ⇒ 达上限即死信（"第 maxAttempts 次失败"进 failed）。
      const next: "pending" | "failed" = row.attempts >= opts.maxAttempts ? "failed" : "pending";
      const res = this.failStmt.run({
        id: queueId,
        owner,
        error: error.slice(0, 2000),
        next,
        now: opts.now ?? Date.now(),
      });
      if (res.changes !== 1) return null;
      if (next === "failed") counters.deadLettered += 1;
      else counters.requeued += 1;
      return next;
    } catch (err) {
      counters.failures += 1;
      console.warn("[attribution-judge] fail() failed:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  retryFailed(now?: number): number {
    try {
      const res = this.retryFailedStmt.run({ now: now ?? Date.now() });
      const n = res.changes ?? 0;
      counters.retried += n;
      return n;
    } catch (err) {
      counters.failures += 1;
      console.warn("[attribution-judge] retryFailed failed:", err instanceof Error ? err.message : String(err));
      return 0;
    }
  }

  get(queueId: number): JudgeQueueRow | null {
    try {
      return (this.getStmt.get(queueId) as JudgeQueueRow | undefined) ?? null;
    } catch {
      return null;
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

  listBySession(sessionKey: string, opts: { limit?: number } = {}): JudgeQueueRow[] {
    try {
      const limit = Number.isInteger(opts.limit) && (opts.limit as number) > 0 ? (opts.limit as number) : 1000;
      return (this.bySessionStmt.all(sessionKey, limit) ?? []) as JudgeQueueRow[];
    } catch {
      return [];
    }
  }

  listByStatus(status: JudgeQueueStatus, limit = 1000): JudgeQueueRow[] {
    try {
      const n = Math.max(1, Math.trunc(limit));
      return (this.byStatusStmt.all(status, n) ?? []) as JudgeQueueRow[];
    } catch {
      return [];
    }
  }

  countByStatus(): Record<string, number> {
    try {
      const rows = (this.countStmt.all() ?? []) as Array<{ status: string; n: number }>;
      const out: Record<string, number> = {};
      for (const r of rows) out[r.status] = Number(r.n);
      return out;
    } catch {
      return {};
    }
  }

  latestByUnit(unitId: string): JudgeQueueRow | null {
    try {
      return (this.latestByUnitStmt.get(unitId) as JudgeQueueRow | undefined) ?? null;
    } catch {
      return null;
    }
  }
}

/** DB 不可用（getDb() → null，F1）时的降级实现：一切静默 no-op / 空结果。 */
export class NullAttributionJudgeQueueRepo implements AttributionJudgeQueueRepo {
  enqueue(): boolean {
    return false;
  }
  claimBatch(): JudgeQueueRow[] {
    return [];
  }
  complete(): boolean {
    return false;
  }
  fail(): "pending" | "failed" | null {
    return null;
  }
  retryFailed(): number {
    return 0;
  }
  get(): JudgeQueueRow | null {
    return null;
  }
  listByStatus(): JudgeQueueRow[] {
    return [];
  }
  countByStatus(): Record<string, number> {
    return {};
  }
  latestByUnit(): JudgeQueueRow | null {
    return null;
  }
  distinctSessionKeys(): string[] {
    return [];
  }
  listBySession(): JudgeQueueRow[] {
    return [];
  }
}

let _repo: AttributionJudgeQueueRepo | null = null;

export function getAttributionJudgeQueueRepo(): AttributionJudgeQueueRepo {
  if (_repo) return _repo;
  const db = getDb();
  _repo = db ? new SqliteAttributionJudgeQueueRepo(db) : new NullAttributionJudgeQueueRepo();
  return _repo;
}

/** Replace the singleton (e.g. tests with an in-memory / alternate backend). */
export function setAttributionJudgeQueueRepo(repo: AttributionJudgeQueueRepo): void {
  _repo = repo;
}

/** Reset singleton + counters — tests only. */
export function __resetAttributionJudgeQueueRepoForTests(): void {
  _repo = null;
  counters.enqueued = 0;
  counters.dedupeConflicts = 0;
  counters.claimed = 0;
  counters.completed = 0;
  counters.deadLettered = 0;
  counters.requeued = 0;
  counters.retried = 0;
  counters.failures = 0;
}
