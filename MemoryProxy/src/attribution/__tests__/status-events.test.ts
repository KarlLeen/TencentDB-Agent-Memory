/**
 * 59 · 状态事件落点（50 spec §14）测试矩阵 T1–T5（T6 e2e 在三跳冒烟）。
 *
 * T1 confirmed ⇒ 恰好 1 行、字段/链接齐全、turn/msg NULL；重放 ⇒ duplicate（幂等）。
 * T2 refuted / unconfirmed ⇒ 0 行 + 计数正确（F5：写/不写都可观测）。
 * T3 v1 表零写（红线 6：`attribution_events` 行数与写计数不变）。
 * T4 汇总 = 查询层（listByAsset / rollupByAsset；分母 = 写入行数）。
 * T5 excluded 类别常量 + 消费点（worker detail_json.excludedCategories）。
 * 反向控制（手工、用后即还原）：R1 状态行写 turn_seq ⇒ T1 红；R2 asset_used 写 v1 表 ⇒ T3 红；
 * R3 去掉幂等锚（重放双行）⇒ T1 红。
 */
import { describe, expect, it } from "vitest";

import {
  getAttributionEventRepo,
  getAttributionWriteCounters,
} from "../../db/attributionEventRepo.js";
import { DeterministicMockJudge } from "../judge/deterministic-mock-judge.js";
import {
  deriveStatusId,
  getAttributionStatusEventsCounters,
  getAttributionStatusEventsRepo,
} from "../status-events-repo.js";
import { buildWorkerDeps, runWorker } from "../worker.js";
import { detailsRepo, queueRepo, teardownTempDb, withTempDb, workerDeps } from "./_helpers/base-harness.js";

/** 一行 restraint 队列（visibleAssets 含 asset-a；mock 命中 ⇒ confirmed@asset-a）。 */
function seedConfirmed(sessionKey: string, unitId: string): void {
  queueRepo().enqueue({
    unitId,
    sessionKey,
    payload: {
      kind: "restraint",
      turnSeq: 1,
      msgSeq: 16,
      payload: { visibleAssets: [{ assetId: "asset-a", assetType: "skill" }], text: "见 asset-a 的说明" },
    },
  });
}

describe("59 · T1 confirmed ⇒ 恰好 1 行 + 字段/链接齐全 + turn/msg NULL + 重放 duplicate", () => {
  it("worker 层（真临时库）：confirmed ⇒ 1 行落库，payload 回指 judgement_id，turn/msg 恒 NULL", async () => {
    withTempDb();
    try {
      seedConfirmed("sess-59a", "u-59a");
      const result = await runWorker(workerDeps(), { drain: true });
      expect(result.completed).toBe(1);

      const rows = getAttributionStatusEventsRepo().listByUnit("u-59a");
      expect(rows.length, "confirmed ⇒ 恰好 1 行").toBe(1);
      const row = rows[0]!;
      console.log(
        `T1 → status_id=${row.status_id} event=${row.event_type} asset=${row.asset_id} ` +
          `outcome=${row.outcome} turn=${row.turn_seq} msg=${row.msg_seq} payload=${row.payload_json}`,
      );
      expect(row.event_type).toBe("asset_used");
      expect(row.asset_id).toBe("asset-a");
      expect(row.asset_type).toBe("skill");
      expect(row.session_key).toBe("sess-59a");
      expect(row.round).toBe(0);
      expect(row.turn_seq, "F4：状态行 turn_seq 恒 NULL").toBe(null);
      expect(row.msg_seq, "F4：状态行 msg_seq 恒 NULL").toBe(null);
      expect(row.outcome, "restraint 单元无 resultStatus ⇒ NULL 不猜").toBe(null);

      // 链接字段：judgement_id 回指可对上（单一真相在 judgement_details）
      const jd = detailsRepo().listByUnit("u-59a");
      expect(jd.length).toBe(1);
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      console.log(`T1 链接 → payload.judgement_id=${payload.judgement_id} judgement.judgement_id=${jd[0]!.judgement_id}`);
      expect(payload.judgement_id).toBe(jd[0]!.judgement_id);
      expect(payload.unit_id).toBe("u-59a");
      expect(payload.verdict).toBe("confirmed");
      expect(payload.judge_impl).toBe("mock:v1");
      expect(payload.prompt_sha256).toBe(jd[0]!.prompt_sha256);
      // 只回指不复制判定内容：payload 不含 rationaleRef / detail 全量
      expect(Object.keys(payload).sort()).toEqual(
        ["coverage", "judge_impl", "judgement_id", "match_level", "prompt_sha256", "unit_id", "verdict"].sort(),
      );

      // counters：inserted +1
      expect(getAttributionStatusEventsCounters().inserted).toBe(1);
    } finally {
      teardownTempDb();
    }
  });

  it("repo 层：同锚重放 ⇒ duplicate + count 不增（派生主键幂等锚）", () => {
    withTempDb();
    try {
      const repo = getAttributionStatusEventsRepo();
      const ev = {
        unitId: "u-rep",
        sessionKey: "sess-rep",
        assetId: "asset-a",
        assetType: "skill",
        round: 0,
        outcome: null,
        payload: { judgement_id: "jd_x" },
      };
      const first = repo.insertIdempotent(ev);
      const second = repo.insertIdempotent(ev);
      console.log(`T1 重放 → first=${first.kind} second=${second.kind} count=${repo.count()}`);
      expect(first.kind).toBe("inserted");
      expect(second.kind, "重放 ⇒ duplicate").toBe("duplicate");
      expect(first.statusId).toBe(second.statusId);
      expect(repo.count(), "重放不增行").toBe(1);
      expect(getAttributionStatusEventsCounters()).toMatchObject({ inserted: 1, duplicate: 1 });
    } finally {
      teardownTempDb();
    }
  });
});

