/**
 * 106 · (d)-1 影子度量（**旁路：只算不判**）—— "资产行级片段 ⊆ 会话消息"（(d2) 向，主）
 * 与 "消息行级片段 ⊆ 资产正文"（(d1) 向，附带）的**并行**度量。
 *
 * 红线（与 50 spec §12.2 现口径并列、互不影响）：
 *   - **判定层零读取**：judge / 阈值 / 真值表不读本文件任何字段（C3）；
 *   - **隐私**：只落数字 + 片段指纹（sha256[:16]）+ 序号；**绝不落片段/消息正文**（C4）；
 *   - **零布尔**：级别 / 数字 / `"unknown"` 哨兵（照 grading 同款；防 NaN 落 0/1）。
 *
 * 片段切分（确定性，写死）：按 `\n` 切行 → 各经既有 **c-2 剥离** → 取长度 `≥ L_MIN` 的行。
 * `L_MIN` 缺省 16（常量；报告须给敏感性扫描 —— C7-4 / R5）。
 *
 * 与 grading 的关系：**共用**同一 `rarityTable` / 同一 message-tier 检索面 / 同一
 * `assetOwnText` 口径；只加旁路数字，不改既有 `citationMetrics` 条目任何键（C2/C5）。
 */
import { createHash } from "node:crypto";

import type { JudgeCandidate } from "../judge/types.js";
import { assetOwnText } from "./grading.js";
import { gramCoverage, isCoverageKnown } from "./ngram.js";
import type { CitationSourceProvider } from "./source.js";
import { visibleTextOfPiece } from "./visible-text.js";
import { stripRenderWrappers } from "./wrapper-registry.js";

/** 片段长度下限（常量；报告给敏感性扫描 —— 106 C7-4 / R5）。 */
export const SHADOW_L_MIN = 16;

/** 每候选 4+2 个零布尔数字（(d2) 主 4 + (d1) 附带 2）。 */
export interface CandidateShadowMetrics {
  assetId: string;
  /** (d2) 主向：资产行级片段 ⊆ 会话消息 */
  shadowAssetSegCount: number;
  shadowBestSegCoverage: number | "unknown";
  shadowBestSegIndex: number | null;
  shadowBestSegSha256_16: string | null;
  /** (d1) 向（附带）：消息行级片段 ⊆ 资产正文 */
  shadowMsgSegMaxCoverage: number | "unknown";
  shadowMsgSegIdx: number | null;
}

function segmentsOf(text: string, lMin: number): string[] {
  return text
    .split("\n")
    .map((line) => stripRenderWrappers(line).text)
    .filter((line) => line.length >= lMin);
}

function sha16(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * 影子度量入口（同 `gradeCandidates` 的取数面；**纯只读**）。
 * `turnSeq` 为 null ⇒ 引文集为空 ⇒ 消息面为空 ⇒ 覆盖全 `"unknown"`（不猜轮次；同 grading）。
 */
export function shadowGradeCandidates(input: {
  sessionKey: string;
  turnSeq: number | null;
  candidates: JudgeCandidate[];
  source: CitationSourceProvider;
  lMin?: number;
}): CandidateShadowMetrics[] {
  const lMin =
    Number.isInteger(input.lMin) && (input.lMin as number) > 0 ? (input.lMin as number) : SHADOW_L_MIN;
  const window = input.source.sessionWindow(input.sessionKey);
  const msgTexts = window.pieces
    .filter((p) => p.turnSeq === input.turnSeq && p.tier === "message")
    .map((p) => stripRenderWrappers(visibleTextOfPiece(p)).text);
  const msgText = msgTexts.join("\n");
  const assetTexts = input.source.sessionAssetTexts(input.sessionKey);
  const table = input.source.rarityTable();

  return input.candidates.map((candidate) => {
    const rawTexts = assetTexts.get(candidate.assetId);
    const base: CandidateShadowMetrics = {
      assetId: candidate.assetId,
      shadowAssetSegCount: 0,
      shadowBestSegCoverage: "unknown",
      shadowBestSegIndex: null,
      shadowBestSegSha256_16: null,
      shadowMsgSegMaxCoverage: "unknown",
      shadowMsgSegIdx: null,
    };
    // 无资产文本可比 ⇒ 全 unknown/null（不猜；与 grading 的 null 路径同姿势）。
    if (!rawTexts || rawTexts.length === 0) return base;
    const assetText = assetOwnText(rawTexts);

    // (d2) 主向：资产行级片段 ⊆ 会话消息（quote = 片段，window = 消息面）。
    const assetSegs = segmentsOf(assetText, lMin);
    let bestCov = Number.NaN;
    for (let i = 0; i < assetSegs.length; i++) {
      const cov = gramCoverage(msgText, assetSegs[i]!, table).coverage;
      if (isCoverageKnown(cov) && (!isCoverageKnown(bestCov) || cov > bestCov)) {
        bestCov = cov;
        base.shadowBestSegIndex = i;
        base.shadowBestSegSha256_16 = sha16(assetSegs[i]!);
      }
    }
    base.shadowAssetSegCount = assetSegs.length;
    base.shadowBestSegCoverage = isCoverageKnown(bestCov) ? bestCov : "unknown";

    // (d1) 向：消息行级片段 ⊆ 资产正文（quote = 消息片段，window = 资产正文）。
    const msgSegs = msgTexts.flatMap((t) => segmentsOf(t, lMin));
    let bestMsgCov = Number.NaN;
    for (let i = 0; i < msgSegs.length; i++) {
      const cov = gramCoverage(assetText, msgSegs[i]!, table).coverage;
      if (isCoverageKnown(cov) && (!isCoverageKnown(bestMsgCov) || cov > bestMsgCov)) {
        bestMsgCov = cov;
        base.shadowMsgSegIdx = i;
      }
    }
    base.shadowMsgSegMaxCoverage = isCoverageKnown(bestMsgCov) ? bestMsgCov : "unknown";
    return base;
  });
}
