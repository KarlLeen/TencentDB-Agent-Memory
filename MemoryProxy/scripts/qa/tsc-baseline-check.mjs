#!/usr/bin/env node
/**
 * BP2 —— tsc 基线机检（fork 本地，不碰上游）。
 *
 * 动机：`npm run typecheck`（tsc --noEmit）当前稳定报若干错、全部落在历史基线文件。
 * 此前靠手工 diff 清单维护 —— 新代码一旦引入基线外错误没人拦。本脚本把"允许错"固化为
 * 两级清单（tsc-baseline.json）：
 *
 *   - `allow`：历史基线既有的 file|code。出现清单外的错误（新文件 / 已清文件 / 新错误码）
 *     → **非零退出**并逐行列出 `UNALLOWED`。
 *   - `warn`（94 · 两级化）：**已裁定降级为警告**的条目（每条须在 `warnNotes` 点名出处）。
 *     命中 ⇒ 逐行以 `WARN  ` 前缀打印（**保留可见**）但不判红；归属在本仓之外的长期项
 *     不应每轮阻塞（信号仍在，噪声不再）。
 *   - 清单内某条错误不再出现（变少/修复）→ note 提示收紧；确认后用 --update 重写。
 *     **--update 保留 `warn` / `warnNotes` 段，且不得把 warn 键收编进 `allow`**
 *     （否则"收紧"会把警告吃掉）。
 *
 * 用法：
 *   npm run typecheck:baseline          # 断言：无清单外错误（allow + warn 之外 ⇒ FAIL）
 *   npm run typecheck:baseline:update   # 用当前 tsc 输出重建 allow（warn 段原样保留）
 *
 * 注意：它是"禁止回退"门禁，不是修复工具 —— 修真实类型错误的正确姿势仍是一次改干净后
 * 用 --update 收紧对应条目（期望该文件整体从清单消失）。
 *
 * 94 · C1：分类逻辑抽成**纯函数**（`classify` / `buildAllow` / `countLines`）供单测直接导入；
 * 脚本本体在 **main 守卫**下执行（被 import 时无副作用）。
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const BASELINE_URL = new URL("tsc-baseline.json", import.meta.url);
const BASELINE_PATH = fileURLToPath(BASELINE_URL);
const tscCli = require.resolve("typescript/lib/tsc.js");
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const NOTE =
  "允许错清单（BP2，两级）。allow = 历史基线文件既有错误码（新增即 fail）；warn = 已裁定降级为警告的条目" +
  "（保留可见、不阻塞，出处见 warnNotes）。修复后用 `npm run typecheck:baseline:update` 收紧（warn 段保留）。";

/** 把 {allow, warn} 两个文件→码 段展开成 "file|code" 集合。 */
function keysOf(section) {
  const out = new Set();
  for (const [file, codes] of Object.entries(section ?? {})) {
    for (const code of codes) out.add(`${file}|${code}`);
  }
  return out;
}

/**
 * 94 · C1 纯函数：errors（"file|code" → 原始行数组）按两级清单分类。
 * 返回：allowed / warned / offenders（判红集合）/ staleAllow / staleWarn（清单在而 tsc 不报）。
 */
export function classify(errorsByKey, baseline) {
  const allow = keysOf(baseline?.allow);
  const warn = keysOf(baseline?.warn);
  const allowed = [];
  const warned = [];
  const offenders = [];
  for (const key of errorsByKey.keys()) {
    if (allow.has(key)) allowed.push(key);
    else if (warn.has(key)) warned.push(key);
    else offenders.push(key);
  }
  const staleAllow = [...allow].filter((k) => !errorsByKey.has(k));
  const staleWarn = [...warn].filter((k) => !errorsByKey.has(k));
  return { allowed, warned, offenders, staleAllow, staleWarn };
}

/** 口径：total errors = 原始 tsc 行数（不是 file|code 条目数）。 */
export function countLines(errorsByKey, keys) {
  let n = 0;
  for (const k of keys) n += (errorsByKey.get(k) ?? []).length;
  return n;
}