describe("59 · T2 refuted / unconfirmed ⇒ 0 行 + 计数正确", () => {
  it("worker 层：unconfirmed 与 refuted 各一行队列 ⇒ status 0 行、两 skipped 桶各 1", async () => {
    withTempDb();
    try {
      // unconfirmed：候选经 fake supply 给出（payload 文本不含任何候选 id ——
      // ⚠️ mock 扫的是 payload **全 JSON 文本**，visibleAssets 里的 assetId 字段本身会进文本 ⇒
      // 用 visibleAssets 构造 unconfirmed 会被误命中（实测教训），必须走 fake supply）。
      queueRepo().enqueue({
        unitId: "u-59b-unconf",
        sessionKey: "sess-59b",
        payload: { kind: "restraint", turnSeq: 1, payload: { text: "无关文本" } },
      });
      // refuted：脚本指定
      queueRepo().enqueue({
        unitId: "u-59b-refuted",
        sessionKey: "sess-59b",
        payload: {
          kind: "restraint",
          turnSeq: 1,
          payload: { visibleAssets: [{ assetId: "asset-a", assetType: "skill" }], text: "见 asset-a" },
        },
      });
      const judge = new DeterministicMockJudge({
        script: { byUnitId: { "u-59b-refuted": { kind: "verdict", verdict: "refuted", assetId: "asset-a" } } },
      });
      const fakeSupply = {
        supply: () => ({
          candidates: [{ assetId: "asset-a", assetType: "skill", evidenceSourceType: "injected" as const }],
          stats: {
            fetchedRows: 0,
            fetchedIn: 0,
            fetchedExcludedHead: 0,
            fetchedExcludedTail: 0,
            fetchedExcludedBoundary: 0,
            fetchedExcludedNonMonotonic: 0,
            fetchedOtherTurn: 0,
            fetchedNoAssetId: 0,
            injectedInHookDone: 0,
            injectedInVisibleAssets: 0,
            mergedDualSource: 0,
            injectedDuplicate: 0,
          },
          dualSource: [],
          fetchedTurnSeq: null,
        }),
      };
      const result = await runWorker(workerDeps({ judge, evidenceSupply: fakeSupply }), { drain: true });
      expect(result.completed).toBe(2);

      const repo = getAttributionStatusEventsRepo();
      const counters = getAttributionStatusEventsCounters();
      console.log(
        `T2 → status count=${repo.count()} counters=${JSON.stringify(counters)} ` +
          `（judgements=${detailsRepo().count()}）`,
      );
      expect(repo.count(), "refuted / unconfirmed 都不写状态行").toBe(0);
      expect(counters.skippedUnconfirmed).toBe(1);
      expect(counters.skippedRefuted).toBe(1);
      expect(counters.inserted).toBe(0);
      // judgement 照落（各自独立）：2 行
      expect(detailsRepo().count()).toBe(2);
    } finally {
      teardownTempDb();
    }
  });
});

describe("59 · T3 v1 表零写（红线 6）", () => {
  it("worker 走完 confirmed ⇒ attribution_events 行数与写计数不变", async () => {
    withTempDb();
    try {
      seedConfirmed("sess-59c", "u-59c");
      const eventsBefore = getAttributionEventRepo().listBySessionWithRowid("sess-59c").length;
      const countersBefore = getAttributionWriteCounters();

      await runWorker(workerDeps(), { drain: true });

      expect(getAttributionStatusEventsRepo().count(), "status 行已落（对照）").toBe(1);
      const eventsAfter = getAttributionEventRepo().listBySessionWithRowid("sess-59c").length;
      const countersAfter = getAttributionWriteCounters();
      console.log(
        `T3 → v1 行数 ${eventsBefore}→${eventsAfter} counters ${JSON.stringify(countersBefore)}→${JSON.stringify(countersAfter)}`,
      );
      expect(eventsAfter, "v1 表零写：行数不变").toBe(eventsBefore);
      expect(countersAfter).toEqual(countersBefore);
    } finally {
      teardownTempDb();
    }
  });
});

