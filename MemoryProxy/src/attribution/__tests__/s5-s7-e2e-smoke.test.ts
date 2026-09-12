/**
 * 89 · S5–S7 端到端冒烟：一条链路走完 **6 跳**（捕获 → 决策单元抽取 → 入队 →
 * worker drain → 判定行 + asset_used + asset_corrected → read 面回执 DTO + 池候选）。
 *
 * 与既有装置的分工（F1）：
 *   - 现有冒烟只到 S4（base-three-hop / visible-archive-http / loopx-real-assets /
 *     bridge-fetch-events-e2e）；S5–S7 整链此前只有**单元级**测试（72 T2 是手工 seed 版
 *     DTO 断言：seedDetail/seedUsed/seedCorrected 直接写表，**不跑真实写入路径**）。
 *   - **本装置补的正是"真跑一遍"**：判定行 / asset_used 由**真 worker drain** 产出，
 *     asset_corrected 由**真 L1 规则**（applyVersionDriftCorrections）产出，
 *     DTO 由**真 read 面 handler**（sessionDetail）组装 ⇒ 证明"真链路产出的数据
 *     仍满足 68 D1 / K2 / 池类别闭合"。
 *
 * 零 LLM 花费：judge = DeterministicMockJudge（`mock:v1`）——**mock 耗时 ≠ 真 provider
 * 耗时**；本装置验的是链路形状与契约字段，不验归因正确性（属 50 spec）。
 *
 * 隔离：withTempDb 临时库（PROXY_DB_PATH=<mkdtemp>）；getDb() 真库守卫不触发。
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { buildConfig } from "../../config.js";
import { getAttributionEventRepo } from "../../db/attributionEventRepo.js";
import { createAttributionReadHandlers } from "../../routes/attribution-read.js";
import { ASSET_FETCHED_EVENT_TYPE } from "../bridge-fetch-events.js";
import { CORRECTION_ROUTE_VERSION_DRIFT, applyVersionDriftCorrections } from "../corrected-rules.js";
import { AUDIT_CATEGORIES } from "../audit-pool.js";
import { enqueueUnitsForJudge } from "../enqueue.js";
import { getAttributionJudgeQueueRepo } from "../judge-queue-repo.js";
import { getAttributionJudgementDetailsRepo } from "../judgement-details-repo.js";
import { getAttributionStatusEventsRepo } from "../status-events-repo.js";
import { runWorker } from "../worker.js";
import { teardownTempDb, withTempDb, workerDeps } from "./_helpers/base-harness.js";

const SESSION = "smoke-89-e2e";
const ASSET_A = "asset-89-a";
const UNIT_A = "u-89-a"; // confirmed ⇒ asset_used ⇒ asset_corrected（disagreement:corrected）
const UNIT_B = "u-89-b"; // unconfirmed（无可见资产 ⇒ mock 默认规则落 unconfirmed）

/** 递归收集 JSON 里的全部键（C4：键集合级断言，而不是只查一个字符串）。 */
function collectKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) {
    for (const x of v) collectKeys(x, out);
    return out;
  }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out.push(k);
      collectKeys(val, out);
    }
  }
  return out;
}

function makeReadApp(): Hono {
  const h = createAttributionReadHandlers(buildConfig({}));
  const app = new Hono();
  app.get("/v3/admin/attribution/sessions/:session_key", h.sessionDetail);
  app.get("/v3/admin/attribution/audit-pool", h.auditPool);
  return app;
}

