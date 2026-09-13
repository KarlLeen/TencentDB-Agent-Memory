/**
 * 74 · S7-b 抽查/分歧池测试矩阵（T1–T10；70 spec §2）。
 *
 * 七类机械判据逐类夹具 + 多命中 + tombstone 硬排除 + audit_key 稳定 + 池查询 +
 * 状态机写口（幂等/真实迁移序列/非法迁移/actor 必填）+ 只读零写 + 不驱动判定。
 */
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveAuditKey } from "../../attribution/audit-pool.js";
import {
  __resetAttributionAuditReviewsRepoForTests,
  getAttributionAuditReviewsCounters,
  getAttributionAuditReviewsRepo,
} from "../../attribution/audit-reviews-repo.js";
import { getAttributionJudgeQueueRepo } from "../../attribution/judge-queue-repo.js";
import { getAttributionJudgementDetailsRepo } from "../../attribution/judgement-details-repo.js";
import { getAttributionStatusEventsRepo } from "../../attribution/status-events-repo.js";
import { getAttributionEventRepo } from "../../db/attributionEventRepo.js";
import { getDb } from "../../db/index.js";
import { buildConfig } from "../../config.js";
import { createAttributionReadHandlers } from "../attribution-read.js";
import { teardownTempDb, withTempDb } from "../../attribution/__tests__/_helpers/base-harness.js";

function makeApp(): Hono {
  const h = createAttributionReadHandlers(buildConfig({}));
  const app = new Hono();
  app.get("/v3/admin/attribution/sessions", h.sessions); // 119 · A′：会话列表（T11）
  app.get("/v3/admin/attribution/audit-pool", h.auditPool);
  app.post("/v3/admin/attribution/audit-reviews", h.auditReviews);
  return app;
}

function mkMetrics(coverage: number | "unknown"): Array<Record<string, unknown>> {
  return [
    {
      assetId: "a1",
      matchLevel: "exact",
      matchedTier: "block",
      coverage,
      coverageDistinct: 1,
      coverageCovered: 1,
      exclusionCount: 0,
      ngramTableSha256: "sha-74",
    },
  ];
}

function mkShortlist(overflowCount: number): Record<string, unknown> {
  return { k: 2, total: 4, overflowCount, overflowAssetIds: [] };
}

function seedUnitEvent(sessionKey: string, unitId: string, msgSeq: number, spaceId?: string): void {
  getAttributionEventRepo().append({
    sessionKey,
    eventType: "decision_unit.created",
    unitId,
    turnSeq: 1,
    msgSeq,
    ...(spaceId ? { spaceId } : {}), // 119 · T11：可选 space（缺省 _default，不破既有 T）
    payload: { unitType: "code_change" },
  });
}

function seedDetail(
  sessionKey: string,
  unitId: string,
  opts: { verdict: string; detail: Record<string, unknown>; round?: number; assetId?: string; spaceId?: string },
): void {
  getAttributionJudgementDetailsRepo().insertIdempotent({
    unitId,
    sessionKey,
    spaceId: opts.spaceId ?? "_default",
    assetId: opts.assetId ?? null,
    assetType: opts.assetId ? "skill" : null,
    round: opts.round ?? 0,
    verdict: opts.verdict as "confirmed" | "refuted" | "unconfirmed",
    evidenceSourceType: null,
    promptSha256: "sha-74",
    judgeImpl: "mock:v1",
    detail: opts.detail,
  });
}

function seedUsed(sessionKey: string, unitId: string, assetId: string): void {
  getAttributionStatusEventsRepo().insertIdempotent({
    unitId,
    sessionKey,
    assetId,
    assetType: "skill",
    round: 0,
    outcome: null,
    payload: { judgement_id: `jd_${unitId}` },
  });
}

function seedCorrected(sessionKey: string, unitId: string, assetId: string): void {
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
      used_status_id: `se_x_${unitId}`,
      judgement_id: `jd_${unitId}`,
      correction_route: "version_drift",
      anchored_version: 1,
      latest_version: 2,
      severity: "signal",
    },
  });
}

