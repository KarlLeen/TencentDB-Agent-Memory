/**
 * 58 · `mechanical:v1` —— 三道机械锚点度量的**确定性裁决**（契约 = 50 spec §13）。
 *
 * 纪律（违反即失去意义）：
 *   - **只读 `JudgeInput.citationMetrics`**（§12 `grading.ts` 的产物），**不重算度量**
 *     （两份度量 = 52 教训）；缺该字段 ⇒ 全 `unconfirmed`（不猜）。
 *   - **阈值写死**（C3：带标定指纹，不进 config；改阈值 = 改码 + 重跑标定）。
 *   - **NaN 门禁**：`coverage` 不是有限数（`"unknown"`）⇒ `unconfirmed`，绝不进比较
 *     （`NaN >= t` 恒 false = 静默 unconfirmed；`!(x < t)` 会误判 confirmed —— B5 警告）。
 *   - 候选级结论 → 单一最强归因（B2 改判 (a)）；`candidates.length === 0` ⇒ 显式 unconfirmed。
 */
import { isCoverageKnown } from "../citation/ngram.js";
import type { CandidateCitationMetrics, CitationMatchLevel } from "../citation/grading.js";
import { sha256Hex } from "../prompts/judge-prompt.js";
import type { Judge, JudgeCandidate, JudgeInput, JudgeVerdict, PromptRef } from "./types.js";

/**
 * 阈值（C3 写死）。**标定指纹**：见 50 spec §13.6 与 58 报告 §标定
 * （扫描表 `/tmp/58/scan-table.json`，标注集 `fixtures/verdict-calibration-cases.json`）。
 */
export const MECHANICAL_T_COV = 0.5;
export const MECHANICAL_T_EXCL = 0;

/** 规则版本文本：阈值改 ⇒ sha 变 ⇒ 落表 prompt_sha256 立刻变（可审计，C3 指纹）。 */
const RULES_VERSION_TEXT = `mechanical-rules-v1 T_COV=${MECHANICAL_T_COV} T_EXCL=${MECHANICAL_T_EXCL}`;

type CandidateConclusion =
  | { kind: "confirmed" }
  | { kind: "refuted" }
  | { kind: "unconfirmed" };

/** 候选级结论（§13.2 真值表，全格子枚举）。 */
function conclude(m: CandidateCitationMetrics, th: MechanicalThresholds): CandidateConclusion {
  // null（无资产文本）/ none（缺席非反证，K3）⇒ unconfirmed（不猜）
  if (m.matchLevel === null || m.matchLevel === "none") return { kind: "unconfirmed" };
  // NaN 门禁：unknown 绝不进比较
  if (typeof m.coverage !== "number" || !isCoverageKnown(m.coverage)) return { kind: "unconfirmed" };
  // 覆盖不足 = 证据弱（非反证）
  if (m.coverage < th.tCov) return { kind: "unconfirmed" };
  // 引用不排他 ⇒ 驳斥该候选
  if (m.exclusionCount > th.tExcl) return { kind: "refuted" };
  return { kind: "confirmed" };
}

const LEVEL_RANK: Record<CitationMatchLevel, number> = { exact: 3, whitespace: 2, punctuation: 1, none: 0 };

interface Scored {
  m: CandidateCitationMetrics;
  idx: number;
}

/** 全序：matchLevel 强度降序 → coverage 降序 → exclusionCount 升序 → §11.2 候选顺序（确定性）。 */
function strongestOf(list: readonly Scored[]): Scored | undefined {
  return [...list].sort(
    (a, b) =>
      LEVEL_RANK[b.m.matchLevel as CitationMatchLevel] - LEVEL_RANK[a.m.matchLevel as CitationMatchLevel] ||
      (b.m.coverage as number) - (a.m.coverage as number) ||
      a.m.exclusionCount - b.m.exclusionCount ||
      a.idx - b.idx,
  )[0];
}

/** 阈值形状（生产 = 模块常量；标定扫描 = 网格参数）。 */
export interface MechanicalThresholds {
  tCov: number;
  tExcl: number;
}

const DEFAULT_THRESHOLDS: MechanicalThresholds = { tCov: MECHANICAL_T_COV, tExcl: MECHANICAL_T_EXCL };

/**
 * 规则核心（**单份**：`MechanicalJudge` 与 S2 标定扫描共用 —— 两份规则 = 52 教训）。
 * 纯函数：候选级结论（§13.2 真值表）→ 单一最强归因（B2 改判 (a)）。
 */
export function decideVerdict(input: {
  candidates: JudgeCandidate[];
  citationMetrics?: CandidateCitationMetrics[];
  thresholds?: MechanicalThresholds;
}): JudgeVerdict {
  const th = input.thresholds ?? DEFAULT_THRESHOLDS;
  if (input.candidates.length === 0) {
    // B5：不得静默 false —— 显式 unconfirmed。
    return { assetId: null, verdict: "unconfirmed", rationaleRef: "mechanical:no-candidates" };
  }
  const metrics = input.citationMetrics;
  if (!metrics) {
    return { assetId: null, verdict: "unconfirmed", rationaleRef: "mechanical:no-metrics" };
  }

  const byId = new Map(metrics.map((m) => [m.assetId, m]));
  const confirmed: Scored[] = [];
  const refuted: Scored[] = [];
  input.candidates.forEach((c, idx) => {
    const m = byId.get(c.assetId);
    if (!m) return; // 无该候选的度量 ⇒ unconfirmed（不计入，不猜）
    const cc = conclude(m, th);
    if (cc.kind === "confirmed") confirmed.push({ m, idx });
    else if (cc.kind === "refuted") refuted.push({ m, idx });
  });

  const top = strongestOf(confirmed);
  if (top) {
    return {
      assetId: top.m.assetId,
      verdict: "confirmed",
      // 引用式 rationaleRef：指向 detail_json.citationMetrics 的对应条目（可解析，不塞自由文本）
      rationaleRef: `mechanical:confirmed:${top.m.assetId}@${top.m.matchLevel}/cov=${top.m.coverage}/excl=${top.m.exclusionCount}`,
    };
  }
  const topRefuted = strongestOf(refuted);
  if (topRefuted) {
    return {
      assetId: topRefuted.m.assetId,
      verdict: "refuted",
      rationaleRef: `mechanical:refuted:${topRefuted.m.assetId}@excl=${topRefuted.m.exclusionCount}`,
    };
  }
  return { assetId: null, verdict: "unconfirmed", rationaleRef: "mechanical:no-confirmed-candidate" };
}

export class MechanicalJudge implements Judge {
  readonly impl = "mechanical:v1";
  readonly promptRef: PromptRef = {
    memory_prompt_id: "attribution-judge-mechanical-rules-v1",
    version: 1,
    source: "mechanical-judge",
    prompt_sha256: sha256Hex(RULES_VERSION_TEXT),
  };

  async judge(input: JudgeInput): Promise<JudgeVerdict> {
    // 阈值 = 模块常量（C3 写死；扫描走 decideVerdict 的 thresholds 参数）
    return decideVerdict({ candidates: input.candidates, citationMetrics: input.citationMetrics });
  }
}
