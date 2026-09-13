/**
 * `139` · 可见文本归档**两侧对账**入口（只读、只元数据、可复跑）。
 *
 * 用途：把"**静静漏掉**"变成一条命令看得见 —— 对每个有 `injection.hook.done` 的会话，并排打印
 *   `hook.done 事件数` ↔ `block_seen 行数` ↔ `判定侧候选数（可测 / 不可测）`；
 *   并**点名**"有 hook.done 而 block_seen = 0"的会话（归档缺口清单）。
 *
 * 用法（在 MemoryProxy/ 下）：
 *   npx tsx scripts/qa/visible-archive-coverage.ts             # 真库 .backup 副本只读；退出清理
 *   npx tsx scripts/qa/visible-archive-coverage.ts --db <path> # 指定 SQLite（默认真库）
 *
 * 两种 0 可分（同 `137` 落空报告精神）：
 *   · 归档 > 0 而候选 = 0 ⇒ **可见但无引用**（可测的 0）；
 *   · 归档 = 0 ⇒ 候选**不可度量**（`unknown` 哨兵）⇒ **观测面缺口**，不是"没有引用"。
 *
 * 边界（`139 §5`）：**不造正例**、不改任何门槛/判定；只读副本；绝不落正文（输出经 `[privacy]` 闸）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

interface SessionRow {
  session_key: string;
  hookDone: number;
  events: number;
  seenRows: number;
  candNum: number;
  candUnk: number;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dbIdx = argv.indexOf("--db");
  const dbArg = dbIdx >= 0 ? argv[dbIdx + 1] : undefined;

  const realDefault = path.join(os.homedir(), ".tdai-memory-proxy", "proxy.db");
  const srcDb = dbArg ?? realDefault;
  if (!fs.existsSync(srcDb)) fail(`找不到库：${srcDb}（真库不存在时请用 --db 指定副本）`);
  let workDb = srcDb;
  if (!dbArg) {
    workDb = path.join(os.tmpdir(), `visible-archive-coverage-${process.pid}.db`);
    execFileSync("sqlite3", [srcDb, `.backup ${workDb}`]);
    cleanupWorkDb = workDb; // 109 · C0：退出即清理（副本含真库内容）
    console.log(`[db] 真库已 .backup 到副本：${workDb}（真库全程只读；退出即清理副本）`);
  }
  process.env.PROXY_DB_PATH = workDb; // 只碰副本

  const { getDb } = await import("../../src/db/index.js");
  const db = getDb();
  if (!db) fail("getDb() 返回 null（库打不开）");

  const sessions = new Map<string, SessionRow>();
  const ensure = (k: string): SessionRow => {
    let r = sessions.get(k);
    if (!r) {
      r = { session_key: k, hookDone: 0, events: 0, seenRows: 0, candNum: 0, candUnk: 0 };
      sessions.set(k, r);
    }
    return r;
  };

  // ① 事件侧：每会话 总事件数 + hook.done 数
  for (const r of db
    .prepare(
      "SELECT session_key, COUNT(*) AS n, SUM(CASE WHEN event_type = 'injection.hook.done' THEN 1 ELSE 0 END) AS hd" +
        " FROM attribution_events WHERE session_key IS NOT NULL GROUP BY session_key",
    )
    .all() as Array<{ session_key: string; n: number; hd: number }>) {
    const s = ensure(r.session_key);
    s.events = r.n;
    s.hookDone = r.hd ?? 0;
  }
  // ② 归档侧：每会话 block_seen 行数
  for (const r of db
    .prepare("SELECT session_key, COUNT(*) AS n FROM attribution_block_seen WHERE session_key IS NOT NULL GROUP BY session_key")
    .all() as Array<{ session_key: string; n: number }>) {
    ensure(r.session_key).seenRows = r.n;
  }
  // ③ 判定侧：每会话候选数（可测 / 不可测；只读影子数组，不落正文）
  for (const r of db
    .prepare("SELECT session_key, detail_json FROM attribution_judgement_details WHERE session_key IS NOT NULL")
    .all() as Array<{ session_key: string; detail_json: string }>) {
    let detail: Record<string, unknown>;
    try {
      detail = JSON.parse(r.detail_json) as Record<string, unknown>;
    } catch {
      continue; // 非 JSON 行跳过（不猜；139 只对账，不修数据）
    }
    const sh = detail["citationMetricsShadow"];
    if (!Array.isArray(sh)) continue;
    const s = ensure(r.session_key);
    for (const raw of sh) {
      const v = ((raw ?? {}) as Record<string, unknown>)["shadowBestContiguousRunNorm"];
      if (v === "unknown") s.candUnk += 1;
      else if (typeof v === "number" && Number.isFinite(v)) s.candNum += 1;
    }
  }

  const all = [...sessions.values()].sort((a, b) => b.hookDone - a.hookDone || b.events - a.events || a.session_key.localeCompare(b.session_key));
  const gaps = all.filter((s) => s.hookDone > 0 && s.seenRows === 0);
  const gapHook = gaps.reduce((a, s) => a + s.hookDone, 0);
  const gapEvents = gaps.reduce((a, s) => a + s.events, 0);

  const out: string[] = [];
  const pad = (v: string, n: number): string => v + " ".repeat(Math.max(0, n - v.length));

  out.push(`[scan] 会话并集 = ${all.length}（来源：attribution_events ∪ attribution_block_seen ∪ 判定行）`);
  out.push("");
  out.push("—— 两侧对账（注入侧 hook.done ↔ 归档侧 block_seen ↔ 判定侧候选）——");
  out.push(`  ${pad("session_key", 34)}${pad("hook.done", 10)}${pad("事件数", 8)}${pad("block_seen", 12)}候选(可测/不可测)`);
  for (const s of all) {
    out.push(
      `  ${pad(s.session_key, 34)}${pad(String(s.hookDone), 10)}${pad(String(s.events), 8)}${pad(String(s.seenRows), 12)}${s.candNum} / ${s.candUnk}`,
    );
  }
  out.push("");
  out.push("—— ⚠ 归档缺口清单（hook.done > 0 而 block_seen = 0）——");
  if (gaps.length === 0) {
    out.push("  （无 —— 所有有 hook.done 的会话都有归档行）");
  } else {
    for (const s of gaps) out.push(`  · ${s.session_key}（hook.done ${s.hookDone} / 事件 ${s.events}）`);
    out.push(`  ⇒ 共 ${gaps.length} 个会话 / hook.done ${gapHook} / 事件 ${gapEvents}`);
  }
  out.push("");
  out.push("—— 两种 0 可分（本入口要钉的）——");
  {
    const measurable = all.filter((s) => s.seenRows > 0 && s.candNum > 0);
    const visibleNoRef = all.filter((s) => s.seenRows > 0 && s.candNum === 0 && s.candUnk === 0);
    const unmeasurable = all.filter((s) => s.seenRows === 0 && s.candUnk > 0);
    out.push(`  · 归档 > 0 且候选可测：${measurable.map((s) => s.session_key).join(", ") || "（无）"}`);
    out.push(`  · 归档 > 0 而候选 = 0 ⇒ 可见但无引用（可测的 0）：${visibleNoRef.map((s) => s.session_key).join(", ") || "（无）"}`);
    out.push(
      `  · 归档 = 0 而候选 > 0 ⇒ **不可度量**（unknown 哨兵）= 观测面缺口，非"没有引用"：` +
        `${unmeasurable.map((s) => `${s.session_key}（${s.candUnk} 条全 unknown）`).join(", ") || "（无）"}`,
    );
  }
  const candNum = all.reduce((a, s) => a + s.candNum, 0);
  const candUnk = all.reduce((a, s) => a + s.candUnk, 0);
  const seenTotal = all.reduce((a, s) => a + s.seenRows, 0);
  out.push(
    `[account] 会话=${all.length} | 缺口会话=${gaps.length}（hook.done ${gapHook} / 事件 ${gapEvents}）` +
      ` | 归档行=${seenTotal} | 候选=${candNum + candUnk}（可测 ${candNum} / 不可测 ${candUnk}）`,
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
