/**
 * 87 · A：吞吐不匹配 —— 测量脚本（**零生产代码**；只跑临时库）。
 *
 * 用途：以"每轮到达率 × topNPerCycle"跑 drain 轮，记录 墙钟 / 处理数 / overflowed / pending 曲线；
 * 并给出 N/T 敏感性表（真 LLM 延迟 T ∈ {2,5,10}s ⇒ 每轮产能 ≈ N/T）。
 *
 * 硬约束：
 *   - **绝不用默认库**：`--db <path>` 必填，且 assertSafeTarget 拒绝 `~/.tdai-memory-proxy/proxy.db`（R2 钉点）；
 *   - **零 LLM 花费**：judge = DeterministicMockJudge（impl=mock:v1）——**mock 耗时 ≠ 真 provider 耗时**；
 *   - 不改任何生产缺省值：topNPerCycle 由本脚本显式传入。
 *
 * 用法：
 *   cd MemoryProxy
 *   PROXY_DB_PATH=<mkdtemp>/proxy.db npx tsx scripts/qa/throughput-measure.ts --db <mkdtemp>/proxy.db
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_DB = path.join(os.homedir(), ".tdai-memory-proxy", "proxy.db");

/** 76/87 同款安全守卫：显式临时库才放行；默认库直接抛（不静默）。 */
export function assertSafeTarget(dbPath: string | undefined): string {
  if (!dbPath || dbPath.trim().length === 0) {
    throw new Error("[87-throughput] --db 必填（显式临时库路径）；拒绝隐式默认库。");
  }
  const resolved = path.resolve(dbPath.trim());
  if (resolved === DEFAULT_DB) {
    throw new Error(`[87-throughput] 拒绝对默认（真实）库运行测量：${resolved}`);
  }
  return resolved;
}

interface RoundRow {
  round: number;
  seeded: number;
  claimed: number;
  completed: number;
  overflowed: number;
  pendingAfter: number;
  wallMs: number;
}

interface GroupSummary {
  topN: number;
  arrival: number;
  label: string;
  rows: RoundRow[];
  pendingFirst: number;
  pendingLast: number;
  monotonic: boolean;
}

async function seed(
  queueRepo: { enqueue: (i: { unitId: string; sessionKey: string; payload: unknown }) => boolean },
  prefix: string,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    queueRepo.enqueue({
      unitId: `${prefix}-u${i}`,
      sessionKey: `${prefix}`,
      payload: { unitType: "code_change" }, // 无候选 ⇒ mock judge 走 unconfirmed 快路径（零 LLM）
    });
  }
}

/** 每轮产能（units/s）≈ topN / T —— **唯一换算源**（输出与 R3 自校验共用）。 */
function capacity(topN: number, t: number): number {
  return topN / t;
}

