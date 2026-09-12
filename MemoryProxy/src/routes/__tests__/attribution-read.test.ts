/**
 * 72 · S7-a 归因只读面测试矩阵（T1–T10）。
 *
 * 契约：C1 只读 / C2 照 instance-destroy 鉴权 / C3 space_id 过滤（缺省 _default）/
 * C4 68 D1（corrected 必带 detected_at + snapshot.semantics；禁 current_version）/
 * C5 K2 粒度透传 / C6 溢出可表达（30 spec 原文口径）/ C7 单一真相（payload 只回指）/
 * C8 缺即 null + missing[]。
 *
 * ⚠️ T7 口径登记：T7 原文"payload 键集合不含 verdict/detail"中，`verdict` 与 59 spec §14.4
 * 明文（"payload = { judgement_id, verdict, … }（只回指）"）冲突 ⇒ 按 C7 实质执行：
 * 断言 = payload 键 ⊆ **链接字段白名单**（59 的 used 七键 + corrected 键）且**不含**
 * `detail`/`rationaleRef`/`citationMetrics` 等判定内容键。
 */
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildConfig } from "../../config.js";
import { getAttributionJudgeQueueRepo } from "../../attribution/judge-queue-repo.js";
import { getAttributionJudgementDetailsRepo } from "../../attribution/judgement-details-repo.js";
import {
  getAttributionStatusEventsRepo,
  getAttributionStatusEventsCounters,
} from "../../attribution/status-events-repo.js";
import {
  getAttributionEventRepo,
  getAttributionWriteCounters,
} from "../../db/attributionEventRepo.js";
import { getDb } from "../../db/index.js";
import type { ProxyConfig } from "../../types.js";
import { createAttributionReadHandlers } from "../attribution-read.js";
import {
  teardownTempDb,
  withTempDb,
} from "../../attribution/__tests__/_helpers/base-harness.js";

const SPACE = "_default";

function makeApp(config: ProxyConfig): Hono {
  const h = createAttributionReadHandlers(config);
  const app = new Hono();
  app.get("/v3/admin/attribution/sessions", h.sessions);
  app.get("/v3/admin/attribution/sessions/:session_key", h.sessionDetail);
  app.get("/v3/admin/attribution/audit-candidates", h.auditCandidates);
  return app;
}

function defaultConfig(): ProxyConfig {
  return buildConfig({});
}

function seedUnitEvent(
  sessionKey: string,
  unitId: string,
  opts: { turnSeq?: number; msgSeq?: number; unitType?: string } = {},
): void {
  getAttributionEventRepo().append({
    sessionKey,
    eventType: "decision_unit.created",
    unitId,
    turnSeq: opts.turnSeq ?? 1,
    msgSeq: opts.msgSeq ?? 16,
    payload: { unitType: opts.unitType ?? "code_change" },
  });
}

function seedDetail(
  sessionKey: string,
  unitId: string,
  opts: { verdict: "confirmed" | "refuted" | "unconfirmed"; assetId?: string; rationaleRef?: string },
): void {
  getAttributionJudgementDetailsRepo().insertIdempotent({
    unitId,
    sessionKey,
    spaceId: SPACE,
    assetId: opts.assetId ?? null,
    assetType: opts.assetId ? "skill" : null,
    round: 0,
    verdict: opts.verdict,
    evidenceSourceType: opts.assetId ? "injected" : null,
    promptSha256: "sha-72",
    judgeImpl: "mock:v1",
    detail: {
      rationaleRef: opts.rationaleRef ?? "r-72",
      candidateCount: 1,
      unitKind: "code_change",
    },
  });
}

function seedUsed(sessionKey: string, unitId: string, assetId: string): string {
  return getAttributionStatusEventsRepo().insertIdempotent({
    unitId,
    sessionKey,
    assetId,
    assetType: "skill",
    round: 0,
    outcome: null,
    payload: {
      judgement_id: `jd_${unitId}`,
      unit_id: unitId,
      verdict: "confirmed",
      match_level: "exact",
      coverage: 1,
      prompt_sha256: "sha-72",
      judge_impl: "mock:v1",
    },
  }).statusId;
}

