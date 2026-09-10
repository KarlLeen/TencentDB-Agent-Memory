/**
 * T15 golden（design §5）—— 固定 corpus 的 verdict 序列 + prompt sha256 与快照逐字节一致。
 *
 * 快照不是"参考值"而是**契约**：mock 规则、prompt 文本、候选顺序任一变化都必须让本测试红，
 * 逼人先 diff 再决定是否 `npm run record:judge-golden` 刷新。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  JUDGE_GOLDEN_CASE_IDS,
  renderJudgeGolden,
  type JudgeGoldenCaseId,
} from "./judge-golden-cases.js";

const snapPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "judge-golden.snap.json");
const raw = readFileSync(snapPath, "utf8");
const snapshot = JSON.parse(raw) as {
  promptRef: { memory_prompt_id: string; version: number; source: string; prompt_sha256: string };
  cases: Record<string, { inputSha256: string; verdictJson: string; impl: string }>;
};

describe("T15 golden", () => {
  it("语料 verdict 序列与快照逐字节一致", async () => {
    const actual: Record<string, { inputSha256: string; verdictJson: string; impl: string }> = {};
    for (const id of JUDGE_GOLDEN_CASE_IDS) {
      actual[id] = await renderJudgeGolden(id as JudgeGoldenCaseId);
    }

    // 逐 case 比（失败信息可读）
    for (const id of JUDGE_GOLDEN_CASE_IDS) {
      expect(actual[id]).toEqual(snapshot.cases[id]);
    }
    // 整文件逐字节比（顺序/缩进/尾换行都算契约）
    const rebuilt = `${JSON.stringify({ promptRef: snapshot.promptRef, cases: actual }, null, 2)}\n`;
    expect(rebuilt).toBe(raw);
  });

  it("prompt_ref 的 sha256 与快照一致（prompt 文本是不可漂移的契约）", () => {
    expect(snapshot.promptRef).toEqual({
      memory_prompt_id: "attribution-judge-v1",
      version: 1,
      source: "attribution-judge",
      prompt_sha256: "6ed16597732f5a196378e4081d1a2b873271e08fe22172f2add3bb2d5557d0ac",
    });
  });

  it("c4 证明三态可落：refuted 也在快照里（不是只测 confirmed）", () => {
    expect(JSON.parse(snapshot.cases["c4-scripted-refuted"]!.verdictJson).verdict).toBe("refuted");
    expect(JSON.parse(snapshot.cases["c2-no-hit"]!.verdictJson).verdict).toBe("unconfirmed");
    expect(JSON.parse(snapshot.cases["c1-first-hit"]!.verdictJson).verdict).toBe("confirmed");
  });
});
