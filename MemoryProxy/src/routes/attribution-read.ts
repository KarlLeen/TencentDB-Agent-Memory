/**
 * 72 · S7-a：proxy 侧归因只读面（50 spec §21；回执 DTO + 池候选查询）。
 *
 * 纯只读：只用既有只读 repo 方法（零新增写方法、不改 schema、不动写口）。
 * ⚠️ 68 D1（60 spec §5 "payload 新鲜度契约"）：corrected 的版本字段 = **检测时（首次判定）
 * 快照**——响应**必带 `detected_at`** + `snapshot.semantics="detected_at_snapshot"` 标注；
 * **禁止**出现任何形如 `current_version` 的字段。
 *
 * ⚠️ C5（K2 粒度=轮）：`turn_seq`/`msg_seq` 原样透传，**不得**合成更细粒度字段。
 * ⚠️ C7（单一真相）：判定内容只在 `judgement.detail`；`status_events[].payload` 只回指。
 * ⚠️ C8：取不到的字段一律 `null` 并在 `missing[]` 点名（不猜、不伪造）。
 */
import type { Context } from "hono";

import {
  getAttributionJudgeQueueRepo,
  type JudgeQueueRow,
} from "../attribution/judge-queue-repo.js";
import {
  getAttributionJudgementDetailsRepo,
  type JudgementDetailRow,
} from "../attribution/judgement-details-repo.js";
import { parseSinceMs } from "../attribution/l1-wiring.js";
import {
  getAttributionStatusEventsRepo,
  type StatusEventRow,
} from "../attribution/status-events-repo.js";
import { getAttributionEventRepo, type AttributionEventRowWithRowid } from "../db/attributionEventRepo.js";
import type { ProxyConfig } from "../types.js";

import { adminAuthError, checkAdminAuth } from "./admin-auth.js";

/** 计数用大 limit（既有读口零新方法；真库规模小）。 */
const COUNT_LIMIT = 100_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
/** 30 spec 原文口径（top-N 溢出记账；C6）。 */
function overflowNote(n: number): string {
  return `另有 ${n} 个次要决策未逐一归因（top-N 闸门；保持 pending，下轮 FIFO 优先）`;
}

function ok(c: Context, data: Record<string, unknown>): Response {
  return c.json({ code: 0, message: "ok", data });
}

