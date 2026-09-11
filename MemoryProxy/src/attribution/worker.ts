/**
 * 独立 judge worker 进程（design §4.6 / §4.7）。
 *
 * 用法：
 *   npm run worker:attribution -- [--config config.yaml] [--once] [--retry-failed]
 *
 *   `--once`         消费一轮（把当前可认领积压**抽干**）后退出 —— 冒烟脚本靠它拿到确定性终止。
 *   `--retry-failed` 先把死信（status='failed'）复位成 pending，再开始消费。
 *   缺省              常驻轮询；SIGINT/SIGTERM 优雅退出（不吞当前这条，退出码 0）。
 *
 * 与 proxy 同库（F2/F20）：worker 是**第二个连接**，靠 WAL + busy_timeout=2000 退避
 * （db/index.ts:87 已在 getDb 里设好）。同一单元被重复判定由**确定性主键**兜底（红线 8），
 * 不靠"不会并发"这种假设。
 *
 * 为什么独立进程（不是 setInterval）：judge 将来是网络调用（真 provider），
 * 必须可重启、可观测、可单独限流。基座期就用最终形态，避免 50 spec 时重写调度。
 */

import { pathToFileURL } from "node:url";

import { buildConfig } from "../config.js";
import { getDb } from "../db/index.js";
import { getAttributionEventRepo } from "../db/attributionEventRepo.js";
import {
  createEvidenceSupplyProvider,
  extractVisibleAssetCandidates,
  type EvidenceSupplyProvider,
} from "./evidence-supply.js";
import { createJudge, type CreateJudgeDeps } from "./judge/create-judge.js";
import type { Judge, JudgeCandidate, JudgeInput } from "./judge/types.js";
import {
  __resetAttributionJudgeLoggerForTests,
  getAttributionJudgeLogFilePath,
  initAttributionJudgeLogger,
  resolveAttributionJudgeLogDir,
  shutdownAttributionJudgeLogger,
  writeAttributionJudgeLog,
} from "./judge-log.js";
import {
  getAttributionJudgeQueueRepo,
  type AttributionJudgeQueueRepo,
  type JudgeQueueRow,
} from "./judge-queue-repo.js";
import {
  getAttributionJudgementDetailsRepo,
  type AttributionJudgementDetailsRepo,
} from "./judgement-details-repo.js";

// ── 可注入依赖（单测用 fake，生产走真库）─────────────────────────────────────────

export interface AttributionWorkerDeps {
  queueRepo: AttributionJudgeQueueRepo;
  detailsRepo: AttributionJudgementDetailsRepo;
  judge: Judge;
  /** 租约持有者标识，落 lease_owner。 */
  owner: string;
  batchSize: number;
  leaseTtlMs: number;
  maxAttempts: number;
  /** 空转轮询间隔 ms。 */
  pollIntervalMs: number;
  /** 消费失败后的真实退避 ms（F18：退避要真做，不是留空）。 */
  backoffMs: number;
  /** 测试用：注入时钟 / sleep。 */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 测试用：日志落点。缺省写 attribution-judge.log。 */
  emitLog?: (record: Parameters<typeof writeAttributionJudgeLog>[0]) => void;
  /**
   * 56 · 证据供给 provider（50 spec §11）：候选组装换调它（fetched + injected 两路）。
   * 缺省 ⇒ 回退旧路径 `extractJudgeCandidates`（只搬 visibleAssets 快照）—— 单测兼容；
   * 生产 `buildWorkerDeps` 总装真 provider。
   */
  evidenceSupply?: EvidenceSupplyProvider;
}

export interface AttributionWorkerCycleResult {
  claimed: number;
  completed: number;
  /** 幂等命中（明细已存在）——成功路径的一个分支，不算失败。 */
  idempotent: number;
  /** 判定异常：同 (unit_id, round) 已被**另一个 asset** 占用。与 errored 分开计。 */
  anomaly: number;
  /** 消费抛错（judge 抛错，或落库返回 failed / 抛错）。 */
  errored: number;
  deadLettered: number;
  requeued: number;
  /** 落库成功但 complete() 没抢到（租约易主）——观测用异常信号。 */
  leaseLost: number;
}

