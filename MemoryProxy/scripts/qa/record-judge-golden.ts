/**
 * T15 golden recorder —— 重新生成 judge-golden.snap.json（design §4.5 基座-b）。
 *
 * 用法：在 MemoryProxy/ 下执行 `npm run record:judge-golden`。
 *
 * 语义：对固定语料跑确定性 mock judge，把 **prompt_ref + 每个 case 的 verdict** 整段落盘。
 * 快照 commit 后 judge-golden.test.ts 逐字节断言 —— 改 mock 规则 / 改 prompt 文本 /
 * 改候选顺序都会红。确实有意的变更才用本脚本刷新（先 diff 再看）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  JUDGE_GOLDEN_CASE_IDS,
  renderJudgeGolden,
  type JudgeGoldenCaseId,
} from "../../src/attribution/__tests__/judge-golden-cases.js";
import { buildAttributionJudgePromptRef } from "../../src/attribution/prompts/judge-prompt.js";

const outFile = fileURLToPath(new URL("../../src/attribution/__tests__/judge-golden.snap.json", import.meta.url));

const cases: Record<string, { inputSha256: string; verdictJson: string; impl: string }> = {};
for (const id of JUDGE_GOLDEN_CASE_IDS) {
  cases[id] = await renderJudgeGolden(id as JudgeGoldenCaseId);
}

const snapshot = {
  promptRef: buildAttributionJudgePromptRef(),
  cases,
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

console.log(`judge-golden: wrote ${Object.keys(cases).length} cases -> ${join(dirname(outFile), "judge-golden.snap.json")}`);
for (const id of Object.keys(cases)) {
  console.log(`  ${id}: ${cases[id]!.verdictJson}`);
}
