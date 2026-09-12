/**
 * 69 · L1 自动接线（70 spec §3）：CLI 范围 + post-cycle 脏集 + 节流 + 六计数观测。
 *
 * 定格口径（C6）：以 60 spec §5 "payload 新鲜度契约"（68 D1）为**唯一来源** —— corrected 行
 * 版本字段 = **检测时（首次判定）快照**；重跑 ⇒ duplicate、`payload_json` 逐字不变。
 * 本模块**不得**（也不）修改 `insertIdempotent` 的 `ON CONFLICT … DO UPDATE` 子句与锚公式
 * （γ"冲突时刷新 payload"形态已被否）。
 *
 * 脏集语义（C2）：仅"**本进程消费过的 session**"（不扩到 proxy 写入侧）。理由：corrected 信号的
 * 前提是"**回指已存在的 used 行**"——资产被抓取过但从未影响任何决策（无 used 行）时压根没有
 * 信号可回指，扩到写入侧只是多扫一批注定没有落点的会话（纯浪费，不是"更完整的覆盖"）。
 * **登记**：fetched-only 漂移（同 session 先 fetch v1 → used → 后 fetch v2 且此后无新队列行）
 * 由 CLI / 周期补扫覆盖；进程重启 ⇒ 内存脏集丢失 ⇒ 同样由补扫覆盖。
 */
import { getAttributionEventRepo } from "../db/attributionEventRepo.js";
import {
  applyVersionDriftCorrections,
  type L1Outcome,
} from "./corrected-rules.js";
import { getAttributionStatusEventsRepo } from "./status-events-repo.js";

/** 69 · config 形状（types.ts 的 AttributionJudgeWorkerConfig.correctL1；三处同改纪律）。 */
export interface CorrectL1Config {
  enabled: boolean;
  minIdleMs: number;
}

/** C5 · 六计数缺省（全 0）。 */
export function emptyL1Outcome(): L1Outcome {
  return {
    assetsScanned: 0,
    assetsWithDrift: 0,
    assetsSkippedNoVersion: 0,
    correctedInserted: 0,
    correctedDuplicate: 0,
    failed: 0,
  };
}

