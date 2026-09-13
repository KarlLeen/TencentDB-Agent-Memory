/**
 * 136 · D4 / 137 · `P-1` 正例挖掘**可复跑入口**（只读、只元数据 + 指纹、不改判定）。
 *
 * 用法（在 MemoryProxy/ 下）：
 *   npx tsx scripts/qa/positive-mining.ts             # 全真库扫（真库 .backup 副本只读；退出即清理）
 *   npx tsx scripts/qa/positive-mining.ts --db <path> # 指定 SQLite（默认真库）
 *
 * 口径（`136 · D1/D2` 已拍；若改动须同批改 `80 spec §3`）：
 *   - 范围 = **全真库**（`D2`：只扫含 `asset_fetched` 的会话会**结构性漏**未走抓取路径的引用）；
 *   - **弱候选** `shadowBestContiguousRunChars ≥ 12`（宽松召回、**不得**直接当正例）；
 *   - **强候选** `run ≥ 24`（= `109` 最低可用下界）。
 *
 * 输出 = 候选清单（只 ids / 数字 / 指纹）+ **落空报告**（候选 0 时仍打印总数 / 分布 / 各轴 max
 * ⇒ "真的没有候选" 与 "挖取口径坏了" 可分 —— `136 §2`；本线 `#6`"绿而不证"的反面做法）
 * + `[account]` 对账行（与 `136 §1` 基线逐格可比）。
 * 隐私：绝不落正文；输出整体经 `[privacy]` 闸（真库正文 ≥64 连续字符窗口 0 命中，同 `108` 四道闸）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** `136 · D1` 两档（已拍）。 */
const WEAK_MIN_RUN = 12;
const STRONG_MIN_RUN = 24;

/** `109 · C0`：自建副本（含真库内容）⇒ 任何退出路径都必须清理（主库 + `-wal`/`-shm`）。 */
let cleanupWorkDb: string | null = null;
function cleanup(): void {
  if (cleanupWorkDb) {
    for (const p of [cleanupWorkDb, `${cleanupWorkDb}-wal`, `${cleanupWorkDb}-shm`]) {
      fs.rmSync(p, { force: true });
    }
    cleanupWorkDb = null;
  }
}

function fail(msg: string): never {
  cleanup(); // process.exit 会跳过 finally —— 这里显式清理
  console.error(`✗ ${msg}`);
  process.exit(1);
}

