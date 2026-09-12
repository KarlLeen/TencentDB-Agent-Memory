/**
 * 108 · 影子标定台**可复跑入口**（(d)-1c；只记录、不改判定）。
 *
 * 用法（在 MemoryProxy/ 下）：
 *   npx tsx scripts/qa/shadow-calibration.ts            # 校验模式：与夹具 expected 逐数字对照（不一致 ⇒ exit 1）
 *   npx tsx scripts/qa/shadow-calibration.ts --record   # 记录模式：实测数字写回夹具 expected（先 diff 再提交）
 *   npx tsx scripts/qa/shadow-calibration.ts --db <path># 指定 SQLite（默认对真库 .backup 副本只读，绝不写真库）
 *
 * 复现内容：107 三组分布（真库负例 / hard negatives ×4 类 / 构造正例）逐数字 + L_MIN 扫描
 * + 108 新读数（连续重合轴 / 引号·代码跨度计数 / n × minIdf 扫描）。夹具见
 * `src/attribution/citation/__tests__/fixtures/shadow-calibration-cases.json`（资产以行号+sha16 引用，不放正文）。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL("../../src/attribution/citation/__tests__/fixtures/shadow-calibration-cases.json", import.meta.url),
);

type Generator =
  | { op: "item"; index: number }
  | { op: "itemSlice"; index: number; ratio: number }
  | { op: "rewriteItem"; index: number; ops: Array<{ replaceAll: [string, string] }> }
  | { op: "itemWordReverse"; index: number }
  | { op: "itemPunctRewrite"; index: number; replacePairs: Array<[string, string]>; suffix: string };

interface SampleExpected {
  join: number | null;
  perMsg: number | null;
  runChars: number | null;
  runNorm: number | null;
  quotedSpanCount: number | null;
  quotedSpanMaxChars: number | null;
}

const sha16 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);
const n3 = (x: number | "unknown" | null): number | null =>
  typeof x === "number" && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
const fmt3 = (x: number | null): string => (x === null ? "—" : x.toFixed(3));

/** 109 · C0：自建副本（含真库内容）⇒ 任何退出路径都必须清理。
 *  三件套：主库 + `-wal`/`-shm`（WAL 辅助文件同样含库页；进程退出无 clean close 时会留存）。 */
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const record = argv.includes("--record");
  const dbIdx = argv.indexOf("--db");
  const dbArg = dbIdx >= 0 ? argv[dbIdx + 1] : undefined;

  const realDefault = path.join(os.homedir(), ".tdai-memory-proxy", "proxy.db");
  const srcDb = dbArg ?? realDefault;
  if (!fs.existsSync(srcDb)) fail(`找不到库：${srcDb}（真库不存在时请用 --db 指定副本）`);
  let workDb = srcDb;
  if (!dbArg) {
    workDb = path.join(os.tmpdir(), `shadow-calibration-${process.pid}.db`);
    execFileSync("sqlite3", [srcDb, `.backup ${workDb}`]);
    cleanupWorkDb = workDb; // 109 · C0：退出即清理（副本含真库内容）
    console.log(`[db] 真库已 .backup 到副本：${workDb}（真库全程只读；退出即清理副本 —— 109 C0）`);
  }
  process.env.PROXY_DB_PATH = workDb;

  const { getDb } = await import("../../src/db/index.js");
  const { shadowGradeCandidates } = await import("../../src/attribution/citation/shadow-grading.js");
  const { getCitationSourceProvider } = await import("../../src/attribution/citation/source.js");
  const { buildRarityTable, charNgrams } = await import("../../src/attribution/citation/ngram.js");
  const { stripRenderWrappers } = await import("../../src/attribution/citation/wrapper-registry.js");

  const db = getDb();
  if (!db) fail("getDb() 返回 null（库打不开）");

  const fixtureRaw = fs.readFileSync(FIXTURE_PATH, "utf8");
  const fixture = JSON.parse(fixtureRaw) as {
    dbSeed: {
      blockContentId: number;
      items: Array<{ index: number; sha16: string; note?: string }>;
      offlineCorpus: string[];
      trueNegatives: Array<{ jid: string; sessionKey: string; turnSeq: number }>;
    };
    hardNegatives: Array<{ id: string; kind: string; synthetic: boolean; messages?: string[]; generators?: Generator[] }>;
    positives: Array<{ itemIndex: number; shapes: Array<{ shape: string; generator: Generator }> }>;
    lMinScan: { values: number[] };
    nMinIdfScan: { nValues: number[]; minIdfValues: number[] };
    expected: unknown;
  };

  // ── 隐私卫生检查（R2 机制）：夹具不得出现真库正文的 ≥64 连续字符窗口 ──
  const bodies: string[] = [];
  for (const r of db.prepare("SELECT content_utf8 FROM attribution_block_text").all() as Array<{
    content_utf8: string;
  }>) bodies.push(r.content_utf8);
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
  let windows = 0;
  for (const body of bodies) {
    for (let i = 0; i + 64 <= body.length; i += 1) {
      windows += 1;
      const w = body.slice(i, i + 64);
      if (fixtureRaw.includes(w)) fail(`夹具卫生检查红：出现真库正文 ≥64 连续字符窗口：${JSON.stringify(w.slice(0, 24))}…`);
    }
  }
  console.log(`[privacy] 夹具卫生检查通过：${bodies.length} 条真库文本 / ${windows} 个 64-char 窗口，0 命中`);

  // ── 取块文本条目行（与 107 完全同法）＋夹具锚点校验 ──
  const blockRow = db
    .prepare("SELECT content_utf8 FROM attribution_block_text WHERE content_id = ?")
    .get(fixture.dbSeed.blockContentId) as { content_utf8: string } | undefined;
  if (!blockRow) fail(`块文本缺失（content_id=${fixture.dbSeed.blockContentId}）`);
  const blockText = blockRow.content_utf8;
  const items = blockText
    .slice(blockText.indexOf("<available_skills>") + 19, blockText.indexOf("</available_skills>"))
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => stripRenderWrappers(l).text)
    .filter((l) => l.length >= 16);
  for (const ref of fixture.dbSeed.items) {
    const got = sha16(items[ref.index] ?? "");
    if (got !== ref.sha16) {
      fail(
        `夹具锚点漂移：items[${ref.index}] sha16=${got} ≠ pinned ${ref.sha16}` +
          `（真库块文本已变——数字不可直接沿用，需人工复核后刷新夹具）`,
      );
    }
  }
  console.log(`[anchor] ${fixture.dbSeed.items.length} 条资产行 sha16 与夹具逐字一致（无漂移）`);
  const OFFLINE = fixture.dbSeed.offlineCorpus;
  const TARGET = items[0]!;

  // ── 执行装置（与 107 语义一致：表 = [assetLine, ...offlineCorpus]）──
  const candOf = (id: string) => ({ assetId: id, assetType: "skill", evidenceSourceType: "injected" });
  function runOne(msg: string, assetLine: string, opts: { lMin?: number; minIdf?: number; tableN?: number } = {}) {
    const pieces = [
      {
        epoch: null,
        turnSeq: 1,
        tier: "message" as const,
        seq: 0,
        source: "calibration",
        contentHash: "h0",
        content: JSON.stringify(msg),
        truncated: false,
        chars: msg.length,
        role: null,
        blockIdx: null,
      },
    ];
    const m = shadowGradeCandidates({
      sessionKey: "calibration",
      turnSeq: 1,
      candidates: [candOf("skl-target")],
      source: {
        sessionWindow: () => ({ epoch: null, pieces }),
        sessionAssetTexts: () => new Map([["skl-target", [assetLine]]]),
        rarityTable: () => buildRarityTable([assetLine, ...OFFLINE], opts.tableN ? { n: opts.tableN } : {}),
        excludedCategories: () => [],
      },
      ...(opts.lMin === undefined ? {} : { lMin: opts.lMin }),
      ...(opts.minIdf === undefined ? {} : { minIdf: opts.minIdf }),
    })[0]!;
    return m;
  }
  const sampleOf = (m: ReturnType<typeof runOne>): SampleExpected => ({
    join: n3(m.shadowBestSegCoverage),
    perMsg: n3(m.shadowBestSegCoveragePerMsg),
    runChars: typeof m.shadowBestContiguousRunChars === "number" ? m.shadowBestContiguousRunChars : null,
    runNorm: n3(m.shadowBestContiguousRunNorm),
    quotedSpanCount: m.shadowQuotedSpanCount,
    quotedSpanMaxChars: m.shadowQuotedSpanMaxChars,
  });
  function materialize(g: Generator): string {
    if (g.op === "item") return items[g.index]!;
    if (g.op === "itemSlice") {
      const l = items[g.index]!;
      return l.slice(0, Math.max(16, Math.floor(l.length * g.ratio)));
    }
    if (g.op === "rewriteItem") {
      let s = items[g.index]!;
      for (const o of g.ops) s = s.split(o.replaceAll[0]).join(o.replaceAll[1]);
      return s;
    }
    if (g.op === "itemWordReverse") return items[g.index]!.split(" ").reverse().join(" ");
    let s = items[g.index]!;
    for (const [a, b] of g.replacePairs) s = s.split(a).join(b);
    return s + g.suffix;
  }
  const tri = (s: string) => new Set(charNgrams(s, 3));
  const trigramOverlap = (a: string, b: string): number => {
    const A = tri(a);
    const B = tri(b);
    let n = 0;
    for (const g of A) if (B.has(g)) n += 1;
    return n;
  };

  // ── ① 真库负例（5 条）──
  const realSource = getCitationSourceProvider();
  console.log("");
  console.log("════ ① 真库负例（5 条；join / PerMsg / run）════");
  const trueNegatives: Array<Record<string, unknown>> = [];
  for (const seed of fixture.dbSeed.trueNegatives) {
    const row = db
      .prepare("SELECT detail_json FROM attribution_judgement_details WHERE judgement_id = ?")
      .get(seed.jid) as { detail_json: string } | undefined;
    if (!row) fail(`真库负例缺失：${seed.jid}（judgement_details 无此行）`);
    const detail = JSON.parse(row.detail_json) as { citationMetrics?: Array<{ assetId: string }> };
    const ms = shadowGradeCandidates({
      sessionKey: seed.sessionKey,
      turnSeq: seed.turnSeq,
      candidates: (detail.citationMetrics ?? []).map((c) => candOf(c.assetId)),
      source: realSource,
    });
    const nums = (f: (m: (typeof ms)[number]) => number | "unknown"): number[] =>
      ms.map(f).filter((x): x is number => typeof x === "number");
    const entry = {
      jid: seed.jid,
      n: ms.length,
      joinMax: n3(nums((m) => m.shadowBestSegCoverage).length ? Math.max(...nums((m) => m.shadowBestSegCoverage)) : null),
      perMsgMax: n3(nums((m) => m.shadowBestSegCoveragePerMsg).length ? Math.max(...nums((m) => m.shadowBestSegCoveragePerMsg)) : null),
      runCharsMax: nums((m) => m.shadowBestContiguousRunChars).length ? Math.max(...nums((m) => m.shadowBestContiguousRunChars)) : null,
      runNormMax: n3(nums((m) => m.shadowBestContiguousRunNorm).length ? Math.max(...nums((m) => m.shadowBestContiguousRunNorm)) : null),
      numericJoinCount: nums((m) => m.shadowBestSegCoverage).length,
    };
    trueNegatives.push(entry);
    console.log(
      `  ${seed.jid}: join[${fmt3(entry.joinMax as number | null)}] perMsg[${fmt3(entry.perMsgMax as number | null)}] ` +
        `run[${entry.runCharsMax ?? "—"} / ${fmt3(entry.runNormMax as number | null)}] n=${entry.n}`,
    );
  }
  const tnegJoin = trueNegatives.flatMap((e) => (e.joinMax === null ? [] : [e.joinMax as number]));
  const tnegRun = trueNegatives.flatMap((e) => (e.runNormMax === null ? [] : [e.runNormMax as number]));
  const tnegJoinFlatCount = trueNegatives.reduce((acc, e) => acc + (e.numericJoinCount as number), 0);
  console.log(
    `  真库负例合计: join max=${tnegJoin.length ? Math.max(...tnegJoin).toFixed(3) : "—"}（${tnegJoinFlatCount} 数字）` +
      ` | runNorm max=${tnegRun.length ? Math.max(...tnegRun).toFixed(3) : "—"}`,
  );

  // ── ② hard negatives（4 类 × 3）＋ ③ 构造正例（3 行 × 3 形状）──
  const hardNegatives: Array<Record<string, unknown>> = [];
  const hnJoinAll: number[] = [];
  const hnRunNormAll: number[] = [];
  const hnRunNormByClass: Record<string, number[]> = {};
  console.log("");
  console.log("════ ② hard negatives（4 类 × 3 样本；join / PerMsg / run（chars｜norm））════");
  for (const hn of fixture.hardNegatives) {
    const msgs = hn.messages ?? hn.generators!.map(materialize);
    const samples = msgs.map((msg) => sampleOf(runOne(msg, TARGET)));
    const runNorms = samples.flatMap((s) => (s.runNorm === null ? [] : [s.runNorm]));
    hnRunNormByClass[hn.id] = runNorms;
    hnJoinAll.push(...samples.flatMap((s) => (s.join === null ? [] : [s.join])));
    hnRunNormAll.push(...runNorms);
    const shown = samples
      .map((s) => `${fmt3(s.join)}/${fmt3(s.perMsg)}/${s.runChars ?? "—"}｜${fmt3(s.runNorm)}`)
      .join(", ");
    console.log(`  [${hn.id} ${hn.kind}] trigram∩目标行=${trigramOverlap(msgs[0]!, TARGET)} | ${shown}`);
    hardNegatives.push({ id: hn.id, kind: hn.kind, samples });
  }
  const hnJoinMax = hnJoinAll.length ? Math.max(...hnJoinAll) : 0;
  const hnRunNormMax = hnRunNormAll.length ? Math.max(...hnRunNormAll) : 0;
  console.log(`  HN 合计: join max=${hnJoinMax.toFixed(3)} | runNorm max=${hnRunNormMax.toFixed(3)}`);

  const positives: Array<Record<string, unknown>> = [];
  const posJoinAll: number[] = [];
  const posRunNormAll: number[] = [];
  console.log("");
  console.log("════ ③ 构造正例（3 形状 × 3 行；join / PerMsg / run）════");
  for (const pos of fixture.positives) {
    const line = items[pos.itemIndex]!;
    const shapes: Array<Record<string, unknown>> = [];
    for (const shape of pos.shapes) {
      const msg = materialize(shape.generator);
      const s = sampleOf(runOne(msg, line));
      shapes.push({ shape: shape.shape, ...s });
      posJoinAll.push(...(s.join === null ? [] : [s.join]));
      posRunNormAll.push(...(s.runNorm === null ? [] : [s.runNorm]));
      console.log(
        `  [行${pos.itemIndex} ${shape.shape}] join=${fmt3(s.join)} perMsg=${fmt3(s.perMsg)} ` +
          `run=${s.runChars ?? "—"}｜${fmt3(s.runNorm)} spans=${s.quotedSpanCount}/${s.quotedSpanMaxChars}`,
      );
    }
    positives.push({ itemIndex: pos.itemIndex, shapes });
  }
  const posJoinMin = posJoinAll.length ? Math.min(...posJoinAll) : NaN;
  const posRunNormMin = posRunNormAll.length ? Math.min(...posRunNormAll) : NaN;

  // ── ④ L_MIN 扫描（107 复核面）──
  console.log("");
  console.log("════ ④ L_MIN 敏感性（16/8/32；负例 3 条 covMax + 正例整行 cov）════");
  const lMinScan: Array<Record<string, unknown>> = [];
  for (const lMin of fixture.lMinScan.values) {
    const neg: Array<number | null> = [];
    for (const seed of fixture.dbSeed.trueNegatives.slice(0, 3)) {
      const row = db
        .prepare("SELECT detail_json FROM attribution_judgement_details WHERE judgement_id = ?")
        .get(seed.jid) as { detail_json: string } | undefined;
      const detail = JSON.parse(row!.detail_json) as { citationMetrics?: Array<{ assetId: string }> };
      const ms = shadowGradeCandidates({
        sessionKey: seed.sessionKey,
        turnSeq: seed.turnSeq,
        candidates: (detail.citationMetrics ?? []).map((c) => candOf(c.assetId)),
        source: realSource,
        lMin,
      });
      const nums = ms.map((m) => m.shadowBestSegCoverage).filter((x): x is number => typeof x === "number");
      neg.push(n3(nums.length ? Math.max(...nums) : null));
    }
    const pos = sampleOf(runOne(items[0]!, items[0]!, { lMin }));
    lMinScan.push({ lMin, negJoinMax: neg, posJoin: pos.join, posRunNorm: pos.runNorm });
    console.log(`  L_MIN=${lMin}: 负例 covMax=[${neg.map((x) => x ?? "—").join(", ")}] | 正例(整行) cov=${pos.join ?? "u"} runNorm=${pos.runNorm ?? "u"}`);
  }

  // ── ⑤ 107 分离读数 + ⑥ 108 连续重合轴结论 ──
  console.log("");
  console.log("════ ⑤ 107 复现读数（coverage 轴；只报数）════");
  console.log(
    `  真库负例 max=${tnegJoin.length ? Math.max(...tnegJoin).toFixed(3) : "—"} | HN max=${hnJoinMax.toFixed(3)} | 正例 min=${Number.isNaN(posJoinMin) ? "—" : posJoinMin.toFixed(3)}`,
  );
  const coverageOverlap = !Number.isNaN(posJoinMin) && hnJoinMax >= posJoinMin;
  console.log(
    coverageOverlap
      ? `  ⇒ 重叠区 [${posJoinMin.toFixed(3)}, ${hnJoinMax.toFixed(3)}] ⇒ 当前 (d2)-coverage 口径在 hard negatives 上**不可分**（与 107 一致）`
      : `  ⇒ 无重叠：T_COV ∈ (${hnJoinMax.toFixed(3)}, ${posJoinMin.toFixed(3)}]`,
  );
  console.log("");
  console.log("════ ⑥ 108 连续重合轴（run；只报数）════");
  console.log(`  HN runNorm max=${hnRunNormMax.toFixed(3)}（各类: ${Object.entries(hnRunNormByClass).map(([k, v]) => `${k}=${v.length ? Math.max(...v).toFixed(3) : "—"}`).join(" ")}）`);
  console.log(`  正例 runNorm min=${Number.isNaN(posRunNormMin) ? "—" : posRunNormMin.toFixed(3)} | 真库负例 runNorm max=${tnegRun.length ? Math.max(...tnegRun).toFixed(3) : "—"}`);
  const runOverlap = !Number.isNaN(posRunNormMin) && hnRunNormMax >= posRunNormMin;
  if (runOverlap) {
    console.log(
      `  ⇒ 重叠区 [${posRunNormMin.toFixed(3)}, ${hnRunNormMax.toFixed(3)}] ⇒ 连续重合轴**也不能分开** ` +
        `⇒ 按 108 结论口径明写：**(d2) 路线不能单独定案**（回 103 D6 重选；不得用调阈值掩盖）`,
    );
  } else {
    console.log(
      `  ⇒ 无重叠：新分离区间 T_RUN ∈ (${hnRunNormMax.toFixed(3)}, ${posRunNormMin.toFixed(3)}]（只报数；供 (d)-2 参考）`,
    );
  }

  // ── ⑦ 标记计数（C4）──
  console.log("");
  console.log("════ ⑦ 引号 / 代码跨度计数（消息侧；只报数）════");
  const markerRows: Array<Record<string, unknown>> = [];
  for (const hn of fixture.hardNegatives) {
    for (const msg of hn.messages ?? hn.generators!.map(materialize)) {
      const m = runOne(msg, TARGET);
      markerRows.push({ group: hn.id, count: m.shadowQuotedSpanCount, maxChars: m.shadowQuotedSpanMaxChars });
      console.log(`  [${hn.id}] spans=${m.shadowQuotedSpanCount} maxChars=${m.shadowQuotedSpanMaxChars}`);
    }
  }

  // ── ⑧ n × minIdf 扫描（C3；perMsg 口径）──
  console.log("");
  console.log("════ ⑧ n × minIdf 扫描（回答「增大 n 能否把改写与引用分开」；perMsg 口径）════");
  const scan: Array<Record<string, unknown>> = [];
  for (const nv of fixture.nMinIdfScan.nValues) {
    for (const idf of fixture.nMinIdfScan.minIdfValues) {
      const hn3 = fixture.hardNegatives
        .find((h) => h.id === "HN3")!
        .generators!.map((g) => sampleOf(runOne(materialize(g), TARGET, { tableN: nv, minIdf: idf })));
      const hn3Max = Math.max(...hn3.flatMap((s) => (s.perMsg === null ? [] : [s.perMsg])));
      const pos = fixture.positives.flatMap((p) =>
        p.shapes.map((sh) => sampleOf(runOne(materialize(sh.generator), items[p.itemIndex]!, { tableN: nv, minIdf: idf }))),
      );
      const posMin = Math.min(...pos.flatMap((s) => (s.perMsg === null ? [] : [s.perMsg])));
      const separable = Number.isFinite(hn3Max) && Number.isFinite(posMin) && hn3Max < posMin;
      scan.push({ n: nv, minIdf: idf, hn3Max: n3(hn3Max), posMin: n3(posMin), separable });
      console.log(
        `  n=${nv} minIdf=${idf}: HN3 max=${Number.isFinite(hn3Max) ? hn3Max.toFixed(3) : "u"} ` +
          `| 正例 min=${Number.isFinite(posMin) ? posMin.toFixed(3) : "u"} ⇒ ${separable ? "可分" : "不可分/重叠"}`,
      );
    }
  }
  console.log("");
  console.log("如实标注：hard negatives / 构造正例均为**合成**（取材真库块文本 + 合成消息）；构造正例 ≠ 真实引用。");

  // ── ⑨ 109 · D6 证伪实验：A 判据（逐字连续重合 ≥ L_q）的 FP / FN / HN3 代价 ──
  const d6Path = fileURLToPath(
    new URL("../../src/attribution/citation/__tests__/fixtures/d6-falsification-cases.json", import.meta.url),
  );
  const d6Raw = fs.readFileSync(d6Path, "utf8");
  const d6 = JSON.parse(d6Raw) as {
    classes: {
      R1: { messages: string[] };
      R2: { messages: string[] };
      R3: { messages: string[] };
      R4: { rows: Array<{ msgId: number; sessionKey: string; contentHash: string; chars: number }> };
    };
    lqValues: number[];
    expected: unknown;
  };
  // 卫生：D6 夹具同样不得含真库正文（R-4 只存元数据）
  for (const body of bodies) {
    for (let i = 0; i + 64 <= body.length; i += 1) {
      if (d6Raw.includes(body.slice(i, i + 64))) {
        fail(`D6 夹具卫生检查红：出现真库正文 ≥64 连续字符窗口：${JSON.stringify(body.slice(i, i + 24))}…`);
      }
    }
  }
  const runOfContent = (content: string, source: string, assetLine: string = TARGET): number =>
    shadowGradeCandidates({
      sessionKey: "d6",
      turnSeq: 1,
      candidates: [candOf("skl-target")],
      source: {
        sessionWindow: () => ({
          epoch: null,
          pieces: [
            {
              epoch: null,
              turnSeq: 1,
              tier: "message" as const,
              seq: 0,
              source,
              contentHash: "h0",
              content,
              truncated: false,
              chars: 0,
              role: null,
              blockIdx: null,
            },
          ],
        }),
        sessionAssetTexts: () => new Map([["skl-target", [assetLine]]]),
        rarityTable: () => buildRarityTable([assetLine, ...OFFLINE]),
        excludedCategories: () => [],
      },
    })[0]!.shadowBestContiguousRunChars;
  const runOfText = (msg: string, assetLine: string = TARGET): number =>
    runOfContent(JSON.stringify(msg), "d6-synth", assetLine);
  const r4rows = d6.classes.R4.rows.map((r) => {
    const row = db.prepare("SELECT content_json FROM attribution_message_snap WHERE msg_id = ?").get(r.msgId) as
      | { content_json: string }
      | undefined;
    if (!row) fail(`R-4 行缺失：msg_id=${r.msgId}（真库已变；夹具需刷新）`);
    return { ...r, contentJson: row.content_json };
  });
  const classRuns = {
    R1: d6.classes.R1.messages.map((m) => runOfText(m)),
    R2: d6.classes.R2.messages.map((m) => runOfText(m)),
    R3: d6.classes.R3.messages.map((m) => runOfText(m)),
    R4: r4rows.map((r) => runOfContent(r.contentJson, "d6-r4")),
  };
  // FN 口径：正例消息 vs **它引用的那一行**（item0/1/2 各自的资产）
  const posFullRuns = fixture.positives.map((p) => runOfText(materialize(p.shapes[0]!.generator), items[p.itemIndex]!));
  const posHalfRuns = fixture.positives.map((p) => runOfText(materialize(p.shapes[1]!.generator), items[p.itemIndex]!));
  const hn3Runs = fixture.hardNegatives.find((h) => h.id === "HN3")!.generators!.map((g) => runOfText(materialize(g)));
  // 109 · 语料冻结校验：R1+R2+R3 messages 的指纹（构造时冻结、此后不得变）
  const corpusSha256_32 = createHash("sha256")
    .update(JSON.stringify({ R1: d6.classes.R1.messages, R2: d6.classes.R2.messages, R3: d6.classes.R3.messages }))
    .digest("hex")
    .slice(0, 32);
  const tgtSha16 = sha16(TARGET);
  const tgtRef = fixture.dbSeed.items[0]!;
  if (tgtSha16 !== tgtRef.sha16) fail(`D6 目标行锚点漂移：${tgtSha16} ≠ ${tgtRef.sha16}`);
  console.log("");
  console.log("════ ⑨ 109 · D6 证伪：A 判据（逐字连续重合 ≥ L_q）════");
  console.log(`  目标行锚点 sha16 = ${tgtSha16}（与两夹具一致）`);
  console.log(`  R1 模板异内容 run = [${classRuns.R1.join(", ")}]`);
  console.log(`  R2 同主题独立 run = [${classRuns.R2.join(", ")}]`);
  console.log(`  R3 通用句式   run = [${classRuns.R3.join(", ")}]`);
  console.log(`  R4 真实未读(${classRuns.R4.length} 条) run = [${classRuns.R4.join(", ")}]`);
  console.log(`  正例整行 run = [${posFullRuns.join(", ")}] | 半行 run = [${posHalfRuns.join(", ")}] | HN3 run = [${hn3Runs.join(", ")}]`);
  const sameTemplateRows = items.map((l, i) => ({ i, has: l.includes("Background + SOP for ") })).filter((x) => x.has).map((x) => x.i);
  console.log(`  真库 available_skills 块内『同模板前缀（Background + SOP for ）』行 = ${sameTemplateRows.length}/${items.length}（索引 [${sameTemplateRows.join(", ")}]）`);
  console.log(`  语料冻结指纹（R1+R2+R3 messages）sha256[:32] = ${corpusSha256_32}`);
  const lqScan = d6.lqValues.map((lq) => {
    const hit = (xs: number[]): number => xs.filter((x) => x >= lq).length;
    return {
      lq,
      R1: { hit: hit(classRuns.R1), n: classRuns.R1.length },
      R2: { hit: hit(classRuns.R2), n: classRuns.R2.length },
      R3: { hit: hit(classRuns.R3), n: classRuns.R3.length },
      R4: { hit: hit(classRuns.R4), n: classRuns.R4.length },
      posFullHit: hit(posFullRuns),
      posHalfHit: hit(posHalfRuns),
      hn3Hit: hit(hn3Runs),
    };
  });
  console.log("  L_q | R1 FP | R2 FP | R3 FP | R4 FP | 正例命中(整行/半行) | HN3 命中(已知代价)");
  for (const s of lqScan) {
    console.log(
      `  ${String(s.lq).padStart(3)} | ${s.R1.hit}/${s.R1.n}  ${s.R2.hit}/${s.R2.n}  ${s.R3.hit}/${s.R3.n}  ${s.R4.hit}/${s.R4.n}` +
        `   | ${s.posFullHit}/${posFullRuns.length} + ${s.posHalfHit}/${posHalfRuns.length} | ${s.hn3Hit}/${hn3Runs.length}`,
    );
  }
  const fpZeroRows = lqScan.filter((s) => s.R1.hit + s.R2.hit + s.R3.hit + s.R4.hit === 0);
  const usableRows = fpZeroRows.filter((s) => s.posFullHit + s.posHalfHit > 0);
  const verdict: string =
    usableRows.length > 0 ? "A-可用区间" : fpZeroRows.length > 0 ? "A-无可用档（FP0 档全漏正例）" : "A-挡不住噪声";
  if (verdict === "A-可用区间") {
    console.log(`  ⇒ 存在 FP 全 0 且仍接住正例的档：L_q ∈ {${usableRows.map((s) => s.lq).join(", ")}}（供拍 A；只报数）`);
  } else if (verdict === "A-无可用档（FP0 档全漏正例）") {
    console.log(
      `  ⇒ FP 全 0 的档 L_q ∈ {${fpZeroRows.map((s) => s.lq).join(", ")}} **全部漏掉正例** ⇒ 无可用档（供拍 C；只报数）`,
    );
  } else {
    const hits = lqScan.map((s) => `L_q=${s.lq}: R1=${s.R1.hit} R3=${s.R3.hit} R4=${s.R4.hit}`).join("; ");
    console.log(`  ⇒ **A 在当前真实分布上挡不住该类噪声**（每档 L_q 均有类内命中 —— ${hits}）（供拍 C）`);
  }
  const d6Actual = {
    targetSha16: tgtSha16,
    corpusSha256_32,
    sameTemplateRows,
    runs: classRuns,
    positives: { full: posFullRuns, half: posHalfRuns },
    hn3Runs,
    lqScan,
    verdict,
  };

  // ── 组装 actual / 记录或对照 ──
  const actual = {
    coverageAxis: { trueNegatives, hardNegatives, positives, lMinScan, hnJoinMax: n3(hnJoinMax), posJoinMin: n3(posJoinMin) },
    contiguousAxis: { hnRunNormMax: n3(hnRunNormMax), posRunNormMin: n3(posRunNormMin), hnByClass: hnRunNormByClass, tnegRunNormMax: n3(tnegRun.length ? Math.max(...tnegRun) : null) },
    markers: markerRows,
    nMinIdfScan: scan,
  };

  if (record) {
    const next = { ...fixture, expected: actual };
    fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    const d6Next = { ...d6, expected: d6Actual };
    fs.writeFileSync(d6Path, `${JSON.stringify(d6Next, null, 2)}\n`, "utf8");
    console.log("");
    console.log(`[record] expected 已写回夹具：${FIXTURE_PATH} + ${d6Path}（请先 git diff 人工复核再提交）`);
    return;
  }

  // 校验模式：与夹具 expected 逐数字对照
  const exp = fixture.expected as typeof actual | null;
  if (!exp) fail("夹具 expected 为空——先跑一次 --record 回填基线");
  const diffs: string[] = [];
  const cmp = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push(`${label}: 实际=${JSON.stringify(got)} ≠ 夹具=${JSON.stringify(want)}`);
  };
  cmp("coverageAxis", actual.coverageAxis, exp.coverageAxis);
  cmp("contiguousAxis", actual.contiguousAxis, exp.contiguousAxis);
  cmp("markers", actual.markers, exp.markers);
  cmp("nMinIdfScan", actual.nMinIdfScan, exp.nMinIdfScan);
  // 109：D6 夹具对照
  const d6Exp = d6.expected as typeof d6Actual | null;
  if (!d6Exp) fail("D6 夹具 expected 为空——先跑一次 --record 回填基线");
  cmp("d6.targetSha16", d6Actual.targetSha16, d6Exp.targetSha16);
  cmp("d6.corpusSha256_32", d6Actual.corpusSha256_32, d6Exp.corpusSha256_32);
  cmp("d6.sameTemplateRows", d6Actual.sameTemplateRows, d6Exp.sameTemplateRows);
  cmp("d6.runs", d6Actual.runs, d6Exp.runs);
  cmp("d6.positives", d6Actual.positives, d6Exp.positives);
  cmp("d6.hn3Runs", d6Actual.hn3Runs, d6Exp.hn3Runs);
  cmp("d6.lqScan", d6Actual.lqScan, d6Exp.lqScan);
  cmp("d6.verdict", d6Actual.verdict, d6Exp.verdict);
  console.log("");
  if (diffs.length > 0) {
    for (const d of diffs) console.error(`  DIFF ${d}`);
    fail(`与夹具不一致：${diffs.length} 处（数字已漂移——查真库/实现变更；确认无误后再 --record）`);
  }
  console.log(`[verify] 全部数字与夹具 expected 一致（含 107 三组分布 + 109 D6）✔`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1; // 不直接 exit（exit 会跳过 finally 清理）
  })
  .finally(() => {
    cleanup(); // 109 · C0：正常/异常路径统一清理自建副本
  });