function error(c: Context, status: 400 | 404, message: string): Response {
  return c.json({ code: status, message }, status);
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface ReadRepos {
  events: ReturnType<typeof getAttributionEventRepo>;
  status: ReturnType<typeof getAttributionStatusEventsRepo>;
  details: ReturnType<typeof getAttributionJudgementDetailsRepo>;
  queue: ReturnType<typeof getAttributionJudgeQueueRepo>;
}

function repos(): ReadRepos {
  return {
    events: getAttributionEventRepo(),
    status: getAttributionStatusEventsRepo(),
    details: getAttributionJudgementDetailsRepo(),
    queue: getAttributionJudgeQueueRepo(),
  };
}

interface Counts {
  units: number;
  judged: number;
  unconfirmed: number;
  used: number;
  corrected: number;
  pending: number;
  failed: number;
}

/** 会话计数（列表行与回执共用；queue 两桶由调用方传入避免 N×全表）。 */
function countsOf(
  key: string,
  evRows: readonly AttributionEventRowWithRowid[],
  stRows: readonly StatusEventRow[],
  jds: readonly JudgementDetailRow[],
  queuePending: readonly JudgeQueueRow[],
  queueFailed: readonly JudgeQueueRow[],
): Counts {
  return {
    units: evRows.filter((e) => e.event_type === "decision_unit.created").length,
    judged: jds.length,
    unconfirmed: jds.filter((j) => j.verdict === "unconfirmed").length,
    used: stRows.filter((s) => s.event_type === "asset_used").length,
    corrected: stRows.filter((s) => s.event_type === "asset_corrected").length,
    pending: queuePending.filter((q) => q.session_key === key).length,
    failed: queueFailed.filter((q) => q.session_key === key).length,
  };
}

/** 版本链快照（60 spec §3）：本会话 fetched 窗口内的观测（DR-6a：不回查当前存储）。 */
function assetsOf(evRows: readonly AttributionEventRowWithRowid[]): Array<Record<string, unknown>> {
  const byAsset = new Map<string, { assetType: string | null; versions: number[] }>();
  for (const r of evRows) {
    if (r.event_type !== "asset_fetched") continue;
    const assetId = r.asset_id;
    if (!assetId) continue;
    const v = safeParse(r.payload_json).version;
    if (typeof v !== "number" || !Number.isFinite(v)) continue; // 取不到省略（不伪造）
    const cur = byAsset.get(assetId) ?? { assetType: r.asset_type ?? null, versions: [] };
    if (!cur.versions.includes(v)) cur.versions.push(v); // 首次出现序去重
    byAsset.set(assetId, cur);
  }
  return [...byAsset.entries()].map(([assetId, x]) => ({
    asset_id: assetId,
    asset_type: x.assetType,
    first_seen_version: x.versions[0] ?? null,
    last_seen_version: x.versions[x.versions.length - 1] ?? null,
    observed_versions: x.versions,
  }));
}

/** 判定 DTO（判定内容只在 detail；列级事实原样透传）。 */
function judgementDto(jd: JudgementDetailRow): Record<string, unknown> {
  return {
    judgement_id: jd.judgement_id,
    verdict: jd.verdict,
    round: jd.round,
    asset_id: jd.asset_id,
    asset_type: jd.asset_type,
    evidence_source_type: jd.evidence_source_type,
    judge_impl: jd.judge_impl,
    prompt_sha256: jd.prompt_sha256,
    detail: safeParse(jd.detail_json),
  };
}

/** status 事件 DTO（corrected 必带 C4 字段：detected_at + snapshot.semantics）。 */
function statusEventDto(s: StatusEventRow): Record<string, unknown> {
  const payload = safeParse(s.payload_json);
  const base: Record<string, unknown> = {
    status_id: s.status_id,
    event_type: s.event_type,
    asset_id: s.asset_id,
    asset_type: s.asset_type,
    round: s.round,
    outcome: s.outcome,
    created_at: s.created_at,
    payload, // 只回指的链接字段（C7；不复制判定内容）
  };
  if (s.event_type !== "asset_corrected") return base;
  return {
    ...base,
    route: typeof payload.correction_route === "string" ? payload.correction_route : null,
    detected_at: s.created_at, // C4：68 D1 快照语义的锚（= 该行 created_at）
    snapshot: {
      anchored_version: typeof payload.anchored_version === "number" ? payload.anchored_version : null,
      latest_version: typeof payload.latest_version === "number" ? payload.latest_version : null,
      semantics: "detected_at_snapshot", // C4：非"当前版本"
    },
  };
}

/** 单元 DTO（K2：turn/msg 原样透传；缺即 null + missing[]）。 */
function unitDto(e: AttributionEventRowWithRowid, r: ReadRepos): Record<string, unknown> {
  const payload = safeParse(e.payload_json);
  const unitId = e.unit_id ?? (typeof payload.unitId === "string" ? payload.unitId : "");
  const missing: string[] = [];
  const jd = r.details.latestByUnit(unitId);
  if (!jd) missing.push("judgement");
  const ses = r.status.listByUnit(unitId, COUNT_LIMIT);
  if (ses.length === 0) missing.push("status_events");
  return {
    unit_id: unitId,
    kind: "decision_unit",
    unit_type: typeof payload.unitType === "string" ? payload.unitType : null,
    turn_seq: e.turn_seq, // C5：原样透传
    msg_seq: e.msg_seq,
    created_at: e.created_at,
    judgement: jd ? judgementDto(jd) : null, // 无判定 ⇒ null（不伪造）
    status_events: ses.map(statusEventDto),
    missing,
  };
}

// ── 端点 1：会话概览列表 ──────────────────────────────────────────────────────

function handleSessions(c: Context, config: ProxyConfig): Response {
  const auth = checkAdminAuth(c, config.admin.apiKey);
  if (auth !== "ok") return adminAuthError(c, auth);

  const sinceRaw = c.req.query("since");
  const limitRaw = c.req.query("limit");
  if (sinceRaw === undefined && limitRaw === undefined) {
    // 69 同款纪律：拒绝无界全表扫（since 与 limit 至少给一个）。
    return error(c, 400, "at least one of `since` or `limit` is required (refuse unbounded full-table scan)");
  }
  let since: number | undefined;
  if (sinceRaw !== undefined) {
    const p = parseSinceMs(sinceRaw);
    if (p === null) return error(c, 400, `invalid since: "${sinceRaw}" (expect epoch ms or ISO8601)`);
    since = p;
  }
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n <= 0) return error(c, 400, `invalid limit: "${limitRaw}"`);
    limit = Math.min(MAX_LIMIT, Math.trunc(n));
  }
  const spaceId = (c.req.query("space_id") ?? "").trim() || "_default"; // C3（缺省 _default；本单不做 ACL）

  const r = repos();
  const keys = [...new Set([...r.events.distinctSessionKeys(since ?? 0), ...r.status.distinctSessionKeys(since ?? 0)])];
  const queuePending = r.queue.listByStatus("pending", COUNT_LIMIT);
  const queueFailed = r.queue.listByStatus("failed", COUNT_LIMIT);
  const rows = keys
    .map((key) => {
      const evRows = r.events.listBySessionWithRowid(key);
      const stRows = r.status.listBySession(key, { limit: COUNT_LIMIT });
      const jds = r.details.listBySession(key, COUNT_LIMIT);
      const times = [...evRows.map((x) => x.created_at), ...stRows.map((x) => x.created_at)];
      const space = evRows[0]?.space_id ?? stRows[0]?.space_id ?? "_default";
      return {
        session_key: key,
        space_id: space,
        first_event_at: times.length > 0 ? Math.min(...times) : 0,
        last_event_at: times.length > 0 ? Math.max(...times) : 0,
        counts: countsOf(key, evRows, stRows, jds, queuePending, queueFailed),
      };
    })
    .filter((row) => row.space_id === spaceId)
    .sort((a, b) => {
      if (a.last_event_at !== b.last_event_at) return b.last_event_at - a.last_event_at;
      return a.session_key < b.session_key ? -1 : a.session_key > b.session_key ? 1 : 0;
    });
  const truncated = rows.length > limit;
  return ok(c, { sessions: rows.slice(0, limit), truncated });
}