type JudgementRow = {
  judgement_id: string;
  unit_id: string | null;
  session_key: string | null;
  round: number | null;
  detail_json: string;
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const fmt = (v: number | null): string => (v === null ? "—" : String(v));
const maxOf = (arr: readonly number[]): number | null =>
  arr.length === 0 ? null : arr.reduce((a, b) => (b > a ? b : a));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dbIdx = argv.indexOf("--db");
  const dbArg = dbIdx >= 0 ? argv[dbIdx + 1] : undefined;

  const realDefault = path.join(os.homedir(), ".tdai-memory-proxy", "proxy.db");
  const srcDb = dbArg ?? realDefault;
  if (!fs.existsSync(srcDb)) fail(`找不到库：${srcDb}（真库不存在时请用 --db 指定副本）`);
  let workDb = srcDb;
  if (!dbArg) {
    workDb = path.join(os.tmpdir(), `positive-mining-${process.pid}.db`);
    execFileSync("sqlite3", [srcDb, `.backup ${workDb}`]);
    cleanupWorkDb = workDb; // 109 · C0：退出即清理（副本含真库内容）
    console.log(`[db] 真库已 .backup 到副本：${workDb}（真库全程只读；退出即清理副本）`);
  }
  process.env.PROXY_DB_PATH = workDb; // 与标定台同法：后续 getDb() 只碰副本

  const { getDb } = await import("../../src/db/index.js");
  const db = getDb();
  if (!db) fail("getDb() 返回 null（库打不开）");

  const rows = db
    .prepare(
      "SELECT judgement_id, unit_id, session_key, round, detail_json FROM attribution_judgement_details ORDER BY judgement_id",
    )
    .all() as JudgementRow[];

  const out: string[] = [];
  const candidates: Array<{
    unit: string | null;
    round: number | null;
    session: string | null;
    assetId: string;
    run: number;
    norm: number | null;
    sha16: string | null;
  }> = [];
  const runs: number[] = [];
  const normVals: number[] = [];
  const perRow: string[] = [];
  const roundDist: Record<string, number> = {};
  let shadowRows = 0;
  let totalScored = 0;
  let runNonNumeric = 0;
  let spansMax: number | null = null;
  let perMsgMax: number | null = null;
  let perMsgUnknown = 0;

  for (const r of rows) {
    let detail: Record<string, unknown>;
    try {
      detail = JSON.parse(r.detail_json) as Record<string, unknown>;
    } catch {
      fail(`判定行 detail_json 非法 JSON：${r.judgement_id}`);
    }
    const sh = detail["citationMetricsShadow"];
    if (!Array.isArray(sh)) continue; // round=0 行早于 106 ⇒ 无该键，跳过
    shadowRows += 1;
    roundDist[String(r.round)] = (roundDist[String(r.round)] ?? 0) + 1;
    let rowMaxRun: number | null = null;
    for (const raw of sh) {
      const e = (raw ?? {}) as Record<string, unknown>;
      totalScored += 1;
      const run = e["shadowBestContiguousRunChars"];
      if (isNum(run)) {
        runs.push(run);
        rowMaxRun = rowMaxRun === null ? run : Math.max(rowMaxRun, run);
      } else {
        runNonNumeric += 1; // 取数形状若坏（键名/层级错）⇒ 这里是可见信号
      }
      const spans = e["shadowQuotedSpanCount"];
      if (isNum(spans)) spansMax = spansMax === null ? spans : Math.max(spansMax, spans);
      const pm = e["shadowBestSegCoveragePerMsg"];
      if (isNum(pm)) perMsgMax = perMsgMax === null ? pm : Math.max(perMsgMax, pm);
      else if (typeof pm === "string") perMsgUnknown += 1; // "unknown" = 不可测（≠ 0）
      const norm = e["shadowBestContiguousRunNorm"];
      if (isNum(norm)) normVals.push(norm);
      if (isNum(run) && run >= WEAK_MIN_RUN) {
        candidates.push({
          unit: r.unit_id,
          round: r.round,
          session: r.session_key,
          assetId: typeof e["assetId"] === "string" ? e["assetId"] : "(缺)",
          run,
          norm: isNum(norm) ? norm : null,
          sha16: typeof e["shadowBestSegSha256_16"] === "string" ? e["shadowBestSegSha256_16"] : null,
        });
      }
    }
    perRow.push(`  ${r.judgement_id} ${r.unit_id ?? "—"} r${r.round ?? "?"} n=${sh.length} maxRun=${fmt(rowMaxRun)}`);
  }

  const strong = candidates.filter((c) => c.run >= STRONG_MIN_RUN);
  const weak = candidates.filter((c) => c.run < STRONG_MIN_RUN);
  const dist: Record<string, number> = {};
  for (const v of runs) dist[String(v)] = (dist[String(v)] ?? 0) + 1;
  const distSorted = Object.fromEntries(
    Object.keys(dist)
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => [String(k), dist[String(k)]!]),
  );
  const maxRun = maxOf(runs);
  const maxNorm = maxOf(normVals);
  const rowDistSorted = Object.fromEntries(
    Object.keys(roundDist)
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => [String(k), roundDist[String(k)]!]),
  );

  const fmtCand = (c: (typeof candidates)[number]): string =>
    `  - unit_id=${c.unit ?? "—"} round=${c.round ?? "?"} session_key=${c.session ?? "—"} assetId=${c.assetId}` +
    ` run=${c.run} runNorm=${fmt(c.norm)} sha16=${c.sha16 ?? "—"}`;

  out.push(`[scan] 判定行 = ${rows.length}，其中带 citationMetricsShadow = ${shadowRows}（round 分布 = ${JSON.stringify(rowDistSorted)}）`);
  out.push(`[scan] 参与评分的候选总数 = ${totalScored}`);
  out.push(...perRow);
  out.push("");
  out.push("—— 候选清单（P-1；只元数据 + 指纹，绝不落正文）——");
  out.push(`强候选（run ≥ ${STRONG_MIN_RUN}）：${strong.length} 条`);
  for (const c of strong) out.push(fmtCand(c));
  out.push(`弱候选（${WEAK_MIN_RUN} ≤ run < ${STRONG_MIN_RUN}）：${weak.length} 条`);
  for (const c of weak) out.push(fmtCand(c));
  out.push("");
  out.push(`—— ${candidates.length === 0 ? "落空报告（候选数 = 0）" : "读数摘要"} ——`);
  out.push(`① 参与评分的候选总数 = ${totalScored}（run 非数值行 = ${runNonNumeric}）`);
  out.push(`② 全局 max(run) = ${fmt(maxRun)}；run 分布 = ${JSON.stringify(distSorted)}`);
  out.push(`③ max(spans) = ${fmt(spansMax)}；max(perMsg) = ${fmt(perMsgMax)}（unknown 行 = ${perMsgUnknown}）`);
  if (candidates.length === 0) {
    out.push(
      totalScored > 0 && runs.length === totalScored
        ? `⇒ 判定：属「真没有候选」（取数口径正常：${totalScored} 条候选逐条可取、分布非空）`
        : `⇒ 判定：疑似「挖取口径坏了」（总数=${totalScored} / 可取数=${runs.length} ⇒ 查形状/键名）`,
    );
  }
  // 对账表征（137 · C4 落地）：`max(runNorm)` 并列两形态（**同一 double**）——
  //   `toFixed(16)` = 与 `136 §1` / C4 冻结格同表征（16 位小数）；
  //   最短往返（`String()`）= 唯一能精确往返到该 double 的形式。
  //   ⇒ 防"1-ulp 表征差被误读成真库漂移"（137 对账中实际发生过一次原地核查）。
  const normFixed = maxNorm === null ? "—" : maxNorm.toFixed(16).replace(/0+$/, "").replace(/\.$/, "");
  out.push(
    `[account] 总数=${totalScored} | 弱档(≥${WEAK_MIN_RUN})=${weak.length} | 强档(≥${STRONG_MIN_RUN})=${strong.length}` +
      ` | run分布=${JSON.stringify(distSorted)} | max(run)=${fmt(maxRun)} | max(runNorm)=${normFixed}` +
      ` | max(runNorm.exact)=${fmt(maxNorm)} | max(spans)=${fmt(spansMax)} | max(perMsg)=${fmt(perMsgMax)}`,
  );

  // ── 隐私闸（108 四道闸同款；被检对象 = 本入口的**输出**整体）──
  const bodies: string[] = [];
  for (const b of db.prepare("SELECT content_utf8 FROM attribution_block_text").all() as Array<{
    content_utf8: string;
  }>) {
    bodies.push(b.content_utf8);
  }
  const snapCols = db.prepare("PRAGMA table_info(attribution_message_snap)").all() as Array<{
    name: string;
    type: string;
  }>;
  const textCols = snapCols
    .filter((c) => /TEXT/i.test(c.type) && !/hash|_id$|^id$/i.test(c.name))
    .map((c) => c.name);
  if (textCols.length > 0) {
    for (const r of db
      .prepare(`SELECT ${textCols.join(", ")} FROM attribution_message_snap`)
      .all() as Array<Record<string, unknown>>) {
      for (const c of textCols) {
        const v = r[c];
        if (typeof v === "string" && v.length >= 64) bodies.push(v);
      }
    }
  }
  const outText = out.join("\n");
  let windows = 0;
  for (const body of bodies) {
    for (let i = 0; i + 64 <= body.length; i += 1) {
      windows += 1;
      const w = body.slice(i, i + 64);
      if (outText.includes(w)) {
        fail(`[privacy] 输出卫生检查红：出现真库正文 ≥64 连续字符窗口：${JSON.stringify(w.slice(0, 24))}…`);
      }
    }
  }
  console.log(`[privacy] 输出卫生检查通过：${bodies.length} 条真库文本 / ${windows} 个 64-char 窗口，0 命中`);
  console.log(out.join("\n"));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1; // 不直接 exit（exit 会跳过 finally 清理）
  })
  .finally(() => {
    cleanup(); // 109 · C0：正常/异常路径统一清理自建副本
  });
