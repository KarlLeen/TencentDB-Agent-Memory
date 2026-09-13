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
 *
 * **108（(d)-1c）**：+**逐字连续重合轴**（"最长连续字符重合"——coverage 量词重合、
 * 与"是否引用"甚至负相关（改写保 trigram 反而分高），此轴量逐字连续；见 108 报告）
 * +**引号/代码跨度计数**（C4；只记数字）。均可复跑：`npx tsx scripts/qa/shadow-calibration.ts`。
 *
 * **121（`116` P3）**：+**资产文本来源** `shadowAssetTextSource: "block" | "none"` ——
 * 只回答"**有没有可比资产文本**"（D1：测量值与"能不能测量"分离；D2：枚举不给无消费者的精度）。
 * 它把此前**同形不可分**的两形态拆开：无文本（`"none"`，early-return）vs 有文本但无 ≥ `SHADOW_L_MIN`
 * 的行（`"block"` + `segCount 0`，107 C3 回退路径）——**不得**用 `segCount === 0` 反推来源（R1）。
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

/** 每候选 4+2 个零布尔数字（(d2) 主 4 + (d1) 附带 2）；
 *  **107**：+`shadowBestSegCoveragePerMsg`（逐消息 max 口径，F-a 补强）+ `shadowWholeAssetCoverage`
 *  （短资产回退，F-c 补强）。**旧字段 `shadowBestSegCoverage` 语义不改**（join 口径，供两口径对照）。 */
