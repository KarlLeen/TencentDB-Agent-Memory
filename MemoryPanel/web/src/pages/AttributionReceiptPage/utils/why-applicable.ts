/**
 * `150 · C1`：**"为什么适用于当前任务"** —— 档位 + 逐字文案（**唯一定义处**；**禁 LLM**）。
 *
 * 素材（**已有**，零新增拉取）：回执 DTO 的 `units[].judgement`（`verdict` / `asset_id` /
 * `detail.citationMetrics[]` / `detail.shortlist.overflowAssetIds`）—— `150 · C2` 以此为"只读透出"，
 * 不新增写口、不改判定口径、不动 `detail_json` 语义。
 *
 * 四条纪律：
 * 1. **判据不新造阈值**：档① 的"达裁决档"= 该 unit `verdict === 'confirmed'`（仓库既有语义 =
 *    "整段逐字级排他引用"；红线一：文本重合只是**筛选信号**，不得当裁决信号另立一套）；
 * 2. **文案不得出现效果性/因果性措辞**（"因为该资产有效/重要/应优先"）—— `145 · C2` 同源（`R1`）；
 * 3. **素材缺失 ⇒ "未知"**，**不得猜**、不得"综合判断"式兜底（`R2`）；
 * 4. 不做六维相关性打分（任务二范畴）：**只用已有素材解释**。
 */
export const WHY_TIERS = ['citedExact', 'candidateBelowThreshold', 'injectedOnly', 'unknown'] as const;
export type WhyTier = (typeof WHY_TIERS)[number];

/** 档位 → i18n key（**唯一定义处**；`R3`：散落两处 ⇒ 红；`citedExactNoCoverage` = 档① 的"无覆盖率"变体）。 */
export const WHY_TIER_KEYS: Readonly<Record<string, string>> = {
  citedExact: 'attribution.receipt.why.citedExact',
  citedExactNoCoverage: 'attribution.receipt.why.citedExactNoCoverage',
  candidateBelowThreshold: 'attribution.receipt.why.candidate',
  injectedOnly: 'attribution.receipt.why.injectedOnly',
};

/** 判定面（`units[].judgement` 的最小投影；缺字段 ⇒ 不参与判据）。 */
export interface JudgementRef {
  verdict: string;
  assetId: string | null;
  detail: Record<string, unknown>;
}

export interface WhyInput {
  assetId: string;
  /** 该资产是否进过上下文（`injection.hook.done`）。 */
  injected: boolean;
  judgements: readonly JudgementRef[];
}

/** `detail.citationMetrics[]` 中该资产的条目（无 ⇒ `null`）。 */
function citationEntryFor(detail: Record<string, unknown>, assetId: string): { coverage: number | null } | null {
  const arr = detail['citationMetrics'];
  if (!Array.isArray(arr)) return null;
  for (const item of arr) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (o['assetId'] !== assetId) continue;
    const cov = o['coverage'];
    return { coverage: typeof cov === 'number' && Number.isFinite(cov) ? cov : null };
  }
  return null;
}

/** `detail.shortlist.overflowAssetIds` 是否含该资产（= 候选但被 top-K 闸门挡下）。 */
function overflowContains(detail: Record<string, unknown>, assetId: string): boolean {
  const sl = detail['shortlist'];
  if (sl === null || typeof sl !== 'object') return false;
  const ids = (sl as Record<string, unknown>)['overflowAssetIds'];
  return Array.isArray(ids) && ids.includes(assetId);
}

/** 覆盖率 → 百分数串（1 位小数、去尾零；例 0.877 ⇒ `87.7`）。 */
export function coveragePercent(coverage: number): string {
  const pct = Math.round(coverage * 1000) / 10;
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
}

export type TranslateFnLike = (key: string, opts?: Record<string, string | number>) => string;

/**
 * 档位判定（**优先级**：已经引用命中 > 候选但未达阈 > 仅注入 > 素材缺失）。
 * 返回**已译文案**（同一事实一处表达；调用方直接渲染）。
 */
export function whyApplicableOf(input: WhyInput, t: TranslateFnLike, unknownText: string): string {
  // ① 已经引用命中：存在 confirmed 判定且指向该资产（覆盖率取自 citationMetrics，缺 ⇒ 如实"未记录"）
  for (const j of input.judgements) {
    if (j.verdict !== 'confirmed' || j.assetId !== input.assetId) continue;
    const cov = citationEntryFor(j.detail, input.assetId)?.coverage ?? null;
    if (cov === null) return t(WHY_TIER_KEYS.citedExactNoCoverage);
    return t(WHY_TIER_KEYS.citedExact, { coverage: coveragePercent(cov) });
  }
  // ② 候选但未达阈：出现在 citationMetrics（未达裁决档）或 shortlist 溢出面
  for (const j of input.judgements) {
    if (citationEntryFor(j.detail, input.assetId) !== null || overflowContains(j.detail, input.assetId)) {
      return t(WHY_TIER_KEYS.candidateBelowThreshold);
    }
  }
  // ③ 仅注入
  if (input.injected) return t(WHY_TIER_KEYS.injectedOnly);
  // ④ 素材缺失 ⇒ 未知（不猜、不兜底）
  return unknownText;
}