/** 94 · C3：--update 的 allow 重建（**排除 warn 键** ⇒ 警告不被收编）；稳定排序。 */
export function buildAllow(errorsByKey, warnKeys) {
  const allow = {};
  for (const key of errorsByKey.keys()) {
    if (warnKeys.has(key)) continue;
    const [file, code] = key.split("|");
    (allow[file] ??= []).push(code);
  }
  for (const file of Object.keys(allow)) {
    allow[file].sort();
  }
  return Object.fromEntries(Object.entries(allow).sort((a, b) => a[0].localeCompare(b[0])));
}

/** 解析 "src/xxx.ts(L,C): error TSxxxx: msg" → Map("file|code" → [raw lines])。 */
export function parseTscErrors(out) {
  const rawLines = out.split(/\r?\n/).filter((l) => l.includes(" error "));
  const errors = new Map();
  for (const line of rawLines) {
    const m = /^([^(\n]+)\(\d+,\d+\): error (TS\d+):/.exec(line.trim());
    if (!m) continue;
    const key = `${m[1]}|${m[2]}`;
    if (!errors.has(key)) errors.set(key, []);
    errors.get(key).push(line.trim());
  }
  return errors;
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function writeBaseline(allow, prev) {
  const doc = {
    schema: 1,
    command: "tsc --noEmit",
    note: NOTE,
    generatedAt: new Date().toISOString().slice(0, 10),
    allow,
  };
  // 94 · C3：warn / warnNotes 原样保留（--update 不得吃掉警告）。
  if (prev?.warn !== undefined) doc.warn = prev.warn;
  if (prev?.warnNotes !== undefined) doc.warnNotes = prev.warnNotes;
  writeFileSync(BASELINE_PATH, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

function main() {
  const update = process.argv.includes("--update");
  const pretty = process.argv.includes("--verbose");

  const run = spawnSync(process.execPath, [tscCli, "--noEmit", "--pretty", "false"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const out = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const errors = parseTscErrors(out);

  if (update) {
    const prev = readBaseline();
    const warnKeys = keysOf(prev?.warn);
    const allow = buildAllow(errors, warnKeys);
    writeBaseline(allow, prev);
    const total = countLines(errors, [...errors.keys()]);
    console.log(
      `tsc-baseline: wrote allow-list for ${Object.keys(allow).length} files (${total} errors); ` +
        `warn entries preserved: ${warnKeys.size}`,
    );
    process.exit(0);
  }

  const baseline = readBaseline();
  if (!baseline) {
    console.error("tsc-baseline: missing tsc-baseline.json — run `npm run typecheck:baseline:update` first");
    process.exit(2);
  }
  const { allowed, warned, offenders, staleAllow, staleWarn } = classify(errors, baseline);

  let shown = 0;
  for (const key of offenders) {
    shown += 1;
    if (pretty || shown <= 25) for (const l of errors.get(key) ?? []) console.error(`UNALLOWED  ${l}`);
    else if (shown === 26) console.error("UNALLOWED  …(更多省略，去掉 --verbose 前 25 条后不再展开)");
  }
  // 94 · C2：warned 逐行打印（"警告信号"的定义 = 保留可见，不得静默）。
  for (const key of warned) {
    for (const l of errors.get(key) ?? []) console.log(`WARN  ${l}`);
  }
  // 清单在而实际已不存在的条目 → 提示收紧（allow / warn 两侧同口径）。
  for (const key of staleAllow) {
    console.log(`note: baseline allows ${key} but tsc no longer reports it — run update to tighten`);
  }
  for (const key of staleWarn) {
    console.log(`note: baseline warns ${key} but tsc no longer reports it — run update to tighten`);
  }

  const total = countLines(errors, [...errors.keys()]);
  if (offenders.length > 0) {
    console.error(
      `tsc-baseline: FAIL — ${offenders.length} file|code outside allow-list (total ${total} errors). Fix or (if intentional) re-baseline.`,
    );
    process.exit(1);
  }
  const nAllowed = countLines(errors, allowed);
  const nWarned = countLines(errors, warned);
  console.log(
    `tsc-baseline: PASS — ${total} errors (${nAllowed} allowed + ${nWarned} warned), 0 outside allow-list`,
  );
  process.exit(0);
}

// 94 · C1：main 守卫 —— 被单测 import 时不执行本体的任何副作用。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