// ── 端点 2：回执 DTO（单元分页） ──────────────────────────────────────────────

function handleSessionDetail(c: Context, config: ProxyConfig): Response {
  const auth = checkAdminAuth(c, config.admin.apiKey);
  if (auth !== "ok") return adminAuthError(c, auth);

  const sessionKey = c.req.param("session_key") ?? "";
  let limit = DEFAULT_LIMIT;
  const limitRaw = c.req.query("limit");
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n <= 0) return error(c, 400, `invalid limit: "${limitRaw}"`);
    limit = Math.min(MAX_LIMIT, Math.trunc(n));
  }
  let offset = 0;
  const offsetRaw = c.req.query("offset");
  if (offsetRaw !== undefined) {
    const n = Number(offsetRaw);
    if (!Number.isFinite(n) || n < 0) return error(c, 400, `invalid offset: "${offsetRaw}"`);
    offset = Math.trunc(n);
  }

  const r = repos();
  const evRows = r.events.listBySessionWithRowid(sessionKey);
  const stRows = r.status.listBySession(sessionKey, { limit: COUNT_LIMIT });
  const jds = r.details.listBySession(sessionKey, COUNT_LIMIT);
  if (evRows.length === 0 && stRows.length === 0 && jds.length === 0) {
    return error(c, 404, `session not found: ${sessionKey}`);
  }
  const times = [...evRows.map((x) => x.created_at), ...stRows.map((x) => x.created_at)];
  const queuePending = r.queue.listByStatus("pending", COUNT_LIMIT);
  const queueFailed = r.queue.listByStatus("failed", COUNT_LIMIT);
  const counts = countsOf(sessionKey, evRows, stRows, jds, queuePending, queueFailed);

  const unitEvents = evRows
    .filter((e) => e.event_type === "decision_unit.created")
    .sort((a, b) => {
      // 确定性全序：created_at ASC，同毫秒用 unit_id tie-break（⚠️ 不能用 `??`+`<` 混写：
      // `??` 优先级低于比较运算符，会静默产出非数值比较键——实测教训）。
      if (a.created_at !== b.created_at) return a.created_at - b.created_at;
      const au = a.unit_id ?? "";
      const bu = b.unit_id ?? "";
      return au < bu ? -1 : au > bu ? 1 : 0;
    });
  const page = unitEvents.slice(offset, offset + limit);

  return ok(c, {
    session: {
      session_key: sessionKey,
      space_id: evRows[0]?.space_id ?? stRows[0]?.space_id ?? "_default",
      first_event_at: times.length > 0 ? Math.min(...times) : 0,
      last_event_at: times.length > 0 ? Math.max(...times) : 0,
      // 版本链快照（60 spec §3）：只是本会话 fetched 窗口内的观测（DR-6a：不回查当前存储）。
      assets: assetsOf(evRows),
    },
    counts,
    overflow: { pending: counts.pending, note: overflowNote(counts.pending) }, // C6：可表达溢出
    units: page.map((e) => unitDto(e, r)),
    truncated: offset + limit < unitEvents.length,
  });
}