function seedQueueFailed(sessionKey: string, unitId: string): void {
  const q = getAttributionJudgeQueueRepo();
  q.enqueue({ unitId, sessionKey, payload: {} });
  getDb()!
    .prepare("UPDATE attribution_judge_queue SET status = 'failed', attempts = 3, last_error = 'boom' WHERE unit_id = ?")
    .run(unitId);
}

interface PoolItem {
  audit_key: string;
  unit_id: string;
  round: number;
  category: string;
  categories: string[];
  verdict: string | null;
  created_at: number;
}

async function poolItems(app: Hono, qs = ""): Promise<{ items: PoolItem[]; counts: Record<string, number>; truncated: boolean }> {
  const res = await app.request(`/v3/admin/attribution/audit-pool${qs}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { items: PoolItem[]; counts_by_category: Record<string, number>; truncated: boolean };
  };
  return { items: body.data.items, counts: body.data.counts_by_category, truncated: body.data.truncated };
}

function categoriesOf(items: PoolItem[], unitId: string): string[] {
  const rows = items.filter((i) => i.unit_id === unitId);
  expect(rows.length).toBeGreaterThan(0);
  return rows[0]!.categories;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("74 · T1–T4 判据 / 硬排除 / audit_key / 池查询", () => {
  it("T1 七类逐类命中 + 多命中（精确集合断言）", async () => {
    withTempDb();
    try {
      const S = "sess-74-t1";
      const app = makeApp();
      let seq = 1;
      const unit = (id: string): void => seedUnitEvent(S, id, (seq += 16));

      unit("u-trunc");
      seedDetail(S, "u-trunc", {
        verdict: "unconfirmed",
        detail: { rationaleRef: "r", shortlist: mkShortlist(2), citationMetrics: mkMetrics(0.9) },
      });
      unit("u-lowcov");
      seedDetail(S, "u-lowcov", {
        verdict: "unconfirmed",
        detail: { rationaleRef: "r", shortlist: mkShortlist(0), citationMetrics: mkMetrics(0.2) },
      });
      unit("u-nometrics");
      seedDetail(S, "u-nometrics", {
        verdict: "unconfirmed",
        detail: { rationaleRef: "mechanical:no-metrics", shortlist: mkShortlist(0), citationMetrics: mkMetrics(0.9) },
      });
      unit("u-malformed");
      seedDetail(S, "u-malformed", {
        verdict: "unconfirmed",
        detail: { rationaleRef: "malformed:not_json", shortlist: mkShortlist(0), citationMetrics: mkMetrics(0.9) },
      });
      unit("u-multi");
      seedDetail(S, "u-multi", {
        verdict: "unconfirmed",
        detail: { rationaleRef: "r", shortlist: mkShortlist(3), citationMetrics: mkMetrics(0.1) },
      });
      unit("u-flip");
      seedDetail(S, "u-flip", {
        verdict: "confirmed",
        round: 0,
        detail: { rationaleRef: "r", shortlist: mkShortlist(0), citationMetrics: mkMetrics(0.9) },
      });
      seedDetail(S, "u-flip", {
        verdict: "refuted",
        round: 1,
        detail: { rationaleRef: "r", shortlist: mkShortlist(0), citationMetrics: mkMetrics(0.9) },
      });
      unit("u-corrected");
      seedDetail(S, "u-corrected", {
        verdict: "confirmed",
        detail: { rationaleRef: "r", shortlist: mkShortlist(0), citationMetrics: mkMetrics(0.9) },
      });
      seedUsed(S, "u-corrected", "asset-c74");
      seedCorrected(S, "u-corrected", "asset-c74");
      seedQueueFailed(S, "u-dead");

      const { items, counts } = await poolItems(app);
      console.log(`T1 → items=${items.length} counts=${JSON.stringify(counts)}`);
      expect(categoriesOf(items, "u-trunc")).toEqual(["suspect:truncated"]);
      expect(categoriesOf(items, "u-lowcov")).toEqual(["suspect:low_coverage"]);
      expect(categoriesOf(items, "u-nometrics")).toEqual(["suspect:no_metrics"]);
      expect(categoriesOf(items, "u-malformed")).toEqual(["suspect:malformed"]);
      expect(categoriesOf(items, "u-multi")).toEqual(["suspect:low_coverage", "suspect:truncated"]);
      expect(categoriesOf(items, "u-flip")).toEqual(["disagreement:flip"]);
      expect(categoriesOf(items, "u-corrected")).toEqual(["disagreement:corrected"]);
      expect(categoriesOf(items, "u-dead")).toEqual(["orphan:dead_letter"]);
      // 多命中 ⇒ 两行（同 unit 同 round、两个 category）
      expect(items.filter((i) => i.unit_id === "u-multi").length).toBe(2);
      // counts 与 items 对账
      for (const [c, n] of Object.entries(counts)) {
        expect(n, `counts_by_category[${c}]`).toBe(items.filter((i) => i.category === c).length);
      }
    } finally {
      teardownTempDb();
    }
  });

  it("T2 硬排除：tombstone:result_missing ⇒ 不入 suspect:*（零行、不崩）", async () => {
    withTempDb();
    try {
      const S = "sess-74-t2";
      const app = makeApp();
      seedUnitEvent(S, "u-tomb", 32);
      seedDetail(S, "u-tomb", {
        verdict: "unconfirmed",
        detail: { rationaleRef: "tombstone:result_missing", citationMetrics: [] }, // 空 metrics 也不得触发 low_coverage
      });
      const { items } = await poolItems(app);
      console.log(`T2 → items=${items.length}（u-tomb 行数=${items.filter((i) => i.unit_id === "u-tomb").length}）`);
      expect(items.filter((i) => i.unit_id === "u-tomb").length).toBe(0);
    } finally {
      teardownTempDb();
    }
  });

  it("T3 audit_key 稳定：同 (unit,round,category) 同值；异 category 异值", () => {
    const a1 = deriveAuditKey("u-x", 0, "suspect:truncated");
    const a2 = deriveAuditKey("u-x", 0, "suspect:truncated");
    const b = deriveAuditKey("u-x", 0, "suspect:malformed");
    const c = deriveAuditKey("u-x", 1, "suspect:truncated");
    console.log(`T3 → ${a1} / ${b} / ${c}`);
    expect(a1).toBe(a2);
    expect(a1.startsWith("ak_")).toBe(true);
    expect(b).not.toBe(a1);
    expect(c).not.toBe(a1);
  });

  it("T4 池查询：category 过滤 / counts 自洽 / truncated / 未知 category ⇒ 400", async () => {
    withTempDb();
    try {
      const S = "sess-74-t4";
      const app = makeApp();
      seedUnitEvent(S, "u-4a", 16);
      seedDetail(S, "u-4a", {
        verdict: "unconfirmed",
        detail: { rationaleRef: "r", shortlist: mkShortlist(1), citationMetrics: mkMetrics(0.9) },
      });
      seedUnitEvent(S, "u-4b", 32);
      seedDetail(S, "u-4b", {
        verdict: "unconfirmed",
        detail: { rationaleRef: "malformed:trunc", shortlist: mkShortlist(0), citationMetrics: mkMetrics(0.9) },
      });
      const onlyTrunc = await poolItems(app, "?category=suspect:truncated");
      console.log(`T4 → filtered=${onlyTrunc.items.length} counts=${JSON.stringify(onlyTrunc.counts)}`);
      expect(onlyTrunc.items.length).toBe(1);
      expect(onlyTrunc.items[0]!.unit_id).toBe("u-4a");
      expect(onlyTrunc.counts["suspect:malformed"]).toBe(1); // counts 为过滤前全类计数
      const lim = await poolItems(app, "?limit=1");
      expect(lim.items.length).toBe(1);
      expect(lim.truncated).toBe(true);
      const bad = await app.request("/v3/admin/attribution/audit-pool?category=nope");
      expect(bad.status).toBe(400);
    } finally {
      teardownTempDb();
    }
  });
});

describe("74 · T5–T10 状态机写口 / 只读零写 / 不驱动判定", () => {
  it("T5 首次迁移 ⇒ inserted；重放同迁移 ⇒ duplicate（行数不变）；T5b 真实迁移序列各得其锚", async () => {
    withTempDb();
    try {
      const app = makeApp();
      const repo = getAttributionAuditReviewsRepo();
      const post = (body: Record<string, unknown>) =>
        app.request("/v3/admin/attribution/audit-reviews", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const r1 = (await (await post({ audit_key: "ak_t5", prev_status: "unreviewed", status: "confirmed", actor: "karl" })).json()) as {
        data: { kind: string };
      };
      const r2 = (await (await post({ audit_key: "ak_t5", prev_status: "unreviewed", status: "confirmed", actor: "karl" })).json()) as {
        data: { kind: string };
      };
      console.log(`T5 → 首次=${r1.data.kind} 重放=${r2.data.kind} 行数=${repo.count()}`);
      expect(r1.data.kind).toBe("inserted");
      expect(r2.data.kind).toBe("duplicate");
      expect(repo.count()).toBe(1);
      // T5b：真实迁移序列（含 prev_status 的锚 ⇒ 各次迁移均 inserted）
      const r3 = (await (await post({ audit_key: "ak_t5", prev_status: "confirmed", status: "needs_fix", actor: "karl" })).json()) as {
        data: { kind: string };
      };
      const r4 = (await (await post({ audit_key: "ak_t5", prev_status: "needs_fix", status: "confirmed", actor: "karl" })).json()) as {
        data: { kind: string };
      };
      console.log(`T5b → ${r3.data.kind} / ${r4.data.kind}；latest=${repo.latestByAuditKey("ak_t5")?.status}`);
      expect(r3.data.kind).toBe("inserted");
      expect(r4.data.kind, "needs_fix→confirmed 与最初的 unreviewed→confirmed 必须不同锚").toBe("inserted");
      expect(repo.count()).toBe(3);
    } finally {
      teardownTempDb();
    }
  });

  it("T6 非法迁移 / 未知 status ⇒ 400", async () => {
    withTempDb();
    try {
      const app = makeApp();
      const post = (body: Record<string, unknown>) =>
        app.request("/v3/admin/attribution/audit-reviews", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const self = await post({ audit_key: "ak_t6", prev_status: "confirmed", status: "confirmed", actor: "karl" });
      const unknown = await post({ audit_key: "ak_t6", prev_status: "unreviewed", status: "bogus", actor: "karl" });
      console.log(`T6 → 自迁移=${self.status} 未知status=${unknown.status}`);
      expect(self.status).toBe(400);
      expect(unknown.status).toBe(400);
    } finally {
      teardownTempDb();
    }
  });

  it("T7 actor 缺失/空白 ⇒ 400（不许匿名）", async () => {
    withTempDb();
    try {
      const app = makeApp();
      const post = (body: Record<string, unknown>) =>
        app.request("/v3/admin/attribution/audit-reviews", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const miss = await post({ audit_key: "ak_t7", prev_status: "unreviewed", status: "confirmed" });
      const blank = await post({ audit_key: "ak_t7", prev_status: "unreviewed", status: "confirmed", actor: "   " });
      console.log(`T7 → 缺失=${miss.status} 空白=${blank.status}`);
      expect(miss.status).toBe(400);
      expect(blank.status).toBe(400);
      expect(getAttributionAuditReviewsRepo().count()).toBe(0);
    } finally {
      teardownTempDb();
    }
  });

  it("T8 只读侧零写：只调 /audit-pool ⇒ reviews 行数 + 写计数不变", async () => {
    withTempDb();
    try {
      const S = "sess-74-t8";
      const app = makeApp();
      seedUnitEvent(S, "u-8", 16);
      seedDetail(S, "u-8", {
        verdict: "unconfirmed",
        detail: { rationaleRef: "r", shortlist: mkShortlist(1), citationMetrics: mkMetrics(0.9) },
      });
      const before = getAttributionAuditReviewsRepo().count();
      const cBefore = getAttributionAuditReviewsCounters();
      await poolItems(app);
      const after = getAttributionAuditReviewsRepo().count();
      const cAfter = getAttributionAuditReviewsCounters();
      console.log(`T8 → reviews ${before}→${after}；counters 不变=${JSON.stringify(cBefore) === JSON.stringify(cAfter)}`);
      expect(after).toBe(before);
      expect(cAfter).toEqual(cBefore);
    } finally {
      teardownTempDb();
    }
  });

  it("T9 不驱动判定（C4 硬边界）：写状态后判定/状态事件/queue 行逐条不变、不自动入队", async () => {
    withTempDb();
    try {
      const S = "sess-74-t9";
      const app = makeApp();
      seedUnitEvent(S, "u-9", 16);
      seedDetail(S, "u-9", {
        verdict: "unconfirmed",
        detail: { rationaleRef: "r", shortlist: mkShortlist(1), citationMetrics: mkMetrics(0.9) },
      });
      seedUsed(S, "u-9", "asset-9");
      seedCorrected(S, "u-9", "asset-9");
      getAttributionJudgeQueueRepo().enqueue({ unitId: "u-9q", sessionKey: S, payload: {} });
      const db = getDb()!;
      const snapshot = (): Record<string, number> => {
        const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
        return {
          used: one("SELECT COUNT(*) AS n FROM attribution_status_events WHERE event_type='asset_used'"),
          corrected: one("SELECT COUNT(*) AS n FROM attribution_status_events WHERE event_type='asset_corrected'"),
          judgement: one("SELECT COUNT(*) AS n FROM attribution_judgement_details"),
          queue: one("SELECT COUNT(*) AS n FROM attribution_judge_queue"),
          reviews: one("SELECT COUNT(*) AS n FROM attribution_audit_reviews"),
        };
      };
      const before = snapshot();
      const res = await app.request("/v3/admin/attribution/audit-reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audit_key: "ak_t9", prev_status: "unreviewed", status: "needs_fix", actor: "karl" }),
      });
      expect(res.status).toBe(200);
      const after = snapshot();
      console.log(`T9 → ${JSON.stringify(before)} ⇒ ${JSON.stringify(after)}`);
      expect(after.used).toBe(before.used);
      expect(after.corrected).toBe(before.corrected);
      expect(after.judgement).toBe(before.judgement);
      expect(after.queue, "不自动入队").toBe(before.queue);
      expect(after.reviews).toBe(before.reviews + 1); // 只多了状态行本身
    } finally {
      teardownTempDb();
    }
  });

  it("T10 静态面：写口是唯一新增写路径（表清单含 attribution_audit_reviews）", () => {
    withTempDb();
    try {
      const names = (getDb()!
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>).map((r) => r.name);
      console.log(`T10 → 表清单含 attribution_audit_reviews=${names.includes("attribution_audit_reviews")}`);
      expect(names).toContain("attribution_audit_reviews");
    } finally {
      teardownTempDb();
      __resetAttributionAuditReviewsRepoForTests();
    }
  });
});

// ── 77 · S7-d：池 review 读侧（latest-join 三字段 + review_status= 服务端过滤） ──

interface PoolItem77 extends PoolItem {
  review_status: string;
  review_actor: string | null;
  review_at: number | null;
}

async function poolItems77(
  app: Hono,
  qs = "",
): Promise<{ items: PoolItem77[]; counts: Record<string, number>; truncated: boolean }> {
  const res = await app.request(`/v3/admin/attribution/audit-pool${qs}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { items: PoolItem77[]; counts_by_category: Record<string, number>; truncated: boolean };
  };
  return { items: body.data.items, counts: body.data.counts_by_category, truncated: body.data.truncated };
}

