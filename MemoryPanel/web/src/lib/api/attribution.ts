/**
 * api/attribution.ts — 归因面板（回执 + 抽查池）API 客户端。
 *
 * 走 Panel BFF `/api/v1/attribution/*`（RPC，全 POST；三头鉴权照 meta 惯例），
 * BFF 内部再转 context-proxy 的 `/v3/admin/attribution/*`。
 *
 * 契约来源：`docs/implementation/70-panel-read-and-audit-pool.md`（§1 回执 DTO / §2 池）。
 * 错误码（BFF 稳定枚举，前端按此分支；文案走 i18n `attribution.error.*`）：
 *   ATTRIBUTION_PROXY_NOT_CONFIGURED / _UNAUTHORIZED / _UNREACHABLE / _BAD_REQUEST /
 *   _NOT_FOUND / _UNAVAILABLE / _PROTOCOL_ERROR
 */
import { ApiError, request, unwrapEnvelope } from './base';
import { getPanelSession } from '../panelSession';
import type { MetaEnvelope } from './types';

export interface Counts {
  units: number;
  judged: number;
  unconfirmed: number;
  used: number;
  corrected: number;
  pending: number;
  failed: number;
}

export interface SessionSummary {
  session_key: string;
  space_id: string;
  first_event_at: number;
  last_event_at: number;
  counts: Counts;
}

/** 版本链快照（60 spec §3：仅本会话 fetched 窗口内的观测）。 */
export interface ReceiptAsset {
  asset_id: string;
  asset_type: string | null;
  first_seen_version: number | null;
  last_seen_version: number | null;
  observed_versions: number[];
}

export interface JudgementDetail {
  [key: string]: unknown;
}

export interface ReceiptJudgement {
  judgement_id: string;
  verdict: string;
  round: number;
  asset_id: string | null;
  asset_type: string | null;
  evidence_source_type: string | null;
  judge_impl: string;
  prompt_sha256: string | null;
  detail: JudgementDetail;
}

export interface ReceiptStatusEvent {
  status_id: string;
  event_type: string;
  asset_id: string | null;
  asset_type: string | null;
  round: number;
  outcome: string | null;
  created_at: number;
  /** corrected 才有（payload.correction_route）。 */
  route?: string | null;
  /** corrected 必带（= created_at；68 D1）。 */
  detected_at?: number;
  snapshot?: { anchored_version: number | null; latest_version: number | null; semantics: string };
  payload: Record<string, unknown>;
}

export interface ReceiptUnit {
  unit_id: string;
  kind: string;
  unit_type: string | null;
  turn_seq: number;
  msg_seq: number;
  created_at: number;
  judgement: ReceiptJudgement | null;
  status_events: ReceiptStatusEvent[];
  missing: string[];
}

export interface ReceiptDto {
  session: {
    session_key: string;
    space_id: string;
    first_event_at: number;
    last_event_at: number;
    assets: ReceiptAsset[];
  };
  counts: Counts;
  overflow: { pending: number; note: string };
  units: ReceiptUnit[];
  truncated: boolean;
}

export interface PoolItem {
  audit_key: string;
  unit_id: string;
  round: number;
  category: string;
  categories: string[];
  verdict: string | null;
  judge_impl: string | null;
  rationale_ref: string | null;
  session_key: string;
  created_at: number;
  /** 77 · S7-d：服务端 latest（无行 ⇒ `"unreviewed"`）——**唯一真相**。 */
  review_status: string;
  review_actor: string | null;
  review_at: number | null;
}

export interface PoolDto {
  items: PoolItem[];
  counts_by_category: Record<string, number>;
  truncated: boolean;
}

export interface ReviewResult {
  review_id: string;
  status: string;
  prev_status: string;
  kind: 'inserted' | 'duplicate';
}

const PREFIX = '/api/v1/attribution';

async function attributionPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const session = getPanelSession();
  if (!session) {
    throw new ApiError(401, 'Unauthorized', 'no active panel session');
  }
  const headers: Record<string, string> = { 'X-Tdai-Service-Id': session.instanceId };
  // IdP Session 用 HttpOnly Cookie 认证，user_key 不下发到浏览器。
  if (session.userKey) headers['X-Tdai-User-Key'] = session.userKey;
  const envelope = await request<MetaEnvelope<T>>('POST', `${PREFIX}${path}`, body, headers);
  return unwrapEnvelope(envelope, 'empty attribution response');
}

export const attributionApi = {
  /** 会话概览（`limit`/`since` 至少给一个——BFF 侧同款拒绝）。 */
  sessions: (body: { since?: number | string; limit?: number; space_id?: string }) =>
    attributionPost<{ sessions: SessionSummary[]; truncated: boolean }>('/sessions', body),
  /** 回执 DTO（主对象 = 决策单元）。 */
  receipt: (body: { session_key: string; limit?: number; offset?: number }) =>
    attributionPost<ReceiptDto>('/receipt', body),
  /**
   * 抽查/分歧池（查询层）。`review_status` ⇒ **服务端过滤**（append；缺省不传 = 不过滤）——
   * "只看未审"必须走服务端，客户端在分页后过滤会漏项。`counts_by_category` 仍为过滤前全类。
   */
  pool: (body: {
    category?: string;
    review_status?: string;
    space_id?: string;
    limit?: number;
    offset?: number;
  }) => attributionPost<PoolDto>('/pool', body),
  /**
   * 状态写口。⚠️ `actor` **不由前端传**：BFF 从 `x-tdai-user-key` 服务端注入
   * （body 里即使有 actor 也会被忽略——审计身份不可伪造）。
   */
  review: (body: { audit_key: string; prev_status: string; status: string; note?: string }) =>
    attributionPost<ReviewResult>('/review', body),
};
