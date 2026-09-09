/**
 * R6 golden recorder —— 重新生成 render-golden.snap.json。
 *
 * 用法：在 MemoryProxy/ 下执行 `npx tsx scripts/qa/record-render-golden.ts`
 * 或 `npm run record:render-golden`。
 *
 * 语义：对四个产资产 injector 的 content 组装路径做确定性渲染并整段落盘为 golden 快照。
 * 快照 commit 后，render-golden.test.ts 逐字节断言当前渲染 == 快照 —— 任何 content
 * 文案/换行/join 变更都会红；确实是有意的文案变更才用本脚本刷新快照（先 diff 再看）。
 *
 * 注意：只记录 content 字节，不记录 metadata.assets（assets 是 S0 合法增量，
 * 结构与一致性由 asset-metadata.test.ts 单独守）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GOLDEN_CASE_IDS, renderGoldenCase } from "../../src/injection/injectors/__tests__/render-golden-cases.js";

const outFile = fileURLToPath(
  new URL("../../src/injection/injectors/__tests__/render-golden.snap.json", import.meta.url),
);

const snapshot: Record<string, string> = {};
const missing: string[] = [];
for (const id of GOLDEN_CASE_IDS) {
  const rendered = renderGoldenCase(id);
  if (!rendered) {
    missing.push(id);
    continue;
  }
  snapshot[id] = rendered.content;
}
if (missing.length > 0) {
  console.error(`render-golden: MISSING render for cases: ${missing.join(", ")}`);
  process.exit(1);
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(
  `render-golden: wrote ${Object.keys(snapshot).length} cases -> ${join(dirname(outFile), "render-golden.snap.json")}`,
);
for (const id of Object.keys(snapshot)) {
  console.log(`  ${id}: ${snapshot[id].length} chars`);
}
