/**
 * T15 golden 语料与渲染（design §4.5 基座-b）。
 *
 * 与 render-golden-cases.ts 同姿势：**唯一事实源**在代码里，快照由 recorder 生成，
 * 测试只做逐字节比对。改 mock 判定规则 / 改 prompt 文本 ⇒ 快照必红（有意变更才刷新）。
 *
 * 覆盖四种判定结果，避免"只测了 confirmed 一条路"：
 *   c1 候选命中（confirmed，顺序第 1 命中）
 *   c2 候选全不命中（unconfirmed + assetId null）
 *   c3 多候选：命中顺序靠后者（证明"按 candidates 顺序取首个"是可复现规则，不是碰巧）
 *   c4 脚本指定 refuted（证明 verdict 三态都能落）
 */

import { DeterministicMockJudge, type MockJudgeScript } from "../judge/deterministic-mock-judge.js";
import type { JudgeInput } from "../judge/types.js";
import { buildAttributionJudgePromptRef, sha256Hex } from "../prompts/judge-prompt.js";

export const JUDGE_GOLDEN_CASE_IDS = ["c1-first-hit", "c2-no-hit", "c3-second-hit", "c4-scripted-refuted"] as const;
export type JudgeGoldenCaseId = (typeof JUDGE_GOLDEN_CASE_IDS)[number];

interface GoldenCaseDef {
  input: JudgeInput;
  script?: MockJudgeScript;
}

const caseDefs: Record<JudgeGoldenCaseId, GoldenCaseDef> = {
  "c1-first-hit": {
    input: {
      unitId: "golden-u1",
      sessionKey: "golden-sess",
      round: 0,
      unit: { kind: "restraint", payload: { text: "见 asset-alpha 的说明再改" } },
      candidates: [
        { assetId: "asset-alpha", assetType: "skill", evidenceSourceType: "injected" },
        { assetId: "asset-beta", assetType: "skill", evidenceSourceType: "injected" },
      ],
      promptRef: buildAttributionJudgePromptRef(),
    },
  },
  "c2-no-hit": {
    input: {
      unitId: "golden-u2",
      sessionKey: "golden-sess",
      round: 0,
      unit: { kind: "restraint", payload: { text: "正文里没有任何候选 id" } },
      candidates: [{ assetId: "asset-alpha", assetType: "skill", evidenceSourceType: "injected" }],
      promptRef: buildAttributionJudgePromptRef(),
    },
  },
  "c3-second-hit": {
    input: {
      unitId: "golden-u3",
      sessionKey: "golden-sess",
      round: 0,
      unit: { kind: "restraint", payload: { text: "这里只出现 asset-beta" } },
      candidates: [
        { assetId: "asset-alpha", assetType: "skill", evidenceSourceType: "injected" },
        { assetId: "asset-beta", assetType: "skill", evidenceSourceType: "injected" },
      ],
      promptRef: buildAttributionJudgePromptRef(),
    },
  },
  "c4-scripted-refuted": {
    input: {
      unitId: "golden-u4",
      sessionKey: "golden-sess",
      round: 0,
      unit: { kind: "restraint", payload: { text: "asset-alpha" } },
      candidates: [{ assetId: "asset-alpha", assetType: "skill", evidenceSourceType: "injected" }],
      promptRef: buildAttributionJudgePromptRef(),
    },
    script: {
      byUnitId: { "golden-u4": { kind: "verdict", verdict: "refuted", assetId: "asset-alpha" } },
    },
  },
};

export interface JudgeGoldenRecord {
  /** 输入摘要的 sha256（输入变了 ⇒ 快照红，不需要把全文塞进快照）。 */
  inputSha256: string;
  /** verdict 的规范化 JSON 串（键序固定：assetId, rationaleRef, verdict）。 */
  verdictJson: string;
  impl: string;
}

/** 稳定化：把 verdict 按固定键序序列化（mock 输出本身已是该序，这里显式钉死）。 */
export function canonicalVerdictJson(verdict: {
  assetId: string | null;
  verdict: string;
  rationaleRef: string;
}): string {
  return JSON.stringify({
    assetId: verdict.assetId,
    rationaleRef: verdict.rationaleRef,
    verdict: verdict.verdict,
  });
}

export async function renderJudgeGolden(id: JudgeGoldenCaseId): Promise<JudgeGoldenRecord> {
  const def = caseDefs[id];
  const judge = new DeterministicMockJudge(def.script ? { script: def.script } : {});
  const verdict = await judge.judge(def.input);
  return {
    inputSha256: sha256Hex(
      JSON.stringify({
        unitId: def.input.unitId,
        round: def.input.round,
        unit: def.input.unit,
        candidates: def.input.candidates,
      }),
    ),
    verdictJson: canonicalVerdictJson(verdict),
    impl: judge.impl,
  };
}