async function main(): Promise<number> {
  const argIdx = process.argv.indexOf("--db");
  const dbArg = argIdx >= 0 ? process.argv[argIdx + 1] : undefined;
  const dbPath = assertSafeTarget(dbArg);
  process.env.PROXY_DB_PATH = dbPath;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // —— 依赖（惰性 import：确保 env 先设好）——
  const { getDb } = await import("../../src/db/index.js");
  const { getAttributionJudgeQueueRepo } = await import("../../src/attribution/judge-queue-repo.js");
  const { getAttributionJudgementDetailsRepo } = await import("../../src/attribution/judgement-details-repo.js");
  const { runWorker, DEFAULT_TOP_N_PER_CYCLE } = await import("../../src/attribution/worker.js");
  const { DeterministicMockJudge } = await import("../../src/attribution/judge/deterministic-mock-judge.js");

  const db = getDb();
  if (!db) {
    console.error(`[87-throughput] 临时库打开失败：${dbPath}`);
    return 2;
  }
  const queueRepo = getAttributionJudgeQueueRepo();

  const ROUNDS = 12;
  const TOP_NS = [DEFAULT_TOP_N_PER_CYCLE, 50, 100];
  const groups: GroupSummary[] = [];

  for (const topN of TOP_NS) {
    const arrivals: Array<{ a: number; label: string }> = [
      { a: Math.max(1, Math.floor(topN / 2)), label: "≤N(半额)" },
      { a: topN, label: "≈N(等额)" },
      { a: topN * 2, label: ">N(双倍)" },
    ];
    for (const { a, label } of arrivals) {
      const rows: RoundRow[] = [];
      const prefix = `m87-n${topN}-a${a}`;
      for (let round = 1; round <= ROUNDS; round += 1) {
        await seed(queueRepo, `${prefix}-r${round}`, a); // 本轮到达
        const pendingBefore = queueRepo.countByStatus().pending ?? 0;
        const t0 = performance.now();
        const result = await runWorker(
          {
            queueRepo,
            detailsRepo: getAttributionJudgementDetailsRepo(),
            judge: new DeterministicMockJudge(),
            owner: `m87-n${topN}-a${a}`,
            batchSize: 8,
            leaseTtlMs: 60_000,
            maxAttempts: 3,
            pollIntervalMs: 1,
            backoffMs: 0,
            topNPerCycle: topN,
            sleep: async () => {},
            emitLog: () => {},
          },
          { drain: true },
        );
        const wallMs = performance.now() - t0;
        const pendingAfter = queueRepo.countByStatus().pending ?? 0;
        rows.push({
          round,
          seeded: a,
          claimed: result.claimed,
          completed: result.completed,
          overflowed: result.overflowed,
          pendingAfter,
          wallMs,
        });
        void pendingBefore;
      }
      const pendingFirst = rows[0]!.pendingAfter;
      const pendingLast = rows[rows.length - 1]!.pendingAfter;
      const monotonic = rows.every((r, i) => i === 0 || r.pendingAfter >= rows[i - 1]!.pendingAfter);
      groups.push({ topN, arrival: a, label, rows, pendingFirst, pendingLast, monotonic });
    }
  }

  // —— 逐轮表（原始输出）——
  for (const g of groups) {
    console.log(
      `\n[87] topN=${g.topN} 到达=${g.arrival}（${g.label}）  pending: ${g.pendingFirst} → ${g.pendingLast}  单调增=${g.monotonic}`,
    );
    console.log("round  seeded claimed  done overflowed pendingAfter  wallMs");
    for (const r of g.rows) {
      console.log(
        `${String(r.round).padStart(2)}     ${String(r.seeded).padStart(4)}  ${String(r.claimed).padStart(5)}  ${String(r.completed).padStart(4)}  ${String(r.overflowed).padStart(6)}  ${String(r.pendingAfter).padStart(8)}  ${r.wallMs.toFixed(1).padStart(6)}`,
      );
    }
  }

  // —— N/T 敏感性表（真 LLM 延迟；含 R3 已知点自校验）——
  const TS = [2, 5, 10];
  console.log("\n[87] 敏感性表：每轮产能 ≈ topN / T（units/s）——真 provider 单次判定延迟 T（**非 mock**）");
  console.log("topN   T=2s   T=5s   T=10s");
  const known: Array<[number, number, number]> = [
    [30, 5, 6],
    [100, 10, 10],
  ];
  for (const topN of TOP_NS) {
    const cells = TS.map((t) => capacity(topN, t).toFixed(1));
    console.log(`${String(topN).padStart(4)}   ${cells.map((c) => c.padStart(5)).join("  ")}`);
    for (const [n, t, want] of known) {
      if (n === topN) {
        const got = capacity(topN, t);
        if (got !== want) {
          console.error(`[87][R3-自校验] FAIL: ${topN}/${t} = ${got}，期望 ${want}`);
          return 3;
        }
      }
    }
  }
  console.log("\n[87] 断点（到达率 > N/T ⇒ 积压单调增长）：");
  for (const topN of TOP_NS) {
    const perT = TS.map((t) => `${t}s:${(topN / t).toFixed(1)}`).join("  ");
    console.log(`  topN=${topN} ⇒ 每轮产能上限（units/s） ${perT}；每轮产能（units/轮）= ${topN}`);
  }
  console.log(`\n[87] 零 LLM 花费证据：judge impl = "mock:v1"（DeterministicMockJudge）；本组数据仅代表**框架吞吐**。`);
  db.close();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[87-throughput] 异常：${err instanceof Error ? err.message : String(err)}`);
    process.exit(9);
  });
