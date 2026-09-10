/**
 * 归因 judge 的 prompt 版本 ref（design §4.5）。
 *
 * 目的不是"管理 prompt"，而是**消掉裸字符串**：prompt 文本只此一处，版本号与 sha256
 * 由代码算出 ⇒ 文本一改，落表/落日志的 prompt_sha256 立刻变（可审计，且不需要人肉同步）。
 */

import { createHash } from "node:crypto";

import type { PromptRef } from "../judge/types.js";

export interface JudgePromptTemplate {
  memory_prompt_id: string;
  version: number;
  text: string;
}

/**
 * v1 模板。本期 mock 不消费它（mock 是确定性规则，不是 LLM）——
 * 它的作用是**在基座期就把 ref / 落表 / 落日志的链路钉死**，50 spec 接真 provider 时
 * 只换实现、不动 schema 与日志字段。
 */
export const ATTRIBUTION_JUDGE_PROMPT_V1: JudgePromptTemplate = {
  memory_prompt_id: "attribution-judge-v1",
  version: 1,
  text: [
    "You are an attribution judge.",
    "Given a decision unit and a list of candidate assets, decide whether the unit's",
    "visible evidence confirms the use of a specific candidate asset.",
    "Reply with exactly one JSON object:",
    '{"asset_id": string|null, "verdict": "confirmed"|"refuted"|"unconfirmed", "rationale_ref": string}',
    "Use \"unconfirmed\" when evidence is insufficient. Never invent an asset_id",
    "that is not in the candidate list.",
  ].join("\n"),
};

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 由模板算出 ref。缺省用 v1。 */
export function buildAttributionJudgePromptRef(
  template: JudgePromptTemplate = ATTRIBUTION_JUDGE_PROMPT_V1,
): PromptRef {
  return {
    memory_prompt_id: template.memory_prompt_id,
    version: template.version,
    source: "attribution-judge",
    prompt_sha256: sha256Hex(template.text),
  };
}