describe("89 · S5–S7 端到端冒烟（六跳）", () => {
  it("捕获 → 抽取 → 入队 → drain → 判定/事件 → 回执 DTO + 池候选：逐跳断言", async () => {
    withTempDb();
    try {
      const events = getAttributionEventRepo();
      const queue = getAttributionJudgeQueueRepo();
      const details = getAttributionJudgementDetailsRepo();
      const status = getAttributionStatusEventsRepo();

      // ── 跳① 捕获（归档行：同一 asset 两个版本 ⇒ L1 漂移原料）──────────────────
      for (const version of [1, 3]) {
        events.append({
          sessionKey: SESSION,
          eventType: ASSET_FETCHED_EVENT_TYPE,
          assetId: ASSET_A,
          payload: { v: 1, channel: "fetched", version },
        });
      }
      const fetched = events
        .listBySessionWithRowid(SESSION)
        .filter((r) => r.event_type === ASSET_FETCHED_EVENT_TYPE && r.asset_id === ASSET_A);
      expect(fetched.length).toBe(2);
      expect(fetched.map((r) => JSON.parse(r.payload_json).version)).toEqual([1, 3]);

      // ── 跳② 决策单元抽取（单元落库；visibleAssets = judge 候选来源）───────────
      const unitPayloadA = {
        unitType: "code_change",
        visibleAssets: [{ assetId: ASSET_A, assetType: "skill" }],
      };
      const unitPayloadB = { unitType: "code_change", visibleAssets: [] as unknown[] };
      events.append({
        sessionKey: SESSION,
        eventType: "decision_unit.created",
        unitId: UNIT_A,
        turnSeq: 7,
        msgSeq: 16,
        payload: unitPayloadA,
      });
      events.append({
        sessionKey: SESSION,
        eventType: "decision_unit.created",
        unitId: UNIT_B,
        turnSeq: 7,
        msgSeq: 17,
        payload: unitPayloadB,
      });
      const unitRows = events
        .listBySessionWithRowid(SESSION)
        .filter((r) => r.event_type === "decision_unit.created");
      expect(unitRows.map((r) => r.unit_id).sort()).toEqual([UNIT_A, UNIT_B]);

      // ── 跳③ 入队（生产入口 enqueueUnitsForJudge；enqueue=true 才碰库）─────────
      const outcome = enqueueUnitsForJudge({
        config: { attribution: { judge: { enqueue: true } } },
        sessionKey: SESSION,
        units: [
          { unitId: UNIT_A, kind: "decision_unit", turnSeq: 7, msgSeq: 16, payload: unitPayloadA },
          { unitId: UNIT_B, kind: "decision_unit", turnSeq: 7, msgSeq: 17, payload: unitPayloadB },
        ],
      });
      expect(outcome).toEqual({ skipped: false, inserted: 2, dedupeConflicts: 0 });
      expect(queue.countByStatus().pending).toBe(2);

      // ── 跳④ worker drain（真 worker：mock:v1 ⇒ 零 LLM 花费）───────────────────
      const result = await runWorker(workerDeps(), { drain: true });
      expect(result.claimed).toBe(2);
      expect(result.completed).toBe(2);
      // countByStatus 只带"存在的状态"键 ⇒ 抽干后 pending 键缺省即 0。
      expect(queue.countByStatus().pending ?? 0).toBe(0);
      expect(queue.listByStatus("done").length).toBe(2);

      const jds = details.listBySession(SESSION);
      const jdA = jds.find((j) => j.unit_id === UNIT_A)!;
      const jdB = jds.find((j) => j.unit_id === UNIT_B)!;
      expect(jdA.verdict).toBe("confirmed");
      expect(jdA.asset_id).toBe(ASSET_A);
      expect(jdA.judge_impl).toBe("mock:v1");
      expect(jdB.verdict).toBe("unconfirmed");
      expect(jdB.asset_id).toBeNull();

      const usedRows = status.listBySession(SESSION, { eventType: "asset_used" });
      expect(usedRows.length).toBe(1);
      expect(usedRows[0]!.unit_id).toBe(UNIT_A);
      expect(usedRows[0]!.asset_id).toBe(ASSET_A);

      // ── 跳⑤ asset_corrected（真 L1 规则：版本链 1<3 ⇒ 对每条 used 行产 1 条）──
      const l1 = applyVersionDriftCorrections(SESSION);
      expect(l1.assetsScanned).toBe(1);
      expect(l1.assetsWithDrift).toBe(1);
      expect(l1.correctedInserted).toBe(1);
      const correctedRow = status
        .listBySession(SESSION, { eventType: "asset_corrected" })
        .find((s) => s.asset_id === ASSET_A)!;
      const correctedPayload = JSON.parse(correctedRow.payload_json) as Record<string, unknown>;
      // 四要素（60 spec 口径）+ 只回指
      expect(correctedPayload.correction_route).toBe(CORRECTION_ROUTE_VERSION_DRIFT);
      expect(correctedPayload.anchored_version).toBe(1);
      expect(correctedPayload.latest_version).toBe(3);
      expect(correctedPayload.severity).toBe("signal");
      expect(correctedPayload.used_status_id).toBe(usedRows[0]!.status_id);
      expect(typeof correctedPayload.judgement_id).toBe("string");

      // ── 跳⑥ read 面：回执 DTO（sessionDetail）+ 池候选（audit-pool）────────────
      const app = makeReadApp();
      const res = await app.request(`/v3/admin/attribution/sessions/${SESSION}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          units: Array<{
            unit_id: string;
            judgement: { verdict: string } | null;
            status_events: Array<Record<string, unknown>>;
          }>;
          session: { assets: Array<Record<string, unknown>> };
        };
      };
      expect(body.data.units.length).toBe(2);
      const dtoA = body.data.units.find((u) => u.unit_id === UNIT_A)!;
      expect(dtoA.judgement?.verdict).toBe("confirmed");

      const dtoCorrected = dtoA.status_events.find((s) => s.event_type === "asset_corrected")!;
      // C3/C4：快照锚 = 该行 created_at（R2 钉：改成 Date.now() 必红）
      expect(dtoCorrected.detected_at).toBe(correctedRow.created_at);
      expect(dtoCorrected.snapshot).toEqual({
        anchored_version: 1,
        latest_version: 3,
        semantics: "detected_at_snapshot", // R1 钉：删该键必红
      });
      // C4 键白名单（键集合级，非字符串 includes）：
      // ① corrected 事件键集 = 精确白名单（含 detected_at/route/snapshot）
      expect(Object.keys(dtoCorrected).sort()).toEqual(
        [
          "asset_id",
          "asset_type",
          "created_at",
          "detected_at",
          "event_type",
          "outcome",
          "payload",
          "round",
          "route",
          "snapshot",
          "status_id",
        ].sort(),
      );
      // ② snapshot 键集 = 精确白名单
      expect(Object.keys(dtoCorrected.snapshot as object).sort()).toEqual(
        ["anchored_version", "latest_version", "semantics"].sort(),
      );
      // ③ 整响应递归键集合：不得出现 current_version 形态（68 D1 负向）
      const allKeys = collectKeys(body);
      expect(allKeys.filter((k) => /current[_-]?version/i.test(k))).toEqual([]);

      // 池候选：unit-A 命中 disagreement:corrected；类别 ⊆ AUDIT_CATEGORIES
      const poolRes = await app.request("/v3/admin/attribution/audit-pool");
      expect(poolRes.status).toBe(200);
      const pool = (await poolRes.json()) as {
        data: {
          items: Array<{ unit_id: string; category: string; categories: string[] }>;
          counts_by_category: Record<string, number>;
        };
      };
      const itemA = pool.data.items.find((i) => i.unit_id === UNIT_A)!;
      expect(itemA).toBeDefined();
      expect(itemA.categories).toContain("disagreement:corrected");
      expect(
        pool.data.items.every((i) => (AUDIT_CATEGORIES as readonly string[]).includes(i.category)),
      ).toBe(true);
      expect(pool.data.counts_by_category["disagreement:corrected"]).toBeGreaterThanOrEqual(1);

      console.log(
        `89 obs → units=${body.data.units.length} detected_at=${dtoCorrected.detected_at} ` +
          `snapshot=${JSON.stringify(dtoCorrected.snapshot)} ` +
          `poolItems=${pool.data.items.length} current_version形态键=${allKeys.filter((k) => /current[_-]?version/i.test(k)).length}`,
      );
    } finally {
      teardownTempDb();
    }
  });
});
