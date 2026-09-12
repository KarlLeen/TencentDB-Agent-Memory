/**
 * 61 · 轮次与触发测试矩阵（50 spec §16）T1–T5（T6 e2e 在三跳冒烟）。
 *
 * T1 重判落新轮（行数 = 轮数 + 旧轮行逐字节仍在）；T2 round 单调；T3 幂等三路径；
 * T4 trigger 标记（task_boundary 登记不可达）；T5 取最新口径。
 * 反向控制（手工、用后即还原）：R1 删/覆盖旧轮行 ⇒ T1 红；R2 round 复用 ⇒ T2 红；
 * R3 生产路径产 task_boundary ⇒ T4 红。
 */
import { describe, expect, it } from "vitest";

import { getDb } from "../../db/index.js";
import { enqueueUnitsForJudge } from "../enqueue.js";
import {
  TRIGGER_DECISION_UNIT,
  TRIGGER_MANUAL,
  TRIGGER_TASK_BOUNDARY,
} from "../judge-queue-repo.js";
import { rejudgeUnit } from "../rejudge.js";
import { getAttributionStatusEventsRepo } from "../status-events-repo.js";
import { detailsRepo, queueRepo, teardownTempDb, withTempDb, workerDeps } from "./_helpers/base-harness.js";
import { runWorker } from "../worker.js";

const ENQUEUE_ON = { attribution: { judge: { enqueue: true } } };

function seedFirstRound(unitId: string, sessionKey: string): void {
  enqueueUnitsForJudge({
    config: ENQUEUE_ON,
    units: [
      {
        unitId,
        kind: "restraint",
        turnSeq: 1,
        msgSeq: 5,
        payload: { visibleAssets: [{ assetId: "asset-a", assetType: "skill" }], text: "见 asset-a" },
      },
    ],
    sessionKey,
  });
}

function queueRowsOfUnit(unitId: string): Array<{ round: number; trigger: string }> {
  return getDb()!
    .prepare("SELECT round, trigger FROM attribution_judge_queue WHERE unit_id = ? ORDER BY round ASC")
    .all(unitId) as Array<{ round: number; trigger: string }>;
}

describe("61 · T1 重判落新轮（行数 = 轮数 + 旧轮行逐字节仍在）", () => {
  it("首判→重判⇒ 三表各多一轮的行（queue=2 / judgement=2 / status=2），旧行快照逐字节未变", async () => {
    withTempDb();
    try {
      const U = "u-rej-t1";
      const S = "sess-rej-t1";
      seedFirstRound(U, S);
      const r1 = await runWorker(workerDeps(), { drain: true });
      expect(r1.completed).toBe(1);

      // 旧轮快照（含 created_at：逐字节）
      const jd0 = detailsRepo().listByUnit(U)[0]!;
      const st0 = getAttributionStatusEventsRepo().listByUnit(U)[0]!;
      const jd0Snap = JSON.stringify(jd0);
      const st0Snap = JSON.stringify(st0);
      expect([jd0.round, st0.round]).toEqual([0, 0]);

      const out = rejudgeUnit({ unitId: U });
      console.log(`T1 重判 → ${JSON.stringify(out)}`);
      expect(out).toEqual({ ok: true, round: 1, enqueued: true });

      const r2 = await runWorker(workerDeps(), { drain: true });
      expect(r2.completed, "第二轮应当新落（锚 (unit_id, round) 不同）").toBe(1);

      // 行数 = 轮数（逐表计数）
      const counts = {
        queue: queueRowsOfUnit(U).length,
        judgement: detailsRepo().listByUnit(U).length,
        status: getAttributionStatusEventsRepo().listByUnit(U).length,
      };
      console.log(`T1 逐表计数 → ${JSON.stringify(counts)}（轮数=2）`);
      expect(counts).toEqual({ queue: 2, judgement: 2, status: 2 });

      const jds = detailsRepo().listByUnit(U);
      const sts = getAttributionStatusEventsRepo().listByUnit(U);
      expect(jds.map((r) => r.round).sort()).toEqual([0, 1]);
      expect(sts.map((r) => r.round).sort()).toEqual([0, 1]);

      // 旧轮行逐字节仍在（不可变纪律）
      expect(JSON.stringify(jds.find((r) => r.round === 0)), "judgement 旧行逐字节").toBe(jd0Snap);
      expect(JSON.stringify(sts.find((r) => r.round === 0)), "status 旧行逐字节").toBe(st0Snap);
      // 新轮 trigger=manual（queue 行级）
      const q = queueRowsOfUnit(U);
      expect(q.map((r) => r.round)).toEqual([0, 1]);
      expect(q[1]!.trigger).toBe("manual");
    } finally {
      teardownTempDb();
    }
  });
});

