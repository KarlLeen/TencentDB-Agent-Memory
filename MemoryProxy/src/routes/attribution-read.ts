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
 * ⚠️ `145`：`session.assets` = **并集**（fetched ∪ injected ∪ used ∪ corrected）+ 三态旗标
 * （`injected`/`used`/`corrected`）；版本链三字段语义不变（见 `assetsOf` 头注；并集依据 =
 * "待验证 = 仅 injected、无 used" 需要注入证据，且实库 injected 资产集非 fetched 子集）。
 */
import type { Context } from "hono";

import {
  AUDIT_CATEGORIES,
  buildAuditPool,
} from "../attribution/audit-pool.js";
import {
  AUDIT_PREV_STATUSES,
  AUDIT_STATUSES,
  AUDIT_TRANSITIONS,
  deriveReviewId,
  getAttributionAuditReviewsRepo,
} from "../attribution/audit-reviews-repo.js";
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

function error(
  c: Context,
  status: 400 | 404 | 503,
  message: string,
  data?: Record<string, unknown>,
): Response {
  // 77 · S7-d：可选 `data`（如 400 的 current_status）——让"原因"可被前端结构化消费，
  // 而不是把解释藏在自由文本里（"不许只回 400"）。
  return c.json(data === undefined ? { code: status, message } : { code: status, message, data }, status);
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
  /** 120 · C1：**有 `decision_unit.created` 事件的 unit 去重数**（= 行列表的总体口径，**不是**本页行数）。
   *  UI 用 `units − units_with_created_event` 标注"仅见于队列/判定、无可展示事件"的差额
   *  （两数皆服务端给 ⇒ 不受分页影响；`70 spec §1` DTO 同批登记）。 */
  units_with_created_event: number;
  judged: number;
  unconfirmed: number;
  used: number;
  corrected: number;
  pending: number;
  failed: number;
}

/**
 * 119 · C：`Units` 口径 = **事件 / 判定 / 队列**三源覆盖的 unit **去重数**（空 unit_id 不计）。
 * 依据 `118` F4/F6/F9：非 `decision_unit` 路径（`task_boundary`/`manual`）不写 created 事件，
 * 只看事件会把"确实被送去判定过"的单元漏掉；并 queue 后 `c98a` 计入（`Units 2 → 3`）。
 */
function countUnits(
  evRows: readonly AttributionEventRowWithRowid[],
  jds: readonly JudgementDetailRow[],
  queueRows: readonly JudgeQueueRow[],
): { units: number; unitsWithCreatedEvent: number } {
  const ids = new Set<string>();
  const createdIds = new Set<string>(); // 120 · C1：同一遍扫描顺带产出（不新增第二遍）
  for (const e of evRows) {
    if (e.event_type === "decision_unit.created" && e.unit_id) {
      ids.add(e.unit_id);
      createdIds.add(e.unit_id);
    }
  }
  for (const j of jds) if (j.unit_id) ids.add(j.unit_id);
  for (const q of queueRows) if (q.unit_id) ids.add(q.unit_id);
  return { units: ids.size, unitsWithCreatedEvent: createdIds.size };
}

/** 会话计数（列表行与回执共用；queue 两桶由调用方传入避免 N×全表）。 */
function countsOf(
  key: string,
  evRows: readonly AttributionEventRowWithRowid[],
  stRows: readonly StatusEventRow[],
  jds: readonly JudgementDetailRow[],
  queuePending: readonly JudgeQueueRow[],
  queueFailed: readonly JudgeQueueRow[],
  queueRows: readonly JudgeQueueRow[], // 119 · A′：该会话 queue 行（Units 口径 + 展示）
): Counts {
  const u = countUnits(evRows, jds, queueRows); // 120 · C1：一次扫描出两数（units / units_with_created_event）
  return {
    units: u.units, // 119 · C：三源并集（不再只看 created 事件）
    units_with_created_event: u.unitsWithCreatedEvent,
    judged: jds.length,
    unconfirmed: jds.filter((j) => j.verdict === "unconfirmed").length,
    used: stRows.filter((s) => s.event_type === "asset_used").length,
    corrected: stRows.filter((s) => s.event_type === "asset_corrected").length,
    pending: queuePending.filter((q) => q.session_key === key).length,
    failed: queueFailed.filter((q) => q.session_key === key).length,
  };
}