/** C1 · `--since` 解析：毫秒数 或 ISO8601 ⇒ epoch ms；非法 / 空 ⇒ null（调用方报错退出）。 */
export function parseSinceMs(raw: string): number | null {
  const t = raw.trim();
  if (t.length === 0) return null;
  const n = Number(t);
  if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
  const parsed = Date.parse(t);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * C1 · `--correct-l1` 范围参数校验（纯参数，不碰库）。
 * 返回 null = 合法；否则返回错误说明（调用方 `EXIT_L1_SCOPE_INVALID` + 零扫描）。
 */
export function validateL1CliScope(opts: {
  sessionKey?: string;
  allSessions: boolean;
  sinceRaw?: string;
}): string | null {
  if (opts.sessionKey && opts.allSessions) {
    return "--session and --all-sessions are mutually exclusive (范围开关三选一)";
  }
  if (!opts.sessionKey && !opts.allSessions) {
    return "--correct-l1 requires a scope: --session=<key> or --all-sessions --since=<ms|ISO8601>";
  }
  if (!opts.allSessions && opts.sinceRaw !== undefined) {
    return "--since only applies to --all-sessions (--session is already bounded)";
  }
  if (opts.allSessions) {
    if (opts.sinceRaw === undefined) {
      return "--all-sessions requires --since (防无界全表扫)";
    }
    if (parseSinceMs(opts.sinceRaw) === null) {
      return `--since 值非法（需 ms 数或 ISO8601）: "${opts.sinceRaw}"`;
    }
  }
  return null;
}

/**
 * T8 · `--all-sessions` 会话枚举：**fetched ∪ used 两来源并集**、去重、确定性排序
 * （水位 = `created_at >= sinceMs`）。
 */
export function enumerateL1Sessions(sinceMs: number): string[] {
  const fetched = getAttributionEventRepo().distinctSessionKeys(sinceMs);
  const used = getAttributionStatusEventsRepo().distinctSessionKeys(sinceMs);
  return [...new Set([...fetched, ...used])].sort();
}

/** L1 单 session 跑法（可注入：测试 spy / 构造异常）。 */
export type L1Runner = (sessionKey: string) => L1Outcome;

export interface L1WiringDeps {
  /** 缺省 = `applyVersionDriftCorrections`（规则本体）。 */
  applyL1?: L1Runner;
  now?: () => number;
}

function mergeOutcome(acc: L1Outcome, o: L1Outcome): void {
  acc.assetsScanned += o.assetsScanned;
  acc.assetsWithDrift += o.assetsWithDrift;
  acc.assetsSkippedNoVersion += o.assetsSkippedNoVersion;
  acc.correctedInserted += o.correctedInserted;
  acc.correctedDuplicate += o.correctedDuplicate;
  acc.failed += o.failed;
}

/** 对 N 个 session 依次跑 L1，六计数聚合（CLI 与 post-cycle 共用）。 */
export function runL1ForSessions(sessions: readonly string[], deps: L1WiringDeps = {}): L1Outcome {
  const apply = deps.applyL1 ?? ((s: string) => applyVersionDriftCorrections(s));
  const total = emptyL1Outcome();
  for (const s of sessions) mergeOutcome(total, apply(s));
  return total;
}

/** C5 · 观测形状（cycle 摘要 / stderr 一行共用；照 `overflowed` 的既有姿势）。 */
export function formatL1Outcome(o: L1Outcome): string {
  return (
    `assetsScanned=${o.assetsScanned} assetsWithDrift=${o.assetsWithDrift} ` +
    `assetsSkippedNoVersion=${o.assetsSkippedNoVersion} correctedInserted=${o.correctedInserted} ` +
    `correctedDuplicate=${o.correctedDuplicate} failed=${o.failed}`
  );
}

/**
 * C1/C2/C3 · post-cycle 钩子（**缺省关**）：
 * - `enabled=false` ⇒ **零动作、零输出**（零回归硬保证）；
 * - 脏集为空 / 无到期的 session ⇒ **零动作**（不得空扫、不得触达 repo）；
 * - 同一 session 相邻两次修正间隔 ≥ `minIdleMs`（节流）；
 * - 一次扫完即从脏集**移除**（下次有新消费再入）。
 *
 * C4 · L1 异常必须被捕获：计入 `failed`、stderr 一行 warn、**不改 cycle 计数、不改队列行状态、
 * 不得让 worker 退出**。
 */
export function createPostCycleL1Hook(
  cfg: CorrectL1Config,
  deps: L1WiringDeps = {},
): (consumedSessions: Set<string>) => void {
  const now = deps.now ?? Date.now;
  const lastScannedAt = new Map<string, number>();
  return (consumedSessions) => {
    if (!cfg.enabled) return;
    const t = now();
    const due = [...consumedSessions]
      .filter((s) => {
        const last = lastScannedAt.get(s);
        return last === undefined || t - last >= cfg.minIdleMs;
      })
      .sort();
    if (due.length === 0) return; // 空集/全被节流 ⇒ 零动作（不空扫）
    let line: string;
    try {
      const outcome = runL1ForSessions(due, deps);
      line = `[attribution-judge] l1-correct sessions=${due.length} ${formatL1Outcome(outcome)}\n`;
    } catch (err) {
      // C4：吞掉异常（不得影响消费），以 failed=1 报告。
      line =
        `[attribution-judge] l1-correct sessions=${due.length} failed=1 ` +
        `(${err instanceof Error ? err.message : String(err)})\n`;
    }
    for (const s of due) lastScannedAt.set(s, t);
    for (const s of due) consumedSessions.delete(s);
    process.stderr.write(line);
  };
}