describe("61 · T2 round 单调（不回退/不复用/不并列）", () => {
  it("连续重判 3 次（不消费）⇒ 1/2/3 且全 enqueued=true；库内 round 严格递增无重复", () => {
    withTempDb();
    try {
      const U = "u-rej-t2";
      seedFirstRound(U, "sess-rej-t2");
      const rounds: number[] = [];
      const enq: boolean[] = [];
      for (let i = 0; i < 3; i += 1) {
        const out = rejudgeUnit({ unitId: U });
        rounds.push(out.round);
        enq.push(out.enqueued);
      }
      const q = queueRowsOfUnit(U);
      console.log(`T2 观测 → rounds=${JSON.stringify(rounds)} enqueued=${JSON.stringify(enq)} 库内=${JSON.stringify(q.map((r) => r.round))}`);
      expect(rounds).toEqual([1, 2, 3]);
      expect(enq).toEqual([true, true, true]);
      expect(q.map((r) => r.round)).toEqual([0, 1, 2, 3]);
      expect(queueRepo().latestByUnit(U)!.round).toBe(3);
    } finally {
      teardownTempDb();
    }
  });
});

describe("61 · T3 幂等（同 (unit_id, round) 重放 ⇒ 三条路径都不双行）", () => {
  it("queue 入队 false + judgement duplicate + status duplicate", () => {
    withTempDb();
    try {
      const U = "u-rej-t3";
      seedFirstRound(U, "sess-rej-t3");
      rejudgeUnit({ unitId: U }); // ⇒ round 1 已入队

      // ① queue：同 (unit_id, round) 再入队 ⇒ false（幂等命中）
      const again = queueRepo().enqueue({ unitId: U, round: 1, sessionKey: "sess-rej-t3", payload: {} });
      expect(again).toBe(false);
      expect(queueRowsOfUnit(U).length).toBe(2);

      // ② judgement：同 (unit_id, round=1) 同参数两次 ⇒ inserted / duplicate
      const detail = {
        unitId: U,
        sessionKey: "sess-rej-t3",
        assetId: "asset-a",
        assetType: "skill",
        round: 1,
        verdict: "confirmed" as const,
        evidenceSourceType: "injected" as const,
        promptSha256: null,
        judgeImpl: "mock:v1",
        detail: { t: 3 },
      };
      expect(detailsRepo().insertIdempotent(detail).kind).toBe("inserted");
      expect(detailsRepo().insertIdempotent(detail).kind).toBe("duplicate");

      // ③ status：同 (unit_id, asset_id, round=1) 两次 ⇒ inserted / duplicate
      const ev = {
        unitId: U,
        sessionKey: "sess-rej-t3",
        assetId: "asset-a",
        assetType: "skill",
        round: 1,
        outcome: null,
        payload: { judgement_id: "jd_t3" },
      };
      const sRepo = getAttributionStatusEventsRepo();
      expect(sRepo.insertIdempotent(ev).kind).toBe("inserted");
      expect(sRepo.insertIdempotent(ev).kind).toBe("duplicate");
      expect(sRepo.listByUnit(U).filter((r) => r.round === 1).length, "重放不双行").toBe(1);
      console.log("T3 观测 → queue=false / judgement=duplicate / status=duplicate（三条路径）");
    } finally {
      teardownTempDb();
    }
  });
});

