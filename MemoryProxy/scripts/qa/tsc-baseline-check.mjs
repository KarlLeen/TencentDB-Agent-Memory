#!/usr/bin/env node
/**
 * BP2 —— tsc 基线机检（fork 本地，不碰上游）。
 *
 * 动机：`npm run typecheck`（tsc --noEmit）当前稳定报 55 错、全部落在 7 个历史基线文件
 * （anthropicHandler / codexHandler / handler / workbuddyHandler / memory-bridge /
 * session/codebuddy/init / storage/factory）。此前靠手工 diff 清单维护 —— 新代码一旦
 * 引入基线外错误没人拦。本脚本把"允许错"固化为 tsc-baseline.json 允许清单：
 *
 *   - 出现清单外的错误（新文件 / 已清文件 / 既有文件新增错误码）→ 非零退出并逐行列出。
 *   - 清单内某条错误不再出现（变少/修复）→ 提示但不失败；确认后用 --update 收紧清单。
 *
 * 用法：
 *   npm run typecheck:baseline          # 断言：无清单外错误
 *   npm run typecheck:baseline:update   # 用当前 tsc 输出重写清单
 *
 * 注意：它是"禁止回退"门禁，不是修复工具 —— 修真实类型错误的正确姿势仍是一次改干净后
 * 用 --update 收紧对应条目（期望该文件整体从清单消失）。
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

const update = process.argv.includes("--update");
const pretty = process.argv.includes("--verbose");

const run = spawnSync(process.execPath, [tscCli, "--noEmit", "--pretty", "false"], {
  cwd: ROOT,
  encoding: "utf8",
});
const out = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;

// 解析 "src/xxx.ts(L,C): error TSxxxx: msg" → { file|TSxxxx → [raw lines] }
const rawLines = out.split(/\r?\n/).filter((l) => l.includes(" error "));
const errors = new Map(); // "file|code" -> [lines]
for (const line of rawLines) {
  const m = /^([^(\n]+)\(\d+,\d+\): error (TS\d+):/.exec(line.trim());
  if (!m) continue;
  const key = `${m[1]}|${m[2]}`;
  if (!errors.has(key)) errors.set(key, []);
  errors.get(key).push(line.trim());
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function writeBaseline(allow) {
  const doc = {
    schema: 1,
    command: "tsc --noEmit",
    note: "允许错清单（BP2）。只允许历史基线文件既有的错误码；新增文件/错误码立即 fail。修复后用 `npm run typecheck:baseline:update` 收紧。",
    generatedAt: new Date().toISOString().slice(0, 10),
    allow,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

if (update) {
  const allow = {};
  for (const key of errors.keys()) {
    const [file, code] = key.split("|");
    (allow[file] ??= []).push(code);
  }
  // 稳定输出：文件按路径排、码按字典序排
  for (const file of Object.keys(allow)) {
    allow[file].sort();
  }
  writeBaseline(Object.fromEntries(Object.entries(allow).sort((a, b) => a[0].localeCompare(b[0]))));
  const total = [...errors.values()].reduce((n, l) => n + l.length, 0);
  console.log(`tsc-baseline: wrote allow-list for ${errors.size} file|code entries (${total} errors)`);
  process.exit(0);
}

const baseline = readBaseline();
if (!baseline) {
  console.error("tsc-baseline: missing tsc-baseline.json — run `npm run typecheck:baseline:update` first");
  process.exit(2);
}
const allowed = new Set();
for (const [file, codes] of Object.entries(baseline.allow ?? {})) {
  for (const code of codes) allowed.add(`${file}|${code}`);
}

let failed = 0;
for (const [key, lines] of errors) {
  if (!allowed.has(key)) {
    failed++;
    if (pretty || failed <= 25) for (const l of lines) console.error(`UNALLOWED  ${l}`);
    else if (failed === 26) console.error("UNALLOWED  …(更多省略，去掉 --verbose 前 25 条后不再展开)");
  }
}
// 清单在而实际已不存在的条目 → 提示收紧
for (const key of allowed) {
  if (!errors.has(key)) console.log(`note: baseline allows ${key} but tsc no longer reports it — run update to tighten`);
}

const total = [...errors.values()].reduce((n, l) => n + l.length, 0);
if (failed > 0) {
  console.error(`tsc-baseline: FAIL — ${failed} file|code outside allow-list (total ${total} errors). Fix or (if intentional) re-baseline.`);
  process.exit(1);
}
console.log(`tsc-baseline: PASS — ${total} errors, all within allow-list`);
process.exit(0);
