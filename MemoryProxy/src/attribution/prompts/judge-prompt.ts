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

/**
 * v2 模板（real provider 专用；mock 仍用 v1）。
 *
 * 与 v1 的差异：v1 只给「单元 + 候选 id 列表」，LLM 无法判断「决策是否实质用了资产」
 * （资产正文不在输入里）。v2 把**候选资产可见正文**与**机械锚点度量**一并交给 LLM，
 * 让它做「决策内容 ↔ 资产正文」的语义对照 —— 判「实质遵循」，而非「表面文本重合」。
 * 代价（如实）：real 判官会把**候选资产的可见正文**发送给 LLM provider ⇒ 只对
 * 「可公开」资产启用 real 判官（如公开 skill）；含隐私的资产不得走 real 判官。
 */
export const ATTRIBUTION_JUDGE_PROMPT_V2: JudgePromptTemplate = {
  memory_prompt_id: "attribution-judge-v2",
  version: 2,
  text: [
    "You are an attribution judge.",
    "Given a decision unit (a model turn that produced actions such as tool calls,",
    "edits, or text), a list of candidate assets, each asset's visible text, and",
    "mechanical citation metrics, decide whether the unit actually USED a specific",
    "candidate asset.",
    "",
    '"Used" means the unit\'s decision or change materially follows or reflects',
    "something the asset tells the agent to do (a convention, a procedure, a known",
    "pitfall, a constraint) — not merely that the asset was listed as injected.",
    "Judge by semantic correspondence between the asset's text and the unit's",
    "evidence; do not confirm from surface overlap alone.",
    "",
    'A "turn_context" field (when present) lists OTHER decision units in the SAME',
    "turn, in order. Use it only to understand whether the current unit is part of",
    "a multi-step decision (e.g. run tests -> extract failures -> diff baseline);",
    "the verdict still targets the CURRENT unit and a SINGLE asset.",
    "",
    "Reply with exactly one JSON object:",
    '{"asset_id": string|null, "verdict": "confirmed"|"refuted"|"unconfirmed", "rationale_ref": string}',
    "",
    'Use "unconfirmed" when evidence is insufficient. Never invent an asset_id',
    'that is not in the candidate list. "refuted" means the unit contradicts the asset.',
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