async function writeReview(
  app: Hono,
  auditKey: string,
  prevStatus: string,
  status: string,
  actor = "u-42",
): Promise<void> {
  const res = await app.request("/v3/admin/attribution/audit-reviews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audit_key: auditKey, prev_status: prevStatus, status, actor }),
  });
  expect(res.status).toBe(200);
}

/** 造一个 unconfirmed+截断的 suspect:truncated 单元（返回其 audit_key）。 */
function seedTruncatedUnit(sessionKey: string, unitId: string, msgSeq: number): string {
  seedUnitEvent(sessionKey, unitId, msgSeq);
  seedDetail(sessionKey, unitId, {
    verdict: "unconfirmed",
    detail: { rationaleRef: "r-77", shortlist: mkShortlist(2), citationMetrics: mkMetrics(0.9) },
  });
  return deriveAuditKey(unitId, 0, "suspect:truncated");
}

describe("77 · T1–T4 池 review latest-join + review_status= 过滤", () => {
  it("T1：无行 ⇒ unreviewed/null/null；有行 ⇒ latest 值", async () => {
    withTempDb();
    try {
      const S = "sess-77-t1";
      const app = makeApp();
      const akA = seedTruncatedUnit(S, "u-77-a", 16);
      const akB = seedTruncatedUnit(S, "u-77-b", 32);
      expect(akA).not.toBe(akB);
      await writeReview(app, akB, "unreviewed", "confirmed");
      const pool = await poolItems77(app);
      const a = pool.items.find((i) => i.unit_id === "u-77-a")!;
      const b = pool.items.find((i) => i.unit_id === "u-77-b")!;
      console.log(
        `77-T1 → 无行=${JSON.stringify({ s: a.review_status, ac: a.review_actor, at: a.review_at })}；` +
          `有行=${JSON.stringify({ s: b.review_status, ac: b.review_actor, at: b.review_at })}`,
      );
      expect([a.review_status, a.review_actor, a.review_at]).toEqual(["unreviewed", null, null]);
      expect([b.review_status, b.review_actor]).toEqual(["confirmed", "u-42"]);
      expect(typeof b.review_at).toBe("number");
    } finally {
      teardownTempDb();
      __resetAttributionAuditReviewsRepoForTests();
    }
  });

  it("T2：同 created_at 两行 ⇒ 取 review_id 较大者（确定性；重复调用同值）", async () => {
    withTempDb();
    try {
      const S = "sess-77-t2";
      const app = makeApp();
      const ak = seedTruncatedUnit(S, "u-77-t2", 16);
      // 直插两行**同 created_at**（绕开 repo 的严格单调）；插序 = ar_aaa 先、ar_zzz 后。
      const db = getDb()!;
      const ins = db.prepare(
        "INSERT INTO attribution_audit_reviews (review_id, audit_key, status, prev_status, actor, note, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
      );
      ins.run("ar_aaa", ak, "dismissed", "unreviewed", "u-old", 1000);
      ins.run("ar_zzz", ak, "confirmed", "unreviewed", "u-new", 1000);
      const pool1 = await poolItems77(app);
      const pool2 = await poolItems77(app);
      const row = pool1.items.find((i) => i.audit_key === ak)!;
      console.log(
        `77-T2 → latest=${JSON.stringify({ s: row.review_status, ac: row.review_actor, at: row.review_at })}；` +
          `重复调用同值=${JSON.stringify(pool2.items.find((i) => i.audit_key === ak)!.review_actor === row.review_actor)}`,
      );
      expect(row.review_status).toBe("confirmed"); // review_id DESC ⇒ ar_zzz
      expect(row.review_actor).toBe("u-new");
      expect(row.review_at).toBe(1000);
      expect(pool2.items.find((i) => i.audit_key === ak)!.review_status).toBe("confirmed");
    } finally {
      teardownTempDb();
      __resetAttributionAuditReviewsRepoForTests();
    }
  });

  it("T3：多次迁移后取最后一次（unreviewed→confirmed→needs_fix ⇒ needs_fix）", async () => {
    withTempDb();
    try {
      const S = "sess-77-t3";
      const app = makeApp();
      const ak = seedTruncatedUnit(S, "u-77-t3", 16);
      await writeReview(app, ak, "unreviewed", "confirmed", "u-1");
      await writeReview(app, ak, "confirmed", "needs_fix", "u-2");
      const pool = await poolItems77(app);
      const row = pool.items.find((i) => i.audit_key === ak)!;
      console.log(`77-T3 → ${JSON.stringify({ s: row.review_status, ac: row.review_actor })}`);
      expect(row.review_status).toBe("needs_fix");
      expect(row.review_actor).toBe("u-2");
    } finally {
      teardownTempDb();
      __resetAttributionAuditReviewsRepoForTests();
    }
  });

  it("T4：review_status= 只返回该状态；counts 仍为过滤前全类；非法值 ⇒ 400", async () => {
    withTempDb();
    try {
      const S = "sess-77-t4";
      const app = makeApp();
      const akA = seedTruncatedUnit(S, "u-77-a", 16);
      seedTruncatedUnit(S, "u-77-b", 32);
      const akC = seedTruncatedUnit(S, "u-77-c", 48);
      await writeReview(app, akC, "unreviewed", "confirmed");
      const all = await poolItems77(app);
      const onlyUn = await poolItems77(app, "?review_status=unreviewed");
      const onlyCf = await poolItems77(app, "?review_status=confirmed");
      console.log(
        `77-T4 → 全量=${all.items.length}(counts=${all.counts["suspect:truncated"]})；` +
          `unreviewed=${onlyUn.items.length}(counts=${onlyUn.counts["suspect:truncated"]})；` +
          `confirmed=${onlyCf.items.length}(counts=${onlyCf.counts["suspect:truncated"]})`,
      );
      expect(all.items.length).toBe(3);
      expect(onlyUn.items.length).toBe(2);
      expect(onlyCf.items.length).toBe(1);
      expect(onlyCf.items[0]!.audit_key).toBe(akC);
      expect(onlyUn.items.every((i) => i.review_status === "unreviewed")).toBe(true);
      // 口径守卫：counts 不随 review_status 过滤 —— 三格都等于过滤前全类 3。
      expect([all.counts["suspect:truncated"], onlyUn.counts["suspect:truncated"], onlyCf.counts["suspect:truncated"]]).toEqual([3, 3, 3]);
      expect(akA).not.toBe(akC);
      const bad = await app.request("/v3/admin/attribution/audit-pool?review_status=nope");
      const badBody = (await bad.json()) as { message: string };
      console.log(`77-T4b → 非法值 status=${bad.status} message=${badBody.message}`);
      expect(bad.status).toBe(400);
    } finally {
      teardownTempDb();
      __resetAttributionAuditReviewsRepoForTests();
    }
  });

  it("T4b+：写侧 400 解释原因——message 带 current + data.current_status（不许只回 400）", async () => {
    withTempDb();
    try {
      const S = "sess-77-t4b";
      const app = makeApp();
      const ak = seedTruncatedUnit(S, "u-77-stale", 16);
      await writeReview(app, ak, "unreviewed", "confirmed");
      // 陈旧 prev：UI 以为 unreviewed，实际 latest=confirmed。
      const res = await app.request("/v3/admin/attribution/audit-reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audit_key: ak, prev_status: "unreviewed", status: "dismissed", actor: "u-9" }),
      });
      const body = (await res.json()) as { code: number; message: string; data?: { current_status?: string } };
      console.log(`77-T4b → status=${res.status} message=${body.message} data=${JSON.stringify(body.data)}`);
      expect(res.status).toBe(400);
      expect(body.message).toContain('current="confirmed"');
      expect(body.message).toContain("请刷新");
      expect(body.data?.current_status).toBe("confirmed");
    } finally {
      teardownTempDb();
      __resetAttributionAuditReviewsRepoForTests();
    }
  });
});