function emptyCycleResult(): AttributionWorkerCycleResult {
  return {
    claimed: 0,
    completed: 0,
    idempotent: 0,
    anomaly: 0,
    errored: 0,
    deadLettered: 0,
    requeued: 0,
    leaseLost: 0,
  };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 容错解析队列 payload（坏 JSON 不该让整轮挂掉）。56 起扩解 `turnSeq`（单元轮次，§11 C1）。 */
function safeParsePayload(payloadJson: string): { kind: string; payload: unknown; turnSeq: number | null } {
  try {
    const parsed = JSON.parse(payloadJson) as { kind?: unknown; payload?: unknown; turnSeq?: unknown };
    return {
      kind: typeof parsed?.kind === "string" ? parsed.kind : "unknown",
      payload: parsed?.payload,
      turnSeq: typeof parsed?.turnSeq === "number" ? parsed.turnSeq : null,
    };
  } catch {
    return { kind: "unknown", payload: undefined, turnSeq: null };
  }
}

/**
 * 候选抽取（旧路径 fallback）：**只搬运 v1 已落库的 visibleAssets 快照**（A2），不在这里做筛选/推断。
 * 搬运逻辑单份在 `evidence-supply.ts` 的 `extractVisibleAssetCandidates`（不许第二份）；
 * 真实两路供给（fetched + injected）见 `EvidenceSupplyProvider`（50 spec §11）。
 */
export function extractJudgeCandidates(unitPayload: unknown): JudgeCandidate[] {
  if (!unitPayload || typeof unitPayload !== "object") return [];
  return extractVisibleAssetCandidates((unitPayload as { visibleAssets?: unknown }).visibleAssets);
}

/** 消费一行：judge → 幂等落库 → complete/fail → 一行引用式日志。 */
async function consumeRow(
  row: JudgeQueueRow,
  deps: AttributionWorkerDeps,
  result: AttributionWorkerCycleResult,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const emit = deps.emitLog ?? writeAttributionJudgeLog;
  const started = now();
  const { kind, payload, turnSeq } = safeParsePayload(row.payload_json);

  // 56 · 候选组装换调证据 provider（50 spec §11；缺省回退旧路径，见 deps 注释）。
  const supply = deps.evidenceSupply?.supply({
    sessionKey: row.session_key,
    turnSeq,
    visibleAssets:
      payload && typeof payload === "object"
        ? (payload as { visibleAssets?: unknown }).visibleAssets
        : undefined,
  });

  const input: JudgeInput = {
    unitId: row.unit_id,
    sessionKey: row.session_key,
    round: row.round,
    unit: { kind, payload },
    candidates: supply ? supply.candidates : extractJudgeCandidates(payload),
    promptRef: deps.judge.promptRef,
  };

  /** 失败收束：fail() → 分桶 → error 日志 → 退避。catch 与"落库明确说没落成"共用同一条路径。 */
  const failAndReport = async (message: string): Promise<void> => {
    const next = deps.queueRepo.fail(row.queue_id, deps.owner, message, {
      maxAttempts: deps.maxAttempts,
      now: now(),
    });
    if (next === "failed") result.deadLettered += 1;
    else if (next === "pending") result.requeued += 1;

    emit({
      status: "error",
      promptRef: deps.judge.promptRef,
      inputRefs: [{ unit_id: row.unit_id, queue_id: row.queue_id }],
      outputRefs: [],
      latencyMs: now() - started,
      judgeImpl: deps.judge.impl,
      error: message,
    });

    // 真实退避：失败后别立刻回头抢同一条（会热循环）。
    if (deps.backoffMs > 0) await (deps.sleep ?? defaultSleep)(deps.backoffMs);
  };

  try {
    const verdict = await deps.judge.judge(input);
    const insert = deps.detailsRepo.insertIdempotent({
      unitId: row.unit_id,
      sessionKey: row.session_key,
      spaceId: row.space_id,
      assetId: verdict.assetId,
      assetType: input.candidates.find((c) => c.assetId === verdict.assetId)?.assetType ?? null,
      round: row.round,
      verdict: verdict.verdict,
      evidenceSourceType:
        input.candidates.find((c) => c.assetId === verdict.assetId)?.evidenceSourceType ?? null,
      promptSha256: deps.judge.promptRef.prompt_sha256,
      judgeImpl: deps.judge.impl,
      detail: {
        rationaleRef: verdict.rationaleRef,
        candidateCount: input.candidates.length,
        unitKind: kind,
        // 56 · C5 观测计数 + C2 双源事实 + C1 轮次落点（缺省走旧路径时不落该键 ⇒ 旧 detail_json 形状不变）
        ...(supply
          ? {
              evidenceSupply: {
                stats: supply.stats,
                dualSource: supply.dualSource,
                fetchedTurnSeq: supply.fetchedTurnSeq,
              },
            }
          : {}),
      },
    });

    // inserted / duplicate 都表示"这条判定已经有落点"⇒ 才可以结算租约。
    if (insert.kind === "inserted" || insert.kind === "duplicate") {
      const completed = deps.queueRepo.complete(row.queue_id, deps.owner, now());

      if (insert.kind === "inserted") result.completed += 1;
      else result.idempotent += 1;
      if (!completed) result.leaseLost += 1;

      emit({
        status: insert.kind === "inserted" ? "ok" : "idempotent",
        promptRef: deps.judge.promptRef,
        inputRefs: [{ unit_id: row.unit_id, queue_id: row.queue_id }],
        outputRefs: [{ judgement_id: insert.judgementId }],
        latencyMs: now() - started,
        judgeImpl: deps.judge.impl,
      });
      return;
    }

    // 落库侧明确告知"没落成"：anomaly = 同 (unit_id, round) 已属别的 asset（判定异常）；
    // failed = 未点名约束冲突 / 写入异常。两者都 fail()，但分桶不同 —— anomaly 不复用 catch 的 errored。
    if (insert.kind === "anomaly") result.anomaly += 1;
    else result.errored += 1;
    await failAndReport(
      insert.kind === "anomaly"
        ? "judgement detail anomaly: (unit_id, round) already held by a different asset_id"
        : "judgement detail insert failed (unexpected write error)",
    );
  } catch (err) {
    result.errored += 1;
    await failAndReport(err instanceof Error ? err.message : String(err));
  }
}

export interface RunWorkerOptions {
  /** true = 抽干积压后返回（--once）；false = 常驻轮询。 */
  drain: boolean;
  /** 抽干模式下的安全上限（防御：异常情况下不无限循环）。 */
  maxDrainRounds?: number;
  /** 常驻模式下由信号处理器置位。 */
  shouldStop?: () => boolean;
  /** 每轮之间回调（观测/测试）。 */
  onRound?: (result: AttributionWorkerCycleResult) => void;
}

/**
 * 跑一轮消费：反复 claimBatch 直到没有可认领行（drain）或收到停止信号。
 */
export async function runWorker(
  deps: AttributionWorkerDeps,
  opts: RunWorkerOptions,
): Promise<AttributionWorkerCycleResult> {
  const result = emptyCycleResult();
  const maxRounds = opts.maxDrainRounds ?? 1000;
  let rounds = 0;

  // 抽干模式：「一轮」= 每条最多消费一次。失败行会回 pending，若不排除会被本轮立刻重抢
  // ⇒ attempts 连加到死信、退避失效（见 ClaimOptions.excludeQueueIds 注释）。
  // 常驻模式不用它：重试要留给下一轮 + backoffMs 退避。
  const alreadyAttempted = opts.drain ? new Set<number>() : undefined;

  while (true) {
    if (opts.shouldStop?.()) break;
    rounds += 1;
    if (opts.drain && rounds > maxRounds) break;

    const rows = deps.queueRepo.claimBatch({
      owner: deps.owner,
      batchSize: deps.batchSize,
      leaseTtlMs: deps.leaseTtlMs,
      now: (deps.now ?? Date.now)(),
      excludeQueueIds: alreadyAttempted,
    });

    if (rows.length === 0) {
      opts.onRound?.(result);
      if (opts.drain) break;
      await (deps.sleep ?? defaultSleep)(deps.pollIntervalMs);
      continue;
    }

    result.claimed += rows.length;
    for (const row of rows) {
      alreadyAttempted?.add(row.queue_id);
      await consumeRow(row, deps, result);
    }
    opts.onRound?.(result);
  }

  return result;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export interface WorkerCliOptions {
  configFile?: string;
  once: boolean;
  retryFailed: boolean;
}

export function parseWorkerArgs(argv: string[]): WorkerCliOptions {
  const opts: WorkerCliOptions = { once: false, retryFailed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") opts.once = true;
    else if (arg === "--retry-failed") opts.retryFailed = true;
    else if (arg === "--config") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        opts.configFile = next;
        i += 1;
      }
    } else if (arg.startsWith("--config=")) {
      opts.configFile = arg.slice("--config=".length);
    }
  }
  return opts;
}

