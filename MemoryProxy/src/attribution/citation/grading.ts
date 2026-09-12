/**
 * 57 · shortlist（漏斗④）+ 三道机械锚点组装（⑤）（契约 = 50 spec §12）。
 *
 * 纯函数，组合基座-c 四件套（c1 归一化 / c2 剥离 / c3 稀有度 / c4 输入源），
 * **只出度量、零阈值零布尔**（⑥ 裁决属 B5 标定单）：
 *
 *   - shortlist：排序键 = §11.2 已钉顺序（**不重排**——④ 在 ⑤ 之前，排序键本就不能用度量；
 *     mock judge 按序取第一个命中，`deterministic-mock-judge.ts:77`）；前 K 喂 judge，
 *     溢出 = 计数 + assetId 清单（"不丢弃" = 可观测，不是全喂）；度量只对前 K。
 *   - 引文归一化命中：引文 = 单元轮的窗口 pieces（档①+档②），逐 piece × 逐级取最强；
 *   - 稀有度覆盖：`gramCoverage(资产文本, 命中文段, table)`，NaN ⇒ 显式 `"unknown"`（不落 0/1）；
 *   - 排他性：命中文段在其他资产文本中的 exact 级出现（资产数，只出数字）。
 */
import type { JudgeCandidate } from "../judge/types.js";
import { normalizeForMatch, type MatchLevel } from "./normalize.js";
import { gramCoverage, isCoverageKnown } from "./ngram.js";
import type { CitationSourceProvider } from "./source.js";
import { visibleTextOfPiece } from "./visible-text.js";
import { stripRenderWrappers } from "./wrapper-registry.js";

/** shortlist 缺省 K（写死，非 config）：保险丝不是常态路径；分布依据见 57 报告直方图。 */
export const SHORTLIST_K = 16;

export type CitationMatchLevel = MatchLevel | "none";

/** 每候选一份度量（C3；零阈值零布尔；`matchLevel: null` = 无资产文本可比，不猜）。 */
export interface CandidateCitationMetrics {
  assetId: string;
  matchLevel: CitationMatchLevel | null;
  /** 命中 piece 的层（审计）；未命中 / 无资产文本 ⇒ null。 */
  matchedTier: "block" | "message" | null;
  coverage: number | "unknown";
  coverageDistinct: number;
  coverageCovered: number;
  /** 排他性：命中文段在同会话其他资产文本中 exact 级命中的**资产数**。 */
  exclusionCount: number;
  ngramTableSha256: string;
}

export interface ShortlistResult {
  candidates: JudgeCandidate[];
  k: number;
  total: number;
  overflowCount: number;
  overflowAssetIds: string[];
}

/** 前 K + 溢出可观测（不重排：slice 保 §11.2 顺序）。 */
export function shortlistCandidates(candidates: JudgeCandidate[], k: number = SHORTLIST_K): ShortlistResult {
  const head = candidates.slice(0, k);
  const overflow = candidates.slice(k);
  return {
    candidates: head,
    k,
    total: candidates.length,
    overflowCount: overflow.length,
    overflowAssetIds: overflow.map((c) => c.assetId),
  };
}

/** 级别序 = 由严到宽；逐 piece × 逐级取**最强**（最严）命中。 */
const LEVEL_ORDER: readonly MatchLevel[] = ["exact", "whitespace", "punctuation"];

interface PieceText {
  tier: "block" | "message";
  text: string;
}

/** 档① occurrence 片段 → "资产自身正文"（c2 剥离后按首见序拼接；剥离产物只用于比较，不入库）。 */
function assetOwnText(texts: readonly string[]): string {
  return texts.map((t) => stripRenderWrappers(t).text).join("\n");
}

/**
 * 对前 K 候选逐一出三道锚点度量（全只读；`source` 的三个方法各调一次，不重复读库）。
 * `turnSeq` 为 null ⇒ 引文集为空 ⇒ 全部 `none`（不猜轮次）。
 */
