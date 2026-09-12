/**
 * 74 · S7-b 抽查/分歧池判据引擎（70 spec §2.1–§2.3）。
 *
 * - **全部机械可复算、零新增字段**（建在已落库的键上）；
 * - **只读**：本模块不写任何行（写口在 `audit-reviews-repo.ts`）；
 * - 定义句（逐字，70 spec §2.2）：**`unconfirmed_suspect` = `suspect:*` 四类的并集**；
 *   不许引入任何需要人判或随机数的判据。**禁 `Math.random()`**（抽样若需要 ⇒ 确定性哈希）。
 */
import { createHash } from "node:crypto";

import { getAttributionEventRepo } from "../db/attributionEventRepo.js";
import { getAttributionJudgeQueueRepo } from "./judge-queue-repo.js";
import { getAttributionJudgementDetailsRepo, type JudgementDetailRow } from "./judgement-details-repo.js";
import { getAttributionStatusEventsRepo, type StatusEventRow } from "./status-events-repo.js";

const COUNT_LIMIT = 100_000;

/** 低覆盖阈值（口径照 74 工单 F4④：T_COV=0.5；"unknown" 视作不满足阈值）。 */
export const T_COV = 0.5;

export const AUDIT_CATEGORIES = [
  "suspect:truncated",
  "suspect:low_coverage",
  "suspect:no_metrics",
  "suspect:malformed",
  "disagreement:flip",
  "disagreement:corrected",
  "orphan:dead_letter",
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** tombstone 硬排除：不入 `suspect:*`（避免与"未执行"类重复计数）。 */
export const TOMBSTONE_RATIONALE_REF = "tombstone:result_missing";

/** 稳定键（70 spec §2.1）：`ak_ + sha1(unit_id|round|category).slice(0,12)`。 */
export function deriveAuditKey(unitId: string, round: number, category: string): string {
  const sha = createHash("sha1").update(`${unitId}|${round}|${category}`, "utf8").digest("hex");
  return `ak_${sha.slice(0, 12)}`;
}

export interface AuditPoolItem {
  audit_key: string;
  unit_id: string;
  round: number;
  category: string;
  /** 该 (unit_id, round) 的全部命中类（多命中不丢信息）。 */
  categories: string[];
  verdict: string | null;
  judge_impl: string | null;
  rationale_ref: string | null;
  session_key: string;
  created_at: number;
}

export interface AuditPoolResult {
  items: AuditPoolItem[];
  countsByCategory: Record<string, number>;
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rationaleRefOf(jd: JudgementDetailRow): string | null {
  const d = safeParse(jd.detail_json);
  return typeof d.rationaleRef === "string" ? d.rationaleRef : null;
}

/** `suspect:truncated`：unconfirmed 且 shortlist.overflowCount > 0。 */
function isTruncated(jd: JudgementDetailRow): boolean {
  const d = safeParse(jd.detail_json);
  const s = d.shortlist;
  if (s === null || typeof s !== "object") return false;
  const n = (s as Record<string, unknown>).overflowCount;
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * `suspect:low_coverage`：`citationMetrics` 缺失/空 **或** `max(数值 coverage)` < `T_COV`
 * （`"unknown"` 视作不满足阈值 ⇒ 全 unknown 折为"无达标证据"）。
 */
function isLowCoverage(jd: JudgementDetailRow): boolean {
  const d = safeParse(jd.detail_json);
  const m = d.citationMetrics;
  if (!Array.isArray(m) || m.length === 0) return true;
  const nums = m
    .map((x) => (x !== null && typeof x === "object" ? (x as Record<string, unknown>).coverage : undefined))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return true;
  return Math.max(...nums) < T_COV;
}

/** 取该 unit 的 latest 判定（round DESC、created_at DESC、judgement_id 兜底——乱序全序）。 */
function latestOf(rounds: readonly JudgementDetailRow[]): JudgementDetailRow {
  return [...rounds].sort((a, b) => {
    if (a.round !== b.round) return b.round - a.round;
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.judgement_id < b.judgement_id ? 1 : a.judgement_id > b.judgement_id ? -1 : 0;
  })[0]!;
}

/**
 * 构建池（跨会话；space 过滤在调用方或此处按行 space_id 判）。
 * `spaceId` 缺省 `_default`（与 S7-a C3 一致）。
 */
export function buildAuditPool(opts: { spaceId?: string } = {}): AuditPoolResult {
  const spaceId = opts.spaceId ?? "_default";
  const events = getAttributionEventRepo();
  const status = getAttributionStatusEventsRepo();
  const details = getAttributionJudgementDetailsRepo();
  const queue = getAttributionJudgeQueueRepo();

  const sessions = [
    ...new Set([...events.distinctSessionKeys(0), ...status.distinctSessionKeys(0)]),
  ].sort();
  const items: AuditPoolItem[] = [];

  const pushItem = (
    unitId: string,
    round: number,
    categories: string[],
    meta: {
      verdict: string | null;
      judgeImpl: string | null;
      rationaleRef: string | null;
      sessionKey: string;
      createdAt: number;
    },
  ): void => {
    const sorted = [...categories].sort();
    for (const category of sorted) {
      items.push({
        audit_key: deriveAuditKey(unitId, round, category),
        unit_id: unitId,
        round,
        category,
        categories: sorted, // 行内携带该 (unit, round) 的完整命中集
        verdict: meta.verdict,
        judge_impl: meta.judgeImpl,
        rationale_ref: meta.rationaleRef,
        session_key: meta.sessionKey,
        created_at: meta.createdAt,
      });
    }
  };

  for (const sessionKey of sessions) {
    const jds = details.listBySession(sessionKey, COUNT_LIMIT).filter((j) => j.space_id === spaceId);
    const sts: StatusEventRow[] = status.listBySession(sessionKey, { limit: COUNT_LIMIT });
    const correctedAssets = new Set(
      sts.filter((s) => s.event_type === "asset_corrected").map((s) => s.asset_id),
    );

    // 单元维度（含多轮 ⇒ flip 需要全量 rounds）。
    const byUnit = new Map<string, JudgementDetailRow[]>();
    for (const jd of jds) {
      const list = byUnit.get(jd.unit_id);
      if (list) list.push(jd);
      else byUnit.set(jd.unit_id, [jd]);
    }
    for (const [unitId, rounds] of byUnit) {
      const latest = latestOf(rounds);
      const rationaleRef = rationaleRefOf(latest);
      const categories: string[] = [];

      // suspect:* —— 前提 = unconfirmed；tombstone 硬排除。
      if (latest.verdict === "unconfirmed" && rationaleRef !== TOMBSTONE_RATIONALE_REF) {
        if (isTruncated(latest)) categories.push("suspect:truncated");
        if (isLowCoverage(latest)) categories.push("suspect:low_coverage");
        if (rationaleRef === "mechanical:no-metrics") categories.push("suspect:no_metrics");
        if (typeof rationaleRef === "string" && rationaleRef.startsWith("malformed:")) {
          categories.push("suspect:malformed");
        }
      }
      // disagreement:flip —— 不看 verdict（tombstone 不排除：硬排除仅 suspect 系）。
      if (rounds.length >= 2 && new Set(rounds.map((r) => r.verdict)).size > 1) {
        categories.push("disagreement:flip");
      }
      // disagreement:corrected —— 该 unit 的 used 资产存在 corrected 行（同 session 域）。
      const usedAssets = sts
        .filter((s) => s.unit_id === unitId && s.event_type === "asset_used")
        .map((s) => s.asset_id);
      if (usedAssets.some((a) => correctedAssets.has(a))) {
        categories.push("disagreement:corrected");
      }

      if (categories.length > 0) {
        pushItem(unitId, latest.round, categories, {
          verdict: latest.verdict,
          judgeImpl: latest.judge_impl,
          rationaleRef,
          sessionKey,
          createdAt: latest.created_at,
        });
      }
    }

    // orphan:dead_letter —— queue failed（无判定字段 ⇒ null）。
    const sessionFailed = queue
      .listByStatus("failed", COUNT_LIMIT)
      .filter((q) => q.session_key === sessionKey && q.space_id === spaceId);
    for (const q of sessionFailed) {
      pushItem(q.unit_id, q.round, ["orphan:dead_letter"], {
        verdict: null,
        judgeImpl: null,
        rationaleRef: null,
        sessionKey,
        createdAt: q.updated_at,
      });
    }
  }

  const countsByCategory: Record<string, number> = {};
  for (const c of AUDIT_CATEGORIES) countsByCategory[c] = 0;
  for (const item of items) countsByCategory[item.category] = (countsByCategory[item.category] ?? 0) + 1;
  return { items, countsByCategory };
}
