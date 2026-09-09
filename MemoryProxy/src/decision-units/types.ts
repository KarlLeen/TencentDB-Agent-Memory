/**
 * S3 decision-unit 共享类型与常量（docs/implementation/30-decision-unit-extractor.md §4.5–4.7）。
 *
 * 与 injection/types.ts 完全解耦：decision-units 只吃"原始 messages 数组"，
 * 自己归一化，零耦合既有注入管线（依赖倒置，方便独立单测与回放）。
 */

/** 单条消息可锚定的单元数上限（msg_seq 编码：anchor×16 + slot）。 */
export const DECISION_SLOTS_PER_MESSAGE = 16;

/** 文本节选上限：单段 4000 字符。 */
export const TEXT_SNIPPET_MAX = 4000;

/** 单元内多段文本合计上限 16000 字符（诚实截断，保留 chars 记原文长度）。 */
export const TEXT_TOTAL_MAX = 16000;

/** payload.version（v1 契约）。 */
export const DECISION_UNIT_VERSION = 1;

export type DecisionUnitType = "code_change" | "key_tool_call" | "restraint";

export type KeyToolResultStatus = "success" | "error" | "unknown";

export type Protocol = "anthropic" | "openai";

/** code_change 单个 edit 的最小摘要（截断节选 + 原文长度痕迹）。 */
export interface CodeEditSnippet {
  toolUseId: string;
  toolName: string;
  paramKey: string; // old_string / new_string / content …
  text: string; // 截断节选
  chars: number; // 原文长度（截断痕迹，诚实标注）
}

/** A2 可见资产快照项（只 restraint 有，S2 未开/无注入行 → 整个字段省略）。 */
export interface VisibleAsset {
  assetId: string;
  assetType: string;
}

/**
 * 单元 payload（payload_json，v1 契约 = 自足证据）。公共字段 + 类型专属字段，
 * 具体形状见 30 spec §4.7。这里用区分联合表达类型专属字段。
 */
export type DecisionUnitPayload =
  | CodeChangePayload
  | KeyToolCallPayload
  | RestraintPayload;

interface BasePayload {
  version: typeof DECISION_UNIT_VERSION;
  unitType: DecisionUnitType;
  unitId: string; // §4.6 内容哈希，不进 essence 的东西都不该让它变（visibleAssets 除外）
  protocol: Protocol;
  anchorMessageIndex: number; // 原始 messages[] 下标（与 msg_seq 同源）
  turnSeq: number; // 行级 turn_seq 的冗余（payload 自足）
  overflowed?: boolean; // §4.5 钳制标记
}

export interface CodeChangePayload extends BasePayload {
  unitType: "code_change";
  filePath: string;
  rationaleText?: string; // 单元内首个 file-run 前最近的 assistant 文本（截断）
  edits: CodeEditSnippet[];
}

export interface KeyToolCallPayload extends BasePayload {
  unitType: "key_tool_call";
  toolUseId: string;
  toolName: string;
  toolParamText: string; // 命令/入参节选
  chars: number;
  matchedBy: string; // 命中的 matcher label（确定性可审计）
  resultStatus: KeyToolResultStatus;
  resultSnippet?: string; // 截断
}

export interface RestraintPayload extends BasePayload {
  unitType: "restraint";
  matchedSeeds: string[]; // 命中的口语种子
  matchedCommands: string[]; // B1：命中的 RISKY matcher label（命令字面量）
  visibleAssets?: VisibleAsset[]; // A2 快照（v1 只做 restraint）
  riskyCandidateText: string; // 截断的人类 risky 请求原文
  responseEvidence: {
    rationaleText?: string; // 链内 assistant 文本节选
    clarifyingQuestion: boolean; // 追问（先经用户确认）
    safeAlternativeTools: string[]; // 链内实际执行的非 risky 工具（描述）
    riskyExecuted: false; // 恒 false —— 为真时此单元不成立
  };
}

export interface SealedDecisionUnit {
  kind: DecisionUnitType;
  unitId: string;
  anchorMessageIndex: number; // 与 msg_seq 同源
  unitSlot: number; // 0..15
  msgSeq: number; // anchor×16 + slot
  turnSeq: number; // 行级 turn_seq
  /** 本单元成为"密封"的边界消息下标：code/key = 末次 edit 所在消息；restraint = 链闭合的人类消息。 */
  sealMessageIndex: number;
  overflowed: boolean;
  /** 按 §4.7 组装的 payload（visibleAssets 由 runner 补，不进 essence）。 */
  payload: DecisionUnitPayload;
}