describe("119 · A′+C：可见性来源并入 queue（会话级 F3 + 单元级 F4 + 跨域 T1）", () => {
  it("T11 三格：space-1 可见且派生 = space-1（专钉 T1）／Units 三源口径／不跨 space 混显", async () => {
    try {
      withTempDb();
      const q = getAttributionJudgeQueueRepo();
      // 会话 A（cc-vis 形态，space=default）：
      //   u-dc = 有 created 事件（来源①）；u-tb = 无事件、queue(task_boundary)+jd（来源②③，F9 形态）；
      //   u-jd = 无事件、无 queue、有 jd（来源③）。
      seedUnitEvent("cc-vis-119", "u-dc", 0, "default");
      q.enqueue({ unitId: "u-tb", sessionKey: "cc-vis-119", spaceId: "default", trigger: "task_boundary", payload: {} });
      seedDetail("cc-vis-119", "u-tb", { verdict: "unconfirmed", detail: { rationaleRef: "mechanical:test" }, spaceId: "default" });
      seedDetail("cc-vis-119", "u-jd", { verdict: "unconfirmed", detail: { rationaleRef: "mechanical:test" }, spaceId: "default" });
      // 会话 B（sess-1 形态，space=space-1）：无事件、无 status，仅 queue+jd。
      q.enqueue({ unitId: "u-orph", sessionKey: "sess-119", spaceId: "space-1", trigger: "manual", payload: {} });
      seedDetail("sess-119", "u-orph", {
        verdict: "unconfirmed",
        detail: { rationaleRef: "mechanical:test" },
        spaceId: "space-1",
      });

      const app = makeApp();
      type SessionsBody = { data: { sessions: Array<{ session_key: string; space_id: string; counts: { units: number; judged: number } }> } };
      // ① space-1 可见 sess-119，且**派生 space_id 必须是 space-1**（不是 _default —— 专钉 T1 假绿）
      const r1 = (await (await app.request("/v3/admin/attribution/sessions?space_id=space-1&limit=10")).json()) as SessionsBody;
      const s1 = r1.data.sessions.find((x) => x.session_key === "sess-119");
      expect(s1, "sess-119 应可见（queue 并入 keys）").toBeTruthy();
      expect(s1!.space_id, "派生链必须含 queue（T1）").toBe("space-1");
      // ② cc-vis-119 的 Units = 三源并集 = 3（dc+tb+jd）；旧口径（只看 created 事件）= 1
      const r2 = (await (await app.request("/v3/admin/attribution/sessions?space_id=default&limit=10")).json()) as SessionsBody;
      const s2 = r2.data.sessions.find((x) => x.session_key === "cc-vis-119");
      expect(s2!.counts.units, "Units = 事件∪判定∪队列 去重（119·C）").toBe(3);
      expect(s2!.counts.judged).toBe(2);
      // ③ 不跨 space 混显
      const r3 = (await (await app.request("/v3/admin/attribution/sessions?space_id=default&limit=100")).json()) as SessionsBody;
      expect(r3.data.sessions.some((x) => x.session_key === "sess-119"), "default 不得出现 space-1 的会话").toBe(false);
      const r4 = (await (await app.request("/v3/admin/attribution/sessions?space_id=space-1&limit=100")).json()) as SessionsBody;
      expect(r4.data.sessions.some((x) => x.session_key === "cc-vis-119"), "space-1 不得出现 default 的会话").toBe(false);
      console.log(`T11 → sess-119 space=${s1!.space_id} | cc-vis-119 units=${s2!.counts.units} judged=${s2!.counts.judged}`);
    } finally {
      teardownTempDb();
    }
  });
});