function seedCorrected(sessionKey: string, unitId: string, assetId: string, usedStatusId: string): void {
  getAttributionStatusEventsRepo().insertIdempotent({
    unitId,
    sessionKey,
    assetId,
    assetType: "skill",
    round: 0,
    eventType: "asset_corrected",
    route: "version_drift",
    outcome: null,
    payload: {
      used_status_id: usedStatusId,
      judgement_id: `jd_${unitId}`,
      correction_route: "version_drift",
      anchored_version: 1,
      latest_version: 2,
      severity: "signal",
    },
  });
}

function tableCounts(): Record<string, number> {
  const db = getDb()!;
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    events: one("SELECT COUNT(*) AS n FROM attribution_events"),
    status: one("SELECT COUNT(*) AS n FROM attribution_status_events"),
    details: one("SELECT COUNT(*) AS n FROM attribution_judgement_details"),
    queue: one("SELECT COUNT(*) AS n FROM attribution_judge_queue"),
  };
}

/** 链接字段白名单（59 §14.4 used 七键 + corrected 的链接键）；判定内容键（detail 等）不得出现。 */
const LINK_KEYS = new Set([
  "used_status_id",
  "judgement_id",
  "unit_id",
  "verdict",
  "match_level",
  "coverage",
  "prompt_sha256",
  "judge_impl",
  "correction_route",
  "anchored_version",
  "latest_version",
  "severity",
]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("72 · T1–T5 回执 DTO（形状 / 68 D1 / K2 / 溢出 / 分页）", () => {
  it("T1 回执 DTO 形状：1 session × 2 units（confirmed+used / confirmed+corrected）逐字段", async () => {
    withTempDb();
    try {
      const S = "sess-72-t1";
      const app = makeApp(defaultConfig());
      seedUnitEvent(S, "u-72-a", { turnSeq: 1, msgSeq: 16 });
      seedDetail(S, "u-72-a", { verdict: "confirmed", assetId: "asset-72" });
      const usedId = seedUsed(S, "u-72-a", "asset-72");
      seedUnitEvent(S, "u-72-b", { turnSeq: 2, msgSeq: 32 });
      seedDetail(S, "u-72-b", { verdict: "confirmed", assetId: "asset-72" });
      seedCorrected(S, "u-72-b", "asset-72", usedId);
      // 版本链：fetched v1→v2
      getAttributionEventRepo().appendMany([
        { sessionKey: S, eventType: "asset_fetched", assetId: "asset-72", assetType: "skill", payload: { version: 1 } },
        { sessionKey: S, eventType: "asset_fetched", assetId: "asset-72", assetType: "skill", payload: { version: 2 } },
      ]);

      const res = await app.request(`/v3/admin/attribution/sessions/${S}?limit=10`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      const data = body.data as Record<string, unknown>;
      console.log(`T1 obs → ${JSON.stringify({ code: body.code, counts: data.counts, units: (data.units as unknown[]).length, truncated: data.truncated })}`);
      expect(body.code).toBe(0);
      const session = data.session as Record<string, unknown>;
      expect(session.session_key).toBe(S);
      expect(session.space_id).toBe(SPACE);
      expect(session.assets).toEqual([
        { asset_id: "asset-72", asset_type: "skill", first_seen_version: 1, last_seen_version: 2, observed_versions: [1, 2] },
      ]);
      expect(data.counts).toEqual({ units: 2, judged: 2, unconfirmed: 0, used: 1, corrected: 1, pending: 0, failed: 0 });
      const units = data.units as Array<Record<string, unknown>>;
      expect(units.length).toBe(2);
      const u1 = units[0]!;
      expect(u1.unit_id).toBe("u-72-a");
      const u1Events = u1.status_events as Array<Record<string, unknown>>;
      expect(u1Events.length).toBe(1);
      expect(u1Events[0]!.event_type).toBe("asset_used");
      const u2 = units[1]!;
      const corrected = (u2.status_events as Array<Record<string, unknown>>)[0]!;
      expect(corrected.event_type).toBe("asset_corrected");
      expect(corrected.route).toBe("version_drift");
    } finally {
      teardownTempDb();
    }
  });

  it("T2 68 D1：corrected 必带 detected_at + snapshot.semantics；整响应无 current_version 类字段", async () => {
    withTempDb();
    try {
      const S = "sess-72-t2";
      const app = makeApp(defaultConfig());
      seedUnitEvent(S, "u-72-t2");
      seedDetail(S, "u-72-t2", { verdict: "confirmed", assetId: "asset-72" });
      const usedId = seedUsed(S, "u-72-t2", "asset-72");
      seedCorrected(S, "u-72-t2", "asset-72", usedId);

      const res = await app.request(`/v3/admin/attribution/sessions/${S}`);
      const text = JSON.stringify(await res.json());
      const body = JSON.parse(text) as { data: { units: Array<{ status_events: Array<Record<string, unknown>> }> } };
      const corrected = body.data.units[0]!.status_events.find((s) => s.event_type === "asset_corrected")!;
      console.log(`T2 obs → detected_at=${corrected.detected_at} snapshot=${JSON.stringify(corrected.snapshot)}；含current_version=${text.includes("current_version")}`);
      // C4：detected_at 必带（= created_at）
      expect(typeof corrected.detected_at).toBe("number");
      expect(corrected.detected_at).toBe(corrected.created_at);
      expect(corrected.snapshot).toEqual({
        anchored_version: 1,
        latest_version: 2,
        semantics: "detected_at_snapshot",
      });
      // 键集合级：整响应不得出现 current_version 形态字段
      expect(text.includes("current_version")).toBe(false);
    } finally {
      teardownTempDb();
    }
  });

  it("T3 K2：turn_seq/msg_seq 原样透传；unit 键集合精确（无合成粒度字段）", async () => {
    withTempDb();
    try {
      const S = "sess-72-t3";
      const app = makeApp(defaultConfig());
      seedUnitEvent(S, "u-72-t3", { turnSeq: 7, msgSeq: 112 });
      const res = await app.request(`/v3/admin/attribution/sessions/${S}`);
      const body = (await res.json()) as { data: { units: Array<Record<string, unknown>> } };
      const unit = body.data.units[0]!;
      console.log(`T3 obs → turn_seq=${unit.turn_seq} msg_seq=${unit.msg_seq} keys=${JSON.stringify(Object.keys(unit).sort())}`);
      expect(unit.turn_seq).toBe(7);
      expect(unit.msg_seq).toBe(112);
      expect(Object.keys(unit).sort()).toEqual(
        ["created_at", "judgement", "kind", "missing", "msg_seq", "status_events", "turn_seq", "unit_id", "unit_type"].sort(),
      );
    } finally {
      teardownTempDb();
    }
  });

  it("T4 溢出：overflow.pending = queue pending 计数 + 30 spec 原文文案逐字", async () => {
    withTempDb();
    try {
      const S = "sess-72-t4";
      const app = makeApp(defaultConfig());
      seedUnitEvent(S, "u-72-t4");
      const q = getAttributionJudgeQueueRepo();
      q.enqueue({ unitId: "u-72-q1", sessionKey: S, payload: {} });
      q.enqueue({ unitId: "u-72-q2", sessionKey: S, payload: {} });
      const res = await app.request(`/v3/admin/attribution/sessions/${S}`);
      const body = (await res.json()) as { data: { overflow: { pending: number; note: string }; counts: { pending: number } } };
      console.log(`T4 obs → ${JSON.stringify(body.data.overflow)}`);
      expect(body.data.overflow.pending).toBe(2);
      expect(body.data.overflow.note).toBe("另有 2 个次要决策未逐一归因（top-N 闸门；保持 pending，下轮 FIFO 优先）");
      expect(body.data.counts.pending).toBe(2);
    } finally {
      teardownTempDb();
    }
  });

  it("T5 分页：limit 命中 ⇒ truncated=true 且条数=limit；越界不报错", async () => {
    withTempDb();
    try {
      const S = "sess-72-t5";
      const app = makeApp(defaultConfig());
      // ⚠️ S3 幂等锚 = (session_key, turn_seq, msg_seq)（idx_ae_unit_dedupe）⇒
      // 三个 unit 必须给**不同 msg_seq**，否则后两个被 append 去重（实测教训）。
      const ids = ["a", "b", "c"];
      for (let i = 0; i < ids.length; i += 1) seedUnitEvent(S, `u-72-t5-${ids[i]}`, { msgSeq: 16 + i * 16 });
      const r1 = (await (await app.request(`/v3/admin/attribution/sessions/${S}?limit=2`)).json()) as {
        data: { units: unknown[]; truncated: boolean };
      };
      console.log(`T5 obs → limit=2 units=${r1.data.units.length} truncated=${r1.data.truncated}`);
      expect(r1.data.units.length).toBe(2);
      expect(r1.data.truncated).toBe(true);
      const r2 = (await (await app.request(`/v3/admin/attribution/sessions/${S}?limit=2&offset=2`)).json()) as {
        data: { units: unknown[]; truncated: boolean };
      };
      expect(r2.data.units.length).toBe(1);
      expect(r2.data.truncated).toBe(false);
      const r3 = (await (await app.request(`/v3/admin/attribution/sessions/${S}?offset=99`)).json()) as {
        data: { units: unknown[]; truncated: boolean };
        code: number;
      };
      expect(r3.code).toBe(0);
      expect(r3.data.units.length).toBe(0);
    } finally {
      teardownTempDb();
    }
  });
});

describe("72 · T6–T10 缺即 null / 单一真相 / 无界拒绝 / 只读 / 鉴权", () => {
  it("T6 真库形状：有单元、无判定 ⇒ judgement=null + missing 含 judgement（不崩、不伪造）", async () => {
    withTempDb();
    try {
      const S = "sess-72-t6";
      const app = makeApp(defaultConfig());
      seedUnitEvent(S, "u-72-t6"); // 无 detail、无 status
      const res = await app.request(`/v3/admin/attribution/sessions/${S}`);
      const body = (await res.json()) as { data: { units: Array<Record<string, unknown>>; counts: Record<string, number> } };
      const unit = body.data.units[0]!;
      console.log(`T6 obs → judgement=${JSON.stringify(unit.judgement)} missing=${JSON.stringify(unit.missing)} counts=${JSON.stringify(body.data.counts)}`);
      expect(unit.judgement).toBe(null);
      expect(unit.missing).toEqual(["judgement", "status_events"]);
      expect(body.data.counts.judged).toBe(0);
    } finally {
      teardownTempDb();
    }
  });

  it("T7 单一真相：status_events[].payload 键 ⊆ 链接白名单、不含判定内容键", async () => {
    withTempDb();
    try {
      const S = "sess-72-t7";
      const app = makeApp(defaultConfig());
      seedUnitEvent(S, "u-72-t7");
      seedDetail(S, "u-72-t7", { verdict: "confirmed", assetId: "asset-72" });
      const usedId = seedUsed(S, "u-72-t7", "asset-72");
      seedCorrected(S, "u-72-t7", "asset-72", usedId);
      const res = await app.request(`/v3/admin/attribution/sessions/${S}`);
      const body = (await res.json()) as { data: { units: Array<{ status_events: Array<{ payload: Record<string, unknown> }> }> } };
      for (const se of body.data.units[0]!.status_events) {
        const keys = Object.keys(se.payload);
        console.log(`T7 obs → payload keys=${JSON.stringify(keys.sort())}`);
        for (const k of keys) expect(LINK_KEYS.has(k), `payload 键 "${k}" 必须在链接白名单内`).toBe(true);
        expect(keys).not.toContain("detail");
        expect(keys).not.toContain("rationaleRef");
        expect(keys).not.toContain("citationMetrics");
      }
    } finally {
      teardownTempDb();
    }
  });

  it("T8 无界拒绝：/sessions 缺 since 且缺 limit ⇒ 400 信封 + 零查询", async () => {
    withTempDb();
    try {
      const app = makeApp(defaultConfig());
      seedUnitEvent("sess-72-t8", "u-72-t8");
      const evSpy = vi.spyOn(getAttributionEventRepo(), "distinctSessionKeys");
      const stSpy = vi.spyOn(getAttributionStatusEventsRepo(), "distinctSessionKeys");
      const qSpy = vi.spyOn(getAttributionJudgeQueueRepo(), "listByStatus");
      const res = await app.request("/v3/admin/attribution/sessions");
      const body = (await res.json()) as { code: number; message: string };
      console.log(`T8 obs → status=${res.status} body=${JSON.stringify(body)}；查询 spy=${evSpy.mock.calls.length + stSpy.mock.calls.length + qSpy.mock.calls.length}`);
      expect(res.status).toBe(400);
      expect(body.code).toBe(400);
      expect(body.message).toContain("unbounded");
      expect(evSpy.mock.calls.length + stSpy.mock.calls.length + qSpy.mock.calls.length).toBe(0);
    } finally {
      teardownTempDb();
    }
  });

  it("T9 只读证明：全端点调用前后四表行数 + 写计数逐条不变", async () => {
    withTempDb();
    try {
      const S = "sess-72-t9";
      const app = makeApp(defaultConfig());
      seedUnitEvent(S, "u-72-t9");
      seedDetail(S, "u-72-t9", { verdict: "unconfirmed" });
      getAttributionJudgeQueueRepo().enqueue({ unitId: "u-72-t9q", sessionKey: S, payload: {} });
      const before = tableCounts();
      const wcBefore = { ...getAttributionWriteCounters(), ...getAttributionStatusEventsCounters() };
      await app.request("/v3/admin/attribution/sessions?limit=10");
      await app.request(`/v3/admin/attribution/sessions/${S}`);
      await app.request("/v3/admin/attribution/audit-candidates");
      const after = tableCounts();
      const wcAfter = { ...getAttributionWriteCounters(), ...getAttributionStatusEventsCounters() };
      console.log(`T9 obs → tables ${JSON.stringify(before)} ⇒ ${JSON.stringify(after)}；writeCounters 不变=${JSON.stringify(wcBefore) === JSON.stringify(wcAfter)}`);
      expect(after).toEqual(before);
      expect(wcAfter).toEqual(wcBefore);
    } finally {
      teardownTempDb();
    }
  });

  it("T10 鉴权：apiKey 非空 ⇒ 无/错 Bearer 被拒、对 Bearer 通过；apiKey 空 ⇒ 公开", async () => {
    withTempDb();
    try {
      const S = "sess-72-t10";
      seedUnitEvent(S, "u-72-t10");
      const cfg = defaultConfig();
      cfg.admin.apiKey = "secret-72";
      const app = makeApp(cfg);
      const noAuth = await app.request("/v3/admin/attribution/sessions?limit=5");
      const badAuth = await app.request("/v3/admin/attribution/sessions?limit=5", {
        headers: { authorization: "Bearer wrong" },
      });
      const goodAuth = await app.request("/v3/admin/attribution/sessions?limit=5", {
        headers: { authorization: "Bearer secret-72" },
      });
      console.log(`T10 obs → 非空key：no=${noAuth.status} bad=${badAuth.status} good=${goodAuth.status}`);
      expect(noAuth.status).toBe(401);
      expect(badAuth.status).toBe(401);
      expect(goodAuth.status).toBe(200);

      const openApp = makeApp(defaultConfig()); // apiKey 空 ⇒ 公开（既有语义）
      const open = await openApp.request("/v3/admin/attribution/sessions?limit=5");
      expect(open.status).toBe(200);
    } finally {
      teardownTempDb();
    }
  });
});
