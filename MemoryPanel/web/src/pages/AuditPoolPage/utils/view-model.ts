/**
 * 76 · S7-c 抽查池页：DTO → 视图模型（**纯函数**；零 React / 零 DOM）。
 *
 * - 迁移表与 proxy `AUDIT_TRANSITIONS`（70 spec §2.4）**一致**：UI 只提供合法目标态，
 *   自迁移禁用（服务端仍 400 兜底）；
 * - 七类 category 的展示名与顺序（多命中 ⇒ `categories[]` 全列，不丢信息）；
 * - "未执行"（tombstone）在池侧由 S7-b 硬排除，本页不出现。
 */
import type { PoolDto, PoolItem } from '@/lib/api/attribution';

/** 状态迁移表（与 proxy `attribution_audit_reviews.AUDIT_TRANSITIONS` 同步；自迁移禁）。 */
export const AUDIT_TRANSITIONS: Record<string, readonly string[]> = {
  unreviewed: ['confirmed', 'dismissed', 'needs_fix'],
  confirmed: ['needs_fix', 'dismissed'],
  dismissed: ['needs_fix'],
  needs_fix: ['confirmed', 'dismissed'],
};

export const AUDIT_STATUSES = ['unreviewed', 'confirmed', 'dismissed', 'needs_fix'] as const;

/** 七类展示顺序（与 70 spec §2.2 表一致）。 */
export const CATEGORY_ORDER = [
  'suspect:truncated',
  'suspect:low_coverage',
  'suspect:no_metrics',
  'suspect:malformed',
  'disagreement:flip',
  'disagreement:corrected',
  'orphan:dead_letter',
] as const;

export function allowedTransitions(current: string | null | undefined): readonly string[] {
  return AUDIT_TRANSITIONS[current ?? 'unreviewed'] ?? [];
}

export function canSubmit(current: string | null | undefined, target: string): boolean {
  return allowedTransitions(current).includes(target);
}

export interface PoolItemView {
  audit_key: string;
  unit_id: string;
  round: number;
  category: string;
  /** 多命中全列（不丢信息）。 */
  categories: string[];
  categoryLabel: string;
  verdict: string | null;
  rationale_ref: string | null;
  session_key: string;
  created_at: number;
  /**
   * 77 · S7-d：**服务端 latest**（池 DTO latest-join；无行 ⇒ `"unreviewed"`）。
   * 唯一真相——本地"本会话记录"不再是判据。
   */
  reviewStatus: string;
  reviewActor: string | null;
  reviewAt: number | null;
}

/** T5：当前状态的**唯一真相 = 服务端值**（本地记录仅作提交瞬间的乐观反馈）。 */
export function currentStatusOf(item: PoolItemView): string {
  return item.reviewStatus;
}

/** T6：提交成功后的 reconcile——**服务端值优先**（乐观值不覆盖服务端结果）。 */
export function reconcileStatusFromServer(serverStatus: string): string {
  return serverStatus;
}

export interface PoolView {
  items: PoolItemView[];
  /** 过滤前全类计数（与 items 可对账）。 */
  countsByCategory: Record<string, number>;
  categoryOrder: readonly string[];
  truncated: boolean;
}

function categoryLabel(category: string): string {
  const idx = category.indexOf(':');
  return idx >= 0 ? category.slice(idx + 1) : category;
}

export function toPoolItemView(item: PoolItem): PoolItemView {
  return {
    audit_key: item.audit_key,
    unit_id: item.unit_id,
    round: item.round,
    category: item.category,
    categories: [...item.categories],
    categoryLabel: categoryLabel(item.category),
    verdict: item.verdict,
    rationale_ref: item.rationale_ref,
    session_key: item.session_key,
    created_at: item.created_at,
    reviewStatus: item.review_status ?? 'unreviewed',
    reviewActor: item.review_actor ?? null,
    reviewAt: item.review_at ?? null,
  };
}

export function toPoolView(dto: PoolDto): PoolView {
  return {
    items: dto.items.map(toPoolItemView),
    countsByCategory: { ...dto.counts_by_category },
    categoryOrder: CATEGORY_ORDER,
    truncated: dto.truncated,
  };
}