describe("61 · T4 trigger 标记（task_boundary 登记但不可达）", () => {
  it("首判 ⇒ decision_unit；重判 ⇒ manual；生产两步后库内不含 task_boundary", () => {
    withTempDb();
    try {
      const U = "u-rej-t4";
      seedFirstRound(U, "sess-rej-t4");
      expect(queueRepo().latestByUnit(U)!.trigger, "首判缺省 trigger").toBe(TRIGGER_DECISION_UNIT);

      rejudgeUnit({ unitId: U });
      const latest = queueRepo().latestByUnit(U)!;
      console.log(`T4 观测 → 首判=${TRIGGER_DECISION_UNIT} 重判=${latest.trigger}；常量登记=${TRIGGER_TASK_BOUNDARY}`);
      expect(latest.trigger, "重判产出 manual").toBe(TRIGGER_MANUAL);

      const distinct = getDb()!
        .prepare("SELECT DISTINCT trigger FROM attribution_judge_queue ORDER BY trigger")
        .all() as Array<{ trigger: string }>;
      const triggers = distinct.map((r) => r.trigger);
      console.log(`T4 库内 DISTINCT trigger → ${JSON.stringify(triggers)}`);
      expect(triggers.sort()).toEqual(["decision_unit", "manual"]);
      expect(triggers, "task_boundary 在生产路径不可达").not.toContain(TRIGGER_TASK_BOUNDARY);
      // 枚举值本身已登记（存在但禁产）
      expect(TRIGGER_TASK_BOUNDARY).toBe("task_boundary");
    } finally {
      teardownTempDb();
    }
  });
});

describe("61 · T5 消费侧取最新（查询层，不物化）", () => {
  it("手工造多轮 ⇒ judgement/status 的 latestByUnit 均指最高轮且稳定", () => {
    withTempDb();
    try {
      const U = "u-rej-t5";
      const mkDetail = (round: number) => ({
        unitId: U,
        sessionKey: "sess-rej-t5",
        assetId: "asset-a",
        assetType: "skill",
        round,
        verdict: "confirmed" as const,
        evidenceSourceType: "injected" as const,
        promptSha256: null,
        judgeImpl: "mock:v1",
        detail: { round },
      });
      detailsRepo().insertIdempotent(mkDetail(0));
      detailsRepo().insertIdempotent(mkDetail(1));
      detailsRepo().insertIdempotent(mkDetail(2));
      const sRepo = getAttributionStatusEventsRepo();
      for (const round of [0, 1]) {
        sRepo.insertIdempotent({
          unitId: U,
          sessionKey: "sess-rej-t5",
          assetId: "asset-a",
          assetType: "skill",
          round,
          outcome: null,
          payload: { judgement_id: `jd_r${round}` },
        });
      }

      const jdLatest = detailsRepo().latestByUnit(U);
      const stLatest = sRepo.latestByUnit(U);
      console.log(
        `T5 观测 → judgement.latest.round=${jdLatest!.round}（id=${jdLatest!.judgement_id}）；` +
          `status.latest.round=${stLatest!.round}（id=${stLatest!.status_id}）；stable=${detailsRepo().latestByUnit(U)!.judgement_id === jdLatest!.judgement_id}`,
      );
      expect(jdLatest!.round).toBe(2);
      expect(jdLatest!.judgement_id).toBe(detailsRepo().listByUnit(U).find((r) => r.round === 2)!.judgement_id);
      expect(stLatest!.round).toBe(1);
      expect(stLatest!.status_id).toBe(sRepo.listByUnit(U).find((r) => r.round === 1)!.status_id);
      // 稳定（重复调用同解）
      expect(detailsRepo().latestByUnit(U)!.judgement_id).toBe(jdLatest!.judgement_id);
      expect(sRepo.latestByUnit(U)!.status_id).toBe(stLatest!.status_id);
      // 不物化：latestByUnit 之后无新表（schema 表集合不含"最新轮"物化视图）
      const tables = (getDb()!
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name LIKE '%latest%'")
        .all() ?? []) as Array<{ name: string }>;
      expect(tables.length, "无最新轮物化视图/表").toBe(0);
    } finally {
      teardownTempDb();
    }
  });
});
