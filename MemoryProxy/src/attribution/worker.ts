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
import { gradeCandidates, shortlistCandidates, type CandidateCitationMetrics } from "./citation/grading.js";
import { getCitationSourceProvider, type CitationSourceProvider } from "./citation/source.js";
import { createJudge, JudgeConfigError, validateJudgeConfig, type CreateJudgeDeps } from "./judge/create-judge.js";
import type { Judge, JudgeCandidate, JudgeInput, JudgeVerdict } from "./judge/types.js";
import {
  getAttributionStatusEventsRepo,
  noteStatusGuardViolation,
  noteStatusSkipped,
} from "./status-events-repo.js";
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
  /**
   * 57 · 三道机械锚点的只读输入源（50 spec §12）：装配 ⇒ 对 shortlist 前 K 逐候选出度量落
   * `detail_json.citationMetrics`；缺省 ⇒ 不出度量（shortlist 截断与溢出可观测**不受影响**，
   * 它不依赖本字段）。生产 `buildWorkerDeps` 总装。
   */
  citationSource?: CitationSourceProvider;
}

export interface AttributionWorkerCycleResult {
  claimed: number;
  completed: number;
  /** 幂等命中（明细已存在）——成功路径的一个分支，不算失败。 */
  idempotent: number;
  /** 60 · 幻觉护栏触发次数（assetId ∉ candidates ⇒ 强制 unconfirmed；C4）。 */
  guarded: number;
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
    guarded: 0,
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

/**
 * 60 · C4 幻觉护栏（**worker 边界**，对 mock / mechanical / real **一律生效**）：
 * provider 是不可信输入源，校验必须在信任边界这一侧做 —— provider 实现不重复此逻辑。
 * `assetId` 不在候选内 ⇒ 强制降级 `unconfirmed` + `rationaleRef` 标记；**不改选其它候选**（不猜）。
 */
export function applyHallucinationGuard(
  verdict: JudgeVerdict,
  candidates: readonly JudgeCandidate[],
): { verdict: JudgeVerdict; tripped: boolean } {
  if (verdict.assetId === null) return { verdict, tripped: false };
  if (candidates.some((c) => c.assetId === verdict.assetId)) return { verdict, tripped: false };
  return {
    verdict: {
      assetId: null,
      verdict: "unconfirmed",
      rationaleRef: `guard:asset_not_in_candidates:${verdict.assetId}`,
    },
    tripped: true,
  };
}

/**
 * 59 · 状态事件落点（50 spec §14 C2 触发真值表）：
 * confirmed + 非空 assetId ⇒ 写 `asset_used`（payload 只回指、不复制判定内容）；
 * 其余不写但计数（F5）。顺序写、各自幂等；失败不回滚 judgement（repo 内已计数 + warn）。
 */
function recordStatusEvent(
  row: JudgeQueueRow,
  verdict: JudgeVerdict,
  input: JudgeInput,
  judgementId: string,
  judgeImpl: string,
  citationMetrics: CandidateCitationMetrics[] | undefined,
  unitPayload: unknown,
): void {
  if (verdict.verdict === "confirmed" && verdict.assetId !== null) {
    const m = citationMetrics?.find((x) => x.assetId === verdict.assetId);
    const rawOutcome =
      unitPayload && typeof unitPayload === "object"
        ? (unitPayload as { resultStatus?: unknown }).resultStatus
        : undefined;
    getAttributionStatusEventsRepo().insertIdempotent({
      unitId: row.unit_id,
      sessionKey: row.session_key,
      spaceId: row.space_id,
      assetId: verdict.assetId,
      assetType: input.candidates.find((c) => c.assetId === verdict.assetId)?.assetType ?? null,
      round: row.round,
      outcome: typeof rawOutcome === "string" ? rawOutcome : null,
      payload: {
        // 链接字段（C4）：只回指、不复制判定内容 —— 单一真相在 judgement_details。
        judgement_id: judgementId,
        unit_id: row.unit_id,
        verdict: verdict.verdict,
        match_level: m?.matchLevel ?? null,
        coverage: typeof m?.coverage === "number" ? m.coverage : null,
        prompt_sha256: input.promptRef.prompt_sha256,
        judge_impl: judgeImpl,
      },
    });
    return;
  }
  if (verdict.verdict === "confirmed") {
    // 护栏违反：confirmed + null assetId（构造上不可能，出现即 bug）。
    noteStatusGuardViolation(`unit=${row.unit_id}`);
    return;
  }
  noteStatusSkipped(verdict.verdict);
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

  // 57 · ④ shortlist（不重排，§11.2 顺序；前 K 喂 judge；溢出 = 计数 + 清单落 detail_json）
  const shortlist = shortlistCandidates(supply ? supply.candidates : extractJudgeCandidates(payload));
  // 57 · ⑤ 三道机械锚点（只对前 K；缺 citationSource ⇒ 不出度量，见 deps 注释）
  const citationMetrics = deps.citationSource
    ? gradeCandidates({
        sessionKey: row.session_key,
        turnSeq,
        candidates: shortlist.candidates,
        source: deps.citationSource,
      })
    : undefined;

  const input: JudgeInput = {
    unitId: row.unit_id,
    sessionKey: row.session_key,
    round: row.round,
    unit: { kind, payload },
    candidates: shortlist.candidates,
    promptRef: deps.judge.promptRef,
    // 58 · C0：度量无条件随调用传入（mock 不读 ⇒ 行为不变；mechanical 缺它 ⇒ 全 unconfirmed）
    citationMetrics,
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
    const rawVerdict = await deps.judge.judge(input);
    // 60 · C4：护栏后的 verdict 才进落库/状态/计数（对一切 provider 生效）。
    const guard = applyHallucinationGuard(rawVerdict, input.candidates);
    if (guard.tripped) result.guarded += 1;
    const verdict = guard.verdict;
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
        // 57 · C1 溢出可观测（总落；候选 ≤K 时 overflowCount=0）+ ⑤ 度量（装配 citationSource 才落）
        shortlist: {
          k: shortlist.k,
          total: shortlist.total,
          overflowCount: shortlist.overflowCount,
          overflowAssetIds: shortlist.overflowAssetIds,
        },
        ...(citationMetrics ? { citationMetrics } : {}),
        // 59 · C5 消费点：excluded 类别声明随判定落库（对账材料；无 citationSource ⇒ 不落该键）
        ...(deps.citationSource
          ? { excludedCategories: deps.citationSource.excludedCategories() }
          : {}),
      },
    });

    // inserted / duplicate 都表示"这条判定已经有落点"⇒ 才可以结算租约。
    if (insert.kind === "inserted" || insert.kind === "duplicate") {
      const completed = deps.queueRepo.complete(row.queue_id, deps.owner, now());

      if (insert.kind === "inserted") result.completed += 1;
      else result.idempotent += 1;
      if (!completed) result.leaseLost += 1;

      // 59 · §14：judgement 落库成功后顺序写状态事件（各自幂等；失败不回滚 judgement）
      recordStatusEvent(row, verdict, input, insert.judgementId, deps.judge.impl, citationMetrics, payload);

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
    // 57 · 生产总装真引文输入源（DB 降级 ⇒ 窗口/资产文本空 ⇒ 度量全 null/unknown，安全降级）
    citationSource: getCitationSourceProvider(),
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
/**
 * 60 · 配置不合法（未知 provider / real 缺参数）——fail-closed（50 spec §15 C1）：
 * 明确报错退出，**绝不**降级 mock；校验在 getDb() 之前、一次性判死、不重试。
 */
export const EXIT_CONFIG_INVALID = 3;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const opts = parseWorkerArgs(argv);
  const config = buildConfig({ configFile: opts.configFile });

  // 60 · C1 fail-closed：配置校验在 getDb() **之前**（不碰库、不重试、进程级判死）。
  try {
    validateJudgeConfig(config);
  } catch (err) {
    if (err instanceof JudgeConfigError) {
      process.stderr.write(`[attribution-judge] FATAL: ${err.message}\n`);
      return EXIT_CONFIG_INVALID;
    }
    throw err;
  }

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
      `idempotent=${result.idempotent} guarded=${result.guarded} anomaly=${result.anomaly} ` +
      `errored=${result.errored} deadLettered=${result.deadLettered} requeued=${result.requeued} ` +
      `leaseLost=${result.leaseLost}\n`,
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