/**
 * 本会话涉及的资产（`145` 起扩为**并集**：fetched ∪ injected ∪ used ∪ corrected）。
 *
 * - 版本链三字段（`first_seen_version`/`last_seen_version`/`observed_versions`）语义**不变**
 *   （60 spec §3：仅本会话 fetched 窗口内的观测；未 fetched 的资产 ⇒ 空数组，**不伪造**）；
 * - `injected`/`used`/`corrected` = **并列新增**三态布尔（由事件/状态行派生；只读、零新方法）；
 * - 顺序 = **首见序**（先 `evRows`（fetched / injection），后 status-only）。
 *
 * 依据：`145` C2 的"待验证 = 仅 injected、无 used"需要注入证据；实库只读盘点
 * 证明 injected 资产集**不是** fetched 的子集（injected 14 / fetched 9，见 `145` 报告）。
 */
function assetsOf(
  evRows: readonly AttributionEventRowWithRowid[],
  stRows: readonly StatusEventRow[],
): Array<Record<string, unknown>> {
  interface Acc {
    assetType: string | null;
    versions: number[];
    injected: boolean;
    used: boolean;
    corrected: boolean;
  }
  const byAsset = new Map<string, Acc>();
  const ensure = (assetId: string, assetType: string | null): Acc => {
    let cur = byAsset.get(assetId);
    if (!cur) {
      cur = { assetType: assetType ?? null, versions: [], injected: false, used: false, corrected: false };
      byAsset.set(assetId, cur);
    } else if (cur.assetType === null && assetType !== null) {
      cur.assetType = assetType; // 首个非空类型胜出（不改已取值）
    }
    return cur;
  };
  for (const r of evRows) {
    if (r.event_type === "asset_fetched") {
      const assetId = r.asset_id;
      if (!assetId) continue;
      const v = safeParse(r.payload_json).version;
      if (typeof v !== "number" || !Number.isFinite(v)) continue; // 取不到省略（不伪造）
      const cur = ensure(assetId, r.asset_type ?? null);
      if (!cur.versions.includes(v)) cur.versions.push(v); // 首次出现序去重
    } else if (r.event_type === "injection.hook.done" && r.asset_id) {
      // 注入证据（`injection.attribution-event-observer.ts`：按资产摊行，asset_id 非空才算一行）。
      ensure(r.asset_id, r.asset_type ?? null).injected = true;
    }
  }
  for (const s of stRows) {
    if (!s.asset_id) continue; // 状态行无资产（如 channel 级）⇒ 不进资产表
    const cur = ensure(s.asset_id, s.asset_type ?? null);
    if (s.event_type === "asset_used") cur.used = true;
    else if (s.event_type === "asset_corrected") cur.corrected = true;
  }
  return [...byAsset.entries()].map(([assetId, x]) => ({
    asset_id: assetId,
    asset_type: x.assetType,
    first_seen_version: x.versions[0] ?? null,
    last_seen_version: x.versions[x.versions.length - 1] ?? null,
    observed_versions: x.versions,
    injected: x.injected,
    used: x.used,
    corrected: x.corrected,
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
  // 119 · A′：可见性来源 = events ∪ status ∪ **queue**（D2 语义句："被观测到／被送去判定过／有判定结果"之一）。
  const keys = [
    ...new Set([
      ...r.events.distinctSessionKeys(since ?? 0),
      ...r.status.distinctSessionKeys(since ?? 0),
      ...r.queue.distinctSessionKeys(since ?? 0),
    ]),
  ];
  const queuePending = r.queue.listByStatus("pending", COUNT_LIMIT);
  const queueFailed = r.queue.listByStatus("failed", COUNT_LIMIT);
  const rows = keys
    .map((key) => {
      const evRows = r.events.listBySessionWithRowid(key);
      const stRows = r.status.listBySession(key, { limit: COUNT_LIMIT });
      const jds = r.details.listBySession(key, COUNT_LIMIT);
      const qRows = r.queue.listBySession(key, { limit: COUNT_LIMIT }); // 119 · A′
      const times = [
        ...evRows.map((x) => x.created_at),
        ...stRows.map((x) => x.created_at),
        ...qRows.map((x) => x.created_at), // F11：无事件会话的时间兜底（queue.created_at）
      ];
      // T1：无事件/无 status 的会话（如 sess-1）继续派生成 _default 会被 space 过滤丢掉 ⇒ 派生链加 queue。
      const space = evRows[0]?.space_id ?? stRows[0]?.space_id ?? qRows[0]?.space_id ?? "_default";
      return {
        session_key: key,
        space_id: space,
        first_event_at: times.length > 0 ? Math.min(...times) : 0,
        last_event_at: times.length > 0 ? Math.max(...times) : 0,
        counts: countsOf(key, evRows, stRows, jds, queuePending, queueFailed, qRows),
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
  const qRows = r.queue.listBySession(sessionKey, { limit: COUNT_LIMIT }); // 119 · A′（口径一致性：与列表/池同源）
  if (evRows.length === 0 && stRows.length === 0 && jds.length === 0 && qRows.length === 0) {
    // 119：D2 语义句"被送去判定过 ⇒ 视为可见" ⇒ queue-only 会话不再 404。
    return error(c, 404, `session not found: ${sessionKey}`);
  }
  const times = [
    ...evRows.map((x) => x.created_at),
    ...stRows.map((x) => x.created_at),
    ...qRows.map((x) => x.created_at),
  ];
  const queuePending = r.queue.listByStatus("pending", COUNT_LIMIT);
  const queueFailed = r.queue.listByStatus("failed", COUNT_LIMIT);
  const counts = countsOf(sessionKey, evRows, stRows, jds, queuePending, queueFailed, qRows);

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
      // 119 · A′：派生链加 queue（与列表端点同款口径；无事件会话不被派生成 _default）。
      space_id: evRows[0]?.space_id ?? stRows[0]?.space_id ?? qRows[0]?.space_id ?? "_default",
      first_event_at: times.length > 0 ? Math.min(...times) : 0,
      last_event_at: times.length > 0 ? Math.max(...times) : 0,
      // 版本链快照（60 spec §3）：只是本会话 fetched 窗口内的观测（DR-6a：不回查当前存储）；
      // `145` 起并列三态旗标 + 并集（见 `assetsOf`）。
      assets: assetsOf(evRows, stRows),
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
  // 119 · A′（120 · C4 复核 P3-① 校正）：**未筛候选端点** `handleAuditCandidates` 只需并入 queue keys
  // （T2：space 过滤用 jd 行自身，无需派生链）；**真实池端点** = `buildAuditPool`（`attribution/audit-pool.ts`，
  // `handleAuditPool` 只是它的壳）——两处同批并入 queue（见该文件同款注释）。
  const keys = [
    ...new Set([
      ...r.events.distinctSessionKeys(0),
      ...r.status.distinctSessionKeys(0),
      ...r.queue.distinctSessionKeys(0),
    ]),
  ];
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

// ── 端点 4：抽查/分歧池（74 · S7-b；只读，70 spec §2.3） ─────────────────────────

function handleAuditPool(c: Context, config: ProxyConfig): Response {
  const auth = checkAdminAuth(c, config.admin.apiKey);
  if (auth !== "ok") return adminAuthError(c, auth);

  const categoryRaw = c.req.query("category");
  if (categoryRaw !== undefined && !(AUDIT_CATEGORIES as readonly string[]).includes(categoryRaw)) {
    return error(c, 400, `unknown category: "${categoryRaw}"`);
  }
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
  const spaceId = (c.req.query("space_id") ?? "").trim() || "_default"; // C3 同 §1

  // 77 · S7-d（C2）：`review_status=` 服务端过滤（客户端在分页后过滤会漏项）。
  const reviewStatusRaw = c.req.query("review_status");
  if (reviewStatusRaw !== undefined && !(AUDIT_PREV_STATUSES as readonly string[]).includes(reviewStatusRaw)) {
    return error(
      c,
      400,
      `invalid review_status: "${reviewStatusRaw}" (expected ${AUDIT_PREV_STATUSES.join("|")})`,
    );
  }

  const { items, countsByCategory } = buildAuditPool({ spaceId });
  // 顺序写死：counts = **过滤前**全类（口径守卫；R4 钉）⇒ 先取全量计数，再做两类过滤。
  const filtered = items
    .filter((i) => (categoryRaw ? i.category === categoryRaw : true))
    .filter((i) => (reviewStatusRaw !== undefined ? i.review_status === reviewStatusRaw : true));
  filtered.sort((a, b) => {
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.audit_key < b.audit_key ? -1 : a.audit_key > b.audit_key ? 1 : 0;
  });
  const truncated = offset + limit < filtered.length; // 防静默截断（同页纪律）
  return ok(c, {
    items: filtered.slice(offset, offset + limit),
    counts_by_category: countsByCategory,
    truncated,
  });
}

// ── 端点 5：抽查状态写口（74 · S7-b；**唯一新增写路径**，70 spec §2.4） ──────────

async function handleAuditReviews(c: Context, config: ProxyConfig): Promise<Response> {
  const auth = checkAdminAuth(c, config.admin.apiKey);
  if (auth !== "ok") return adminAuthError(c, auth);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return error(c, 400, "invalid JSON body");
  }
  const auditKey = body.audit_key;
  const status = body.status;
  const prevStatus = body.prev_status;
  const actor = body.actor;
  const note = body.note;

  if (typeof auditKey !== "string" || auditKey.trim().length === 0) {
    return error(c, 400, "audit_key is required");
  }
  if (typeof status !== "string" || !(AUDIT_STATUSES as readonly string[]).includes(status)) {
    return error(c, 400, `invalid status: ${JSON.stringify(status)} (expected ${AUDIT_STATUSES.join("|")})`);
  }
  if (typeof prevStatus !== "string" || !(AUDIT_PREV_STATUSES as readonly string[]).includes(prevStatus)) {
    return error(c, 400, `invalid prev_status: ${JSON.stringify(prevStatus)} (expected ${AUDIT_PREV_STATUSES.join("|")})`);
  }
  const allowed = AUDIT_TRANSITIONS[prevStatus as (typeof AUDIT_PREV_STATUSES)[number]];
  if (!(allowed as readonly string[]).includes(status)) {
    return error(c, 400, `illegal transition: ${prevStatus} → ${status}（自迁移/未知组合均拒）`);
  }
  if (typeof actor !== "string" || actor.trim().length === 0) {
    return error(c, 400, "actor is required (anonymous review is not allowed)");
  }
  if (note !== undefined && note !== null && (typeof note !== "string" || note.length > 2000)) {
    return error(c, 400, "note must be a string with length ≤ 2000");
  }

  const repo = getAttributionAuditReviewsRepo();
  const reviewId = deriveReviewId(auditKey, prevStatus, status, actor);
  // 重放先行：同迁移（同 review_id）已存在 ⇒ duplicate（不再做 prev 校验，保证重放幂等）。
  if (repo.getById(reviewId) !== null) {
    return ok(c, { review_id: reviewId, status, prev_status: prevStatus, kind: "duplicate" });
  }
  // 乐观校验：prev_status 必须等于该 audit_key 的当前 latest 状态（无行 ⇒ unreviewed）。
  const latest = repo.latestByAuditKey(auditKey);
  const current = latest?.status ?? "unreviewed";
  if (current !== prevStatus) {
    // 77 · S7-d（C4 最后一条）：**必须能解释原因**——文案带 current + 行动指引，
    // 且用结构化 `data.current_status` 供前端组"当前状态已被更新为 X，请刷新"。
    return error(
      c,
      400,
      `prev_status mismatch: current="${current}"（当前状态已被更新为 "${current}"，请刷新后重试）`,
      { current_status: current },
    );
  }
  const res = repo.insertIdempotent({ auditKey, status, prevStatus, actor, note: note ?? null });
  if (res.kind === "failed") {
    return error(c, 503, "audit review insert failed (persistence unavailable)");
  }
  return ok(c, { review_id: res.reviewId, status, prev_status: prevStatus, kind: res.kind });
}

export function createAttributionReadHandlers(config: ProxyConfig) {
  return {
    sessions: (c: Context) => handleSessions(c, config),
    sessionDetail: (c: Context) => handleSessionDetail(c, config),
    auditCandidates: (c: Context) => handleAuditCandidates(c, config),
    auditPool: (c: Context) => handleAuditPool(c, config),
    auditReviews: (c: Context) => handleAuditReviews(c, config),
  };
}
