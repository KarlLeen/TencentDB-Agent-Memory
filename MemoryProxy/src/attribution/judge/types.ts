/**
 * 归因 judge 的接口形状（design §4.4 / §4.5）。
 *
 * ⚠️ 命名隔离（F23）：本目录的 `Judge*` 与既有 CostGuard 的 `src/judge-client.ts`
 * （`JudgeServiceConfig` / `judgeAgentTurn`…）**无关**。为免误读：
 *   - 本基座的类型只从 `src/attribution/judge/types.js` 导出，不进任何全局 barrel；
 *   - provider / 开关一律走 `config.attribution.judge.*` 命名空间。
 *
 * 本期只出**基座**：mock 是唯一实现，真 provider 属 50 spec。
 */

/** prompt 版本引用（可审计：落表 + 落日志都用它，不用裸字符串）。 */
export interface PromptRef {
  /** 稳定 id，如 "attribution-judge-v1"。 */
  memory_prompt_id: string;
  /** 版本号；文本变更 ⇒ +1。 */
  version: number;
  /** 来源模块标识，便于溯源到代码位置。 */
  source: string;
  /** 模板文本的 sha256（hex）。 */
  prompt_sha256: string;
}

export type JudgeVerdictKind = "confirmed" | "refuted" | "unconfirmed";

/** 证据来源类型（可空：不知道就不写，别猜）。 */
export type JudgeEvidenceSourceType = "fetched" | "injected";

/**
 * 候选资产。**本基座只承载，不做任何筛选**（基座-c 的排他性检查才给度量，
 * 且只出度量不出阈值 —— design §4.8）。
 */
export interface JudgeCandidate {
  assetId: string;
  assetType: string;
  evidenceSourceType: JudgeEvidenceSourceType | null;
}

/** judge 的单次输入（自足：不进 DB 回查 v1 表，§4.4）。 */
export interface JudgeInput {
  unitId: string;
  sessionKey: string;
  round: number;
  unit: { kind: string; payload: unknown };
  candidates: JudgeCandidate[];
  promptRef: PromptRef;
  /**
   * 58 · 可选：三道机械锚点的逐候选度量（§12 `grading.ts` 产物，worker 无条件传入）。
   * 可选 ⇒ golden / 既有契约不破；mock 不读；`mechanical` 缺它 ⇒ 全 unconfirmed（不猜）。
   */
  citationMetrics?: import("../citation/grading.js").CandidateCitationMetrics[];
}

/**
 * judge 判定结果。**一次调用一个 verdict**（对应落点表一行）。
 * `assetId: null` = 未归因（无法指认到具体资产）。
 */
export interface JudgeVerdict {
  assetId: string | null;
  verdict: JudgeVerdictKind;
  /** 引用式：指向 rationale 的标识，**不塞自由文本**（避免把 prompt 输出当日志）。 */
  rationaleRef: string;
}

export interface Judge {
  /** 实现标识，落 `judge_impl` 列，如 "mock:v1"。 */
  readonly impl: string;
  readonly promptRef: PromptRef;
  judge(input: JudgeInput): Promise<JudgeVerdict>;
}