export function buildWorkerDeps(
  judgedConfig: ReturnType<typeof buildConfig>,
  owner: string,
  overrides: CreateJudgeDeps = {},
): AttributionWorkerDeps {
  const workerCfg = judgedConfig.attribution?.judge?.worker;
  return {
    queueRepo: getAttributionJudgeQueueRepo(),
    detailsRepo: getAttributionJudgementDetailsRepo(),
    judge: createJudge(judgedConfig, overrides),
    // 56 · 生产总装真 provider（DB 降级 ⇒ Null repo，两路空 + visibleAssets 便捷路径不失联）
    evidenceSupply: createEvidenceSupplyProvider(getAttributionEventRepo()),
    owner,
    batchSize: workerCfg?.batchSize ?? 8,
    leaseTtlMs: workerCfg?.leaseTtlMs ?? 600_000,
    maxAttempts: workerCfg?.maxAttempts ?? 3,
    pollIntervalMs: workerCfg?.pollIntervalMs ?? 200,
    backoffMs: workerCfg?.backoffMs ?? 1000,
  };
}

const EXIT_OK = 0;
/** DB 不可用：明确报错退出（**不**伪造成功 —— checklist 组合矩阵第 6 行）。 */
export const EXIT_DB_UNAVAILABLE = 2;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const opts = parseWorkerArgs(argv);
  const config = buildConfig({ configFile: opts.configFile });

  initAttributionJudgeLogger(resolveAttributionJudgeLogDir(config));

  // 先探库：DB 不可用时 win/lin 都要给明确报错 + 非零码，不能装成功。
  if (!getDb()) {
    process.stderr.write(
      "[attribution-judge] FATAL: SQLite unavailable (getDb() → null) — worker cannot run.\n",
    );
    await shutdownAttributionJudgeLogger();
    return EXIT_DB_UNAVAILABLE;
  }

  const owner = `attribution-judge-${process.pid}-${Date.now()}`;
  const deps = buildWorkerDeps(config, owner);

  process.stderr.write(
    `[attribution-judge] worker start owner=${owner} once=${opts.once} retryFailed=${opts.retryFailed} ` +
      `log=${getAttributionJudgeLogFilePath()}\n`,
  );

  if (opts.retryFailed) {
    const n = deps.queueRepo.retryFailed();
    process.stderr.write(`[attribution-judge] retry-failed: ${n} row(s) reset to pending\n`);
  }

  let stopping = false;
  const onSignal = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`[attribution-judge] ${signal} received — finishing current row then exit\n`);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  const result = await runWorker(deps, {
    drain: opts.once,
    shouldStop: () => stopping,
  });

  process.stderr.write(
    `[attribution-judge] worker exit claimed=${result.claimed} completed=${result.completed} ` +
      `idempotent=${result.idempotent} anomaly=${result.anomaly} errored=${result.errored} ` +
      `deadLettered=${result.deadLettered} requeued=${result.requeued} leaseLost=${result.leaseLost}\n`,
  );

  await shutdownAttributionJudgeLogger();
  return EXIT_OK;
}

/** 供测试复位模块级单例（worker 自身无单例，转调各 repo 的 reset）。 */
export function __resetAttributionWorkerForTests(): void {
  __resetAttributionJudgeLoggerForTests();
}

// ── 进程入口（被 import 时不执行）──────────────────────────────────────────────

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(
        `[attribution-judge] FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    });
}