export interface CandidateShadowMetrics {
  assetId: string;
  /** **121（`116` P3）**：资产文本来源 —— `"block"` = 该会话有该资产的可比文本（`sessionAssetTexts` 命中且非空）；
   *  `"none"` = **无可比文本**（early-return，其余覆盖字段全 `"unknown"`/`0`/`null`）。
   *  与 `shadowWholeAssetCoverage` **正交**：`"block"` + `shadowAssetSegCount === 0` ⇒ **有文本但过短无片段**（107 C3 回退）；
   *  **禁止**用 `segCount === 0` 反推来源（121 · R1 钉死：那正是"换一种方式继续猜"）。
   *  **121b（时间轴缺键）**：**`121` 之前的存量条目无本键** ⇒ 消费侧视为 **"来源未知"**，
   *  **不得**默认成 `"none"`/`"block"`（复核 P3：老行读键会得 `undefined`，默认 `"none"` = 误判"无可比文本"）。 */
  shadowAssetTextSource: "block" | "none";
  /** (d2) 主向：资产行级片段 ⊆ 会话消息 */
  shadowAssetSegCount: number;
  /** join 口径（**107 起不改义**，作对照保留）：`gramCoverage(join(消息面), 片段)` 的全段 max。 */
  shadowBestSegCoverage: number | "unknown";
  /** **107 · C1**：逐消息口径 —— `max over (片段 × 单条消息)` 的 coverage（不做 join，防跨消息 trigram 拼凑）。 */
  shadowBestSegCoveragePerMsg: number | "unknown";
  /** **108 · C2**：逐字连续重合（正轴候选）—— `max over (片段 × 单条消息)` 的最长连续字符重合**长度**
   *  （UTF-16 code units；单条消息内、不 join；无片段/无重合 ⇒ 0）。 */
  shadowBestContiguousRunChars: number;
  /** **108 · C2**：上值的归一化 = run / 达成该 run 的**片段长度**；无片段 ⇒ `"unknown"`（无分母）。 */
  shadowBestContiguousRunNorm: number | "unknown";
  shadowBestSegIndex: number | null;
  shadowBestSegSha256_16: string | null;
  /** (d1) 向（附带）：消息行级片段 ⊆ 资产正文 */
  shadowMsgSegMaxCoverage: number | "unknown";
  shadowMsgSegIdx: number | null;
  /** **108 · C4**：消息面内**引号 / 代码块 / 行内 code** 跨度总数（消息侧特征；只记数字，不落正文）。 */
  shadowQuotedSpanCount: number;
  /** **108 · C4**：上述跨度的最长内容 chars（无跨度 ⇒ 0）。 */
  shadowQuotedSpanMaxChars: number;
  /** **107 · C3**：短资产回退 —— 仅当 `shadowAssetSegCount === 0` 时计算 `gramCoverage(消息面, 资产全文)`
   *  （"资产整体 ⊆ 消息"的覆盖比；只记录只报数），否则 `"unknown"`（不适用）。 */
  shadowWholeAssetCoverage: number | "unknown";
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
 * 108 · C2：两串的**最长连续公共子串**长度（UTF-16 code units）。
 * 实现 = 后缀自动机（SAM）：对 `b` 建机、拿 `a` 走一遍，均摊 O(|a| + |b|)。
 * 导出供单测与朴素 DP 对拍（防实现漂移）。
 */
export function longestCommonSubstringLen(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  // 建 b 的 SAM
  const next: Array<Map<number, number>> = [new Map()];
  const link: number[] = [-1];
  const len: number[] = [0];
  let last = 0;
  for (let i = 0; i < b.length; i += 1) {
    const c = b.charCodeAt(i);
    const cur = next.length;
    next.push(new Map());
    link.push(-1);
    len.push(len[last]! + 1);
    let p = last;
    while (p !== -1 && !next[p]!.has(c)) {
      next[p]!.set(c, cur);
      p = link[p]!;
    }
    if (p === -1) {
      link[cur] = 0;
    } else {
      const q = next[p]!.get(c)!;
      if (len[p]! + 1 === len[q]!) {
        link[cur] = q;
      } else {
        const clone = next.length;
        next.push(new Map(next[q]!));
        link.push(link[q]!);
        len.push(len[p]! + 1);
        while (p !== -1 && next[p]!.get(c) === q) {
          next[p]!.set(c, clone);
          p = link[p]!;
        }
        link[q] = clone;
        link[cur] = clone;
      }
    }
    last = cur;
  }
  // 拿 a 走 SAM
  let v = 0;
  let l = 0;
  let best = 0;
  for (let i = 0; i < a.length; i += 1) {
    const c = a.charCodeAt(i);
    while (v !== 0 && !next[v]!.has(c)) {
      v = link[v]!;
      l = Math.min(l, len[v]!);
    }
    if (next[v]!.has(c)) {
      v = next[v]!.get(c)!;
      l += 1;
    } else {
      v = 0;
      l = 0;
    }
    if (l > best) best = l;
  }
  return best;
}

/**
 * 108 · C4：消息内**引号 / 代码块 / 行内 code** 跨度计数与最长内容长度（只出数字）。
 * 形态写死（确定性）：```…```（跨行代码块）→ `` `…` ``（行内 code）→ 「…」 → `“…”` → ASCII `"…"`（均不跨行）。
 * 代码块先扣（防块内 ` 被行内 code 重复计）；全部只计内容长度，不保留内容。
 */
function countQuotedSpans(text: string): { count: number; maxChars: number } {
  let count = 0;
  let maxChars = 0;
  const record = (inner: string): void => {
    count += 1;
    if (inner.length > maxChars) maxChars = inner.length;
  };
  let rest = text.replace(/```([\s\S]*?)```/g, (m, inner: string) => {
    record(inner);
    return "\u0000".repeat(m.length);
  });
  rest = rest.replace(/`([^`\n]+)`/g, (m, inner: string) => {
    record(inner);
    return "\u0000".repeat(m.length);
  });
  rest = rest.replace(/「([^」\n]{1,1000})」/g, (m, inner: string) => {
    record(inner);
    return "\u0000".repeat(m.length);
  });
  rest = rest.replace(/\u201c([^\u201d\n]{1,1000})\u201d/g, (m, inner: string) => {
    record(inner);
    return "\u0000".repeat(m.length);
  });
  rest.replace(/"([^"\n]{1,1000})"/g, (m, inner: string) => {
    record(inner);
    return "\u0000".repeat(m.length);
  });
  return { count, maxChars };
}

/**
 * 影子度量入口（同 `gradeCandidates` 的取数面；**纯只读**）。
 * `turnSeq` 为 null ⇒ 引文集为空 ⇒ 消息面为空 ⇒ 覆盖全 `"unknown"`（不猜轮次；同 grading）。
 * `minIdf`（**108 · C3**）：只影响 coverage 族（缺省 0 = 现状不变）；连续重合与标记计数与它无关。
 */
export function shadowGradeCandidates(input: {
  sessionKey: string;
  turnSeq: number | null;
  candidates: JudgeCandidate[];
  source: CitationSourceProvider;
  lMin?: number;
  minIdf?: number;
}): CandidateShadowMetrics[] {
  const lMin =
    Number.isInteger(input.lMin) && (input.lMin as number) > 0 ? (input.lMin as number) : SHADOW_L_MIN;
  const minIdf = Number.isFinite(input.minIdf) ? (input.minIdf as number) : 0;
  const window = input.source.sessionWindow(input.sessionKey);
  const msgTexts = window.pieces
    .filter((p) => p.turnSeq === input.turnSeq && p.tier === "message")
    .map((p) => stripRenderWrappers(visibleTextOfPiece(p)).text);
  const msgText = msgTexts.join("\n");
  const assetTexts = input.source.sessionAssetTexts(input.sessionKey);
  const table = input.source.rarityTable();

  // 108 · C4：消息侧标记计数（对全部候选相同；只算一次）。
  let quotedSpanCount = 0;
  let quotedSpanMaxChars = 0;
  for (const t of msgTexts) {
    const spans = countQuotedSpans(t);
    quotedSpanCount += spans.count;
    if (spans.maxChars > quotedSpanMaxChars) quotedSpanMaxChars = spans.maxChars;
  }

  return input.candidates.map((candidate) => {
    const rawTexts = assetTexts.get(candidate.assetId);
    const base: CandidateShadowMetrics = {
      assetId: candidate.assetId,
      shadowAssetTextSource: "none", // 121：默认 = 无可比文本；过了 early-return 改 "block"
      shadowAssetSegCount: 0,
      shadowBestSegCoverage: "unknown",
      shadowBestSegCoveragePerMsg: "unknown",
      shadowBestContiguousRunChars: 0,
      shadowBestContiguousRunNorm: "unknown",
      shadowBestSegIndex: null,
      shadowBestSegSha256_16: null,
      shadowMsgSegMaxCoverage: "unknown",
      shadowMsgSegIdx: null,
      shadowQuotedSpanCount: quotedSpanCount,
      shadowQuotedSpanMaxChars: quotedSpanMaxChars,
      shadowWholeAssetCoverage: "unknown",
    };
    // 无资产文本可比 ⇒ 全 unknown/null（不猜；与 grading 的 null 路径同姿势）。
    if (!rawTexts || rawTexts.length === 0) return base;
    base.shadowAssetTextSource = "block"; // 121：有可比文本（与 segCount 无关——形态 B 也是 "block"）
    const assetText = assetOwnText(rawTexts);

    // (d2) 主向：资产行级片段 ⊆ 会话消息（quote = 片段，window = 消息面）。
    const assetSegs = segmentsOf(assetText, lMin);
    let bestCov = Number.NaN;
    for (let i = 0; i < assetSegs.length; i++) {
      const cov = gramCoverage(msgText, assetSegs[i]!, table, { minIdf }).coverage;
      if (isCoverageKnown(cov) && (!isCoverageKnown(bestCov) || cov > bestCov)) {
        bestCov = cov;
        base.shadowBestSegIndex = i;
        base.shadowBestSegSha256_16 = sha16(assetSegs[i]!);
      }
    }
    base.shadowAssetSegCount = assetSegs.length;
    base.shadowBestSegCoverage = isCoverageKnown(bestCov) ? bestCov : "unknown";

    // 107 · C1：逐消息口径（**不 join**）——max over (片段 × 单条消息)，防跨消息 trigram 拼凑（F-a）。
    let bestPerMsg = Number.NaN;
    for (const seg of assetSegs) {
      for (const msg of msgTexts) {
        const cov = gramCoverage(msg, seg, table, { minIdf }).coverage;
        if (isCoverageKnown(cov) && (!isCoverageKnown(bestPerMsg) || cov > bestPerMsg)) {
          bestPerMsg = cov;
        }
      }
    }
    base.shadowBestSegCoveragePerMsg = isCoverageKnown(bestPerMsg) ? bestPerMsg : "unknown";

    // 108 · C2：逐字连续重合轴 —— max over (片段 × 单条消息) 的最长连续公共子串长度；
    // 归一化分母 = **达成该 run 的片段长度**（无片段 ⇒ unknown）。
    let bestRun = 0;
    let bestRunSegLen = 0;
    for (const msg of msgTexts) {
      for (const seg of assetSegs) {
        const run = longestCommonSubstringLen(seg, msg);
        if (run > bestRun) {
          bestRun = run;
          bestRunSegLen = seg.length;
        }
      }
    }
    base.shadowBestContiguousRunChars = bestRun;
    base.shadowBestContiguousRunNorm =
      assetSegs.length === 0 ? "unknown" : bestRunSegLen > 0 ? bestRun / bestRunSegLen : 0;

    // 107 · C3：短资产回退（F-c）——segCount === 0 时记"资产整体 ⊆ 消息"覆盖比（只记录只报数）。
    if (assetSegs.length === 0) {
      const whole = gramCoverage(msgText, assetText, table, { minIdf }).coverage;
      base.shadowWholeAssetCoverage = isCoverageKnown(whole) ? whole : "unknown";
    }

    // (d1) 向：消息行级片段 ⊆ 资产正文（quote = 消息片段，window = 资产正文）。
    const msgSegs = msgTexts.flatMap((t) => segmentsOf(t, lMin));
    let bestMsgCov = Number.NaN;
    for (let i = 0; i < msgSegs.length; i++) {
      const cov = gramCoverage(assetText, msgSegs[i]!, table, { minIdf }).coverage;
      if (isCoverageKnown(cov) && (!isCoverageKnown(bestMsgCov) || cov > bestMsgCov)) {
        bestMsgCov = cov;
        base.shadowMsgSegIdx = i;
      }
    }
    base.shadowMsgSegMaxCoverage = isCoverageKnown(bestMsgCov) ? bestMsgCov : "unknown";
    return base;
  });
}