// ── 端点 3：池候选（未筛集） ─────────────────────────────────────────────────

function handleAuditCandidates(c: Context, config: ProxyConfig): Response {
  const auth = checkAdminAuth(c, config.admin.apiKey);
  if (auth !== "ok") return adminAuthError(c, auth);

  const filterRaw = c.req.query("filter");
  if (filterRaw !== undefined) {
    // 参数位预留：suspect 判据 = S7-b 定稿；本单**不自创判据**、也**不静默忽略**。
    return error(c, 400, `unsupported filter: "${filterRaw}" (suspect criteria lands in S7-b)`);
  }
  let limit = DEFAULT_LIMIT;
  const limitRaw = c.req.query("limit");
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n <= 0) return error(c, 400, `invalid limit: "${limitRaw}"`);
    limit = Math.min(MAX_LIMIT, Math.trunc(n));
  }
  const spaceId = (c.req.query("space_id") ?? "").trim() || "_default";

  const r = repos();
  const keys = [...new Set([...r.events.distinctSessionKeys(0), ...r.status.distinctSessionKeys(0)])];
  const candidates: Array<Record<string, unknown>> = [];
  let unconfirmedCount = 0;
  for (const key of keys) {
    for (const jd of r.details.listBySession(key, COUNT_LIMIT)) {
      if (jd.verdict !== "unconfirmed" || jd.space_id !== spaceId) continue;
      unconfirmedCount += 1;
      const detail = safeParse(jd.detail_json);
      candidates.push({
        kind: "judgement_unconfirmed", // tombstone（rationaleRef='tombstone:result_missing'）含于此集
        unit_id: jd.unit_id,
        session_key: jd.session_key,
        space_id: jd.space_id,
        judgement_id: jd.judgement_id,
        verdict: jd.verdict,
        rationale_ref: typeof detail.rationaleRef === "string" ? detail.rationaleRef : null,
        round: jd.round,
        created_at: jd.created_at,
      });
    }
  }
  const queueRows = [
    ...r.queue.listByStatus("failed", COUNT_LIMIT),
    ...r.queue.listByStatus("pending", COUNT_LIMIT),
  ].filter((q) => q.space_id === spaceId);
  for (const q of queueRows) {
    candidates.push({
      kind: q.status === "failed" ? "queue_failed" : "queue_pending",
      queue_id: q.queue_id,
      unit_id: q.unit_id,
      session_key: q.session_key,
      space_id: q.space_id,
      status: q.status,
      attempts: q.attempts,
      last_error: q.last_error,
      updated_at: q.updated_at,
    });
  }
  candidates.sort((a, b) => Number(b.created_at ?? b.updated_at ?? 0) - Number(a.created_at ?? a.updated_at ?? 0));
  const truncated = candidates.length > limit;
  return ok(c, {
    candidates: candidates.slice(0, limit),
    counts: {
      unconfirmed: unconfirmedCount,
      failed: queueRows.filter((q) => q.status === "failed").length, // 溢出记账（pending 桶）
      pending: queueRows.filter((q) => q.status === "pending").length,
    },
    truncated,
  });
}

export function createAttributionReadHandlers(config: ProxyConfig) {
  return {
    sessions: (c: Context) => handleSessions(c, config),
    sessionDetail: (c: Context) => handleSessionDetail(c, config),
    auditCandidates: (c: Context) => handleAuditCandidates(c, config),
  };
}