describe("59 · T4 汇总 = 查询层（listByAsset / rollupByAsset；分母 = 写入行数）", () => {
  it("两 asset × 两 session ⇒ listByAsset 与 rollup 的 used/session 计数正确 + 排序确定性", () => {
    withTempDb();
    try {
      const repo = getAttributionStatusEventsRepo();
      const mk = (unit: string, sess: string, asset: string) => ({
        unitId: unit,
        sessionKey: sess,
        assetId: asset,
        assetType: "skill",
        round: 0,
        outcome: null,
        payload: { judgement_id: `jd_${unit}` },
      });
      // 分母：4 次写入（a: 2 行 2 会话；b: 1 行 1 会话；c: 1 行 1 会话）
      expect(repo.insertIdempotent(mk("u1", "s1", "asset-a")).kind).toBe("inserted");
      expect(repo.insertIdempotent(mk("u2", "s2", "asset-a")).kind).toBe("inserted");
      expect(repo.insertIdempotent(mk("u3", "s1", "asset-b")).kind).toBe("inserted");
      expect(repo.insertIdempotent(mk("u4", "s3", "asset-c")).kind).toBe("inserted");

      const a = repo.listByAsset("asset-a");
      console.log(`T4 → asset-a 行数=${a.length} rollup=${JSON.stringify(repo.rollupByAsset())}`);
      expect(a.length).toBe(2);

      const rollup = repo.rollupByAsset();
      expect(rollup).toEqual([
        { asset_id: "asset-a", used_count: 2, session_count: 2 },
        { asset_id: "asset-b", used_count: 1, session_count: 1 },
        { asset_id: "asset-c", used_count: 1, session_count: 1 },
      ]);
      // eventType 过滤口与全量一致（本单只有 asset_used）
      expect(repo.rollupByAsset({ eventType: "asset_used" })).toEqual(rollup);
      expect(repo.listByAsset("asset-a", { eventType: "asset_used" }).length).toBe(2);
    } finally {
      teardownTempDb();
    }
  });
});

describe("59 · T5 excluded 类别常量 + 消费点（worker detail_json）", () => {
  it("装配 citationSource ⇒ judgement detail_json.excludedCategories = 两类常量；缺省 ⇒ 不落该键", async () => {
    withTempDb();
    try {
      // ① 装配 citationSource（真 provider：常量不依赖 DB）
      const { archiveCitationSource } = await import("../citation/source.js");
      const { getVisibleTextRepo } = await import("../../db/visibleTextRepo.js");
      seedConfirmed("sess-59d", "u-59d");
      await runWorker(
        workerDeps({ citationSource: archiveCitationSource(getVisibleTextRepo()) }),
        { drain: true },
      );
      const d1 = JSON.parse(detailsRepo().listByUnit("u-59d")[0]!.detail_json) as {
        excludedCategories?: string[];
      };
      console.log(`T5 装配 → excludedCategories=${JSON.stringify(d1.excludedCategories)}`);
      expect(d1.excludedCategories).toEqual(["client-system", "user-original"]);

      // ② 缺省（无 citationSource）⇒ 不落该键（既有形状不变）
      seedConfirmed("sess-59e", "u-59e");
      await runWorker(workerDeps(), { drain: true });
      const d2 = JSON.parse(detailsRepo().listByUnit("u-59e")[0]!.detail_json) as Record<string, unknown>;
      console.log(`T5 缺省 → hasKey=${"excludedCategories" in d2}`);
      expect("excludedCategories" in d2).toBe(false);
    } finally {
      teardownTempDb();
    }
  });

  it("deriveStatusId 派生确定性（同锚同 id；assetId null ⇒ \"\" 占位）", () => {
    expect(deriveStatusId("u", "a", 0)).toBe(deriveStatusId("u", "a", 0));
    expect(deriveStatusId("u", "a", 0)).not.toBe(deriveStatusId("u", null, 0));
    expect(deriveStatusId("u", null, 0)).toBe(deriveStatusId("u", "", 0)); // "" 占位语义
    expect(deriveStatusId("u", "a", 0).startsWith("se_")).toBe(true);
  });
});