export function gradeCandidates(input: {
  sessionKey: string;
  turnSeq: number | null;
  candidates: JudgeCandidate[];
  source: CitationSourceProvider;
}): CandidateCitationMetrics[] {
  const window = input.source.sessionWindow(input.sessionKey);
  const pieceTexts: PieceText[] = window.pieces
    // 104 · C1：引文侧只取 message 层 —— tier=block 的 piece 与"资产文本"是同一段文本
    // （多资产块更甚：13 个资产共享整块 content_utf8）⇒ `piece ⊆ 资产文本` 恒真（自匹配/同义反复）。
    // message 层判据逐字未动；只改 piece 集合（见 103 F1–F4、50 spec §12.2 补注）。
    .filter((p) => p.turnSeq === input.turnSeq && p.tier === "message")
    // 引文侧同样经 c2 剥离：比对两侧必须都对齐到"正文"（design §4.8.3）——
    // 否则带包装的注入块永远不是剥离后资产正文的子串（injected 恒 none）。
    // 对 message 层剥离是无害恒等（R8 防过度剥离：无包装 ⇒ removed=[]）。
    .map((p) => ({ tier: p.tier, text: stripRenderWrappers(visibleTextOfPiece(p)).text }));
  const assetTexts = input.source.sessionAssetTexts(input.sessionKey);
  const table = input.source.rarityTable();

  return input.candidates.map((candidate) => {
    const rawTexts = assetTexts.get(candidate.assetId);

    // 无资产文本可比（fetched 资产未注入 ⇒ 档①无其文本）——不知道就不写，别猜。
    if (!rawTexts || rawTexts.length === 0) {
      return {
        assetId: candidate.assetId,
        matchLevel: null,
        matchedTier: null,
        coverage: "unknown",
        coverageDistinct: 0,
        coverageCovered: 0,
        exclusionCount: 0,
        ngramTableSha256: table.tableSha256,
      };
    }
    const assetText = assetOwnText(rawTexts);

    // ① 引文归一化命中：逐 piece × 逐级，取最强（级别序由严到宽 ⇒ 首个命中即最强）。
    let bestLevel: CitationMatchLevel = "none";
    let matched: PieceText | null = null;
    outer: for (const level of LEVEL_ORDER) {
      const haystack = normalizeForMatch(assetText, level);
      for (const piece of pieceTexts) {
        const needle = normalizeForMatch(piece.text, level);
        if (needle.length > 0 && haystack.includes(needle)) {
          bestLevel = level;
          matched = piece;
          break outer;
        }
      }
    }

    if (!matched) {
      return {
        assetId: candidate.assetId,
        matchLevel: "none",
        matchedTier: null,
        coverage: "unknown", // 无命中文段 ⇒ 无 quote 依据
        coverageDistinct: 0,
        coverageCovered: 0,
        exclusionCount: 0,
        ngramTableSha256: table.tableSha256,
      };
    }

    // ② 稀有度覆盖：**资产文本**的 distinctive grams 被命中文段（引文）覆盖的比例 ——
    // "这次引用覆盖了资产内容的多少独特成分"（反接则恒 1：命中 ⇒ 引文 ⊆ 资产 ⇒ 引文的
    // gram 全在资产里，度量失效）。NaN ⇒ 显式 unknown。
    const cov = gramCoverage(matched.text, assetText, table);
    const coverage = isCoverageKnown(cov.coverage) ? cov.coverage : "unknown";

    // ③ 排他性：命中文段在其他资产文本中的 exact 级（原字节，最严）出现 —— 按资产数，只出数字。
    let exclusionCount = 0;
    for (const [otherId, texts] of assetTexts) {
      if (otherId === candidate.assetId) continue;
      if (assetOwnText(texts).includes(matched.text)) exclusionCount += 1;
    }

    return {
      assetId: candidate.assetId,
      matchLevel: bestLevel,
      matchedTier: matched.tier,
      coverage,
      coverageDistinct: cov.distinct,
      coverageCovered: cov.covered,
      exclusionCount,
      ngramTableSha256: table.tableSha256,
    };
  });
}
