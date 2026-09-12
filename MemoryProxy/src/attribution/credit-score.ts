/**
 * 97 · S8-a：信用分**聚合层**（纯函数 + 只读装配；**零接线、无开关、零 DDL**）。
 *
 * D0 = (a) 纠正率口径 + 贝叶斯平滑（裁定；口径与登记义务见
 * `docs/implementation/80-credit-score-and-ranking.md`）：
 *
 *   credit = ((used − corrected) + k × baseline) / (used + k)
 *
 *   - `used` / `corrected` = 按 `(asset_id, session_key)` **去重会话数**（同会话 5 次 used
 *     只算 1 对，防水；口径同 §3.5 = rollupByAsset 的 session_count）；
 *   - `baseline` = **全团队加权** `(Σused − Σcorrected) / Σused`（**不是**"各资产平均的平均"）；
 *   - **中性返回不许凑数**：`Σused = 0` ⇒ baseline = null；本资产 `used = 0` ⇒ credit = baseline
 *     （可能为 null）；**两者皆 null ⇒ credit = null**——调用方**不得**自行取 0.5；
 *   - **语义收窄（必须如实登记）**：本口径回答的是"**被采纳后有没有被推翻**"，
 *     **不是**"历史上有多可靠"（幸存者偏差见 80 spec §2）。
 *
 * 边界：**不接任何排序行为**（S8-b 才接线）、不改既有读口语义、不动 schema。
 */
import {
  getAttributionStatusEventsRepo,
  STATUS_EVENT_TYPE_ASSET_CORRECTED,
  STATUS_EVENT_TYPE_ASSET_USED,
} from "./status-events-repo.js";

/** 先验强度 k（弱先验；调大 ⇒ 更趋近 baseline，调 0 ⇒ 硬比例）。 */
export const CREDIT_K_DEFAULT = 5;

/** 团队总量（Σ 用**去重会话数**求和；口径说明见 rollupCreditsByAsset）。 */
export interface TeamTotals {
  used: number;
  corrected: number;
}

/** 聚合输入（**已按 (asset_id, session_key) 去重**；不变式 `corrected_sessions ≤ used_sessions`）。 */
export interface AssetCreditInput {
  asset_id: string;
  used_sessions: number;
  corrected_sessions: number;
}

/** 可解释输出：分子分母必须能看见（供 S8-b 与回执呈现）。 */
export interface AssetCredit {
  asset_id: string;
  credit: number | null;
  used: number;
  corrected: number;
  baseline: number | null;
}

/** 团队加权基线：`(Σused − Σcorrected) / Σused`；Σused = 0 ⇒ null（无定义，不猜）。 */
export function computeTeamBaseline(team: TeamTotals): number | null {
  if (team.used <= 0) return null;
  return (team.used - team.corrected) / team.used;
}

/** 不变式破坏（corrected > used）的夹取计数（fail-closed：夹取 + 计数，**不抛**）。 */
const clampCounters = { clamped: 0 };
export function getCreditClampCounters(): { clamped: number } {
  return { ...clampCounters };
}
export function __resetCreditClampCountersForTests(): void {
  clampCounters.clamped = 0;
}

/**
 * 单资产信用分（纯函数）。输入必须**已去重**；本函数只做公式与边界。
 * `k` 缺省 `CREDIT_K_DEFAULT`；显式传参可覆盖（S8-b 前可调）。
 */
export function computeAssetCredit(
  input: AssetCreditInput,
  team: TeamTotals,
  k: number = CREDIT_K_DEFAULT,
): AssetCredit {
  const baseline = computeTeamBaseline(team);

  let corrected = input.corrected_sessions;
  if (corrected > input.used_sessions) {
    // fail-closed：夹取 + 计数，不抛（数据面异常不应炸调用方）。
    corrected = input.used_sessions;
    clampCounters.clamped += 1;
  }

  let credit: number | null;
  if (input.used_sessions === 0) {
    // 中性返回：used = 0 ⇒ credit = baseline；baseline 也为 null ⇒ credit = null（调用方不得凑 0.5）。
    credit = baseline;
  } else if (baseline === null) {
    // 防御：本资产 used > 0 ⇒ Σused ≥ used > 0 ⇒ 不变式下不可达；仍 fail-closed 不猜。
    credit = null;
  } else {
    credit =
      (input.used_sessions - corrected + k * baseline) / (input.used_sessions + k);
  }

  return {
    asset_id: input.asset_id,
    credit,
    used: input.used_sessions,
    corrected,
    baseline,
  };
}

/**
 * 只读装配：per-asset **去重会话数**（used / corrected）→ 逐资产信用分。
 *
 * 复用既有读口 `rollupByAsset({ eventType })`（其 `session_count` = `COUNT(DISTINCT session_key)`，
 * 口径即 §3.5）；**不改其语义、零 DDL、不物化**。
 * Σ 口径：对"有 used 的资产"求和（分子分母同集合；corrected 取同一集合内的值）。
 */
export function rollupCreditsByAsset(): AssetCredit[] {
  const repo = getAttributionStatusEventsRepo();
  const usedRows = repo.rollupByAsset({ eventType: STATUS_EVENT_TYPE_ASSET_USED });
  const correctedRows = repo.rollupByAsset({ eventType: STATUS_EVENT_TYPE_ASSET_CORRECTED });
  const correctedByAsset = new Map(correctedRows.map((r) => [r.asset_id, r.session_count]));

  const inputs: AssetCreditInput[] = usedRows.map((r) => ({
    asset_id: r.asset_id,
    used_sessions: r.session_count,
    corrected_sessions: correctedByAsset.get(r.asset_id) ?? 0,
  }));

  const team: TeamTotals = { used: 0, corrected: 0 };
  for (const i of inputs) {
    team.used += i.used_sessions;
    team.corrected += i.corrected_sessions;
  }

  return inputs.map((i) => computeAssetCredit(i, team));
}

/**
 * 排序辅助（纯函数，**仅提供、不接线**）：非 null 项按 credit 降序**稳定**填入非 null 位；
 * `credit = null` 的项视为"不参与"——**原位不动**（保持调用方原序语义）。
 */
export function rankByCredit<T extends { credit: number | null }>(items: readonly T[]): T[] {
  const positions: number[] = [];
  const picked: T[] = [];
  items.forEach((it, i) => {
    if (it.credit !== null) {
      positions.push(i);
      picked.push(it);
    }
  });
  picked.sort((a, b) => (b.credit as number) - (a.credit as number)); // V8 sort 稳定
  const out = [...items];
  positions.forEach((p, j) => {
    out[p] = picked[j]!;
  });
  return out;
}
