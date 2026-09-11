/**
 * 56 · 证据供给 provider（50 spec §11）测试矩阵 T1–T6（T7 e2e 在 base-three-hop-smoke）。
 *
 * 钉的三件事（工单 B1/F2 + P-1 教训）：
 *   - T1 焊回归：无证据供给 ⇒ 候选恒 []（B1 修复不许让候选无中生有）；
 *   - T2 门控矩阵：§10 锚定四态一律排除 + 按原因计数（不许"带标记进"）；
 *   - T4 标注：evidenceSourceType 由来源决定（钉死 worker.ts 硬编码 "injected" 的删除）。
 * 反向控制（手工、用后即还原）：R1 去门控（boundary 也进）⇒ T2 必红；R2 恢复硬编码 ⇒ T4 必红。
 */
import { describe, expect, it } from "vitest";

import {
  __resetAttributionEventRepoForTests,
  getAttributionEventRepo,
  getAttributionWriteCounters,
  type AttributionEventRowWithRowid,
  type NewAttributionEvent,
} from "../../db/attributionEventRepo.js";
import { getDb } from "../../db/index.js";
import { EVENT_TYPE_DECISION_UNIT_CREATED } from "../../decision-units/decision-unit-runner.js";
import { ASSET_FETCHED_EVENT_TYPE } from "../bridge-fetch-events.js";
import { createEvidenceSupplyProvider, type EvidenceSupplyStats } from "../evidence-supply.js";
import { runWorker } from "../worker.js";
import { detailsRepo, queueRepo, teardownTempDb, withTempDb, workerDeps } from "./_helpers/base-harness.js";

const S = "sess-56";
const HOOK_DONE = "injection.hook.done";

let rid = 0;

function row(p: Partial<AttributionEventRowWithRowid> & { event_type: string }): AttributionEventRowWithRowid {
  rid += 1;
  return {
    rowid: rid,
    event_id: `ev-${rid}`,
    space_id: "_default",
    user_id: null,
    agent_source: "claude-code",
    session_key: S,
    turn_seq: null,
    msg_seq: null,
    asset_id: null,
    asset_type: null,
    unit_id: null,
    payload_json: "{}",
    created_at: 1_700_000_000_000 + rid * 1000,
    ...p,
  };
}

const unit = (turnSeq: number, createdAt?: number): AttributionEventRowWithRowid =>
  row({
    event_type: EVENT_TYPE_DECISION_UNIT_CREATED,
    turn_seq: turnSeq,
    ...(createdAt !== undefined ? { created_at: createdAt } : {}),
  });

const fetched = (assetId: string | null, createdAt?: number): AttributionEventRowWithRowid =>
  row({
    event_type: ASSET_FETCHED_EVENT_TYPE,
    asset_id: assetId,
    asset_type: assetId ? "skill" : null,
    ...(createdAt !== undefined ? { created_at: createdAt } : {}),
  });

const hookDone = (assetId: string, turnSeq: number, createdAt?: number): AttributionEventRowWithRowid =>
  row({
    event_type: HOOK_DONE,
    asset_id: assetId,
    asset_type: "skill",
    turn_seq: turnSeq,
    ...(createdAt !== undefined ? { created_at: createdAt } : {}),
  });

function fakeRepo(rows: AttributionEventRowWithRowid[]): Pick<
  ReturnType<typeof getAttributionEventRepo>,
  "listBySessionWithRowid"
> {
  return { listBySessionWithRowid: () => rows };
}

/** 行形状（AttributionEventRowWithRowid）→ 落库输入（NewAttributionEvent）的投影。 */
function toNew(r: AttributionEventRowWithRowid): NewAttributionEvent {
  return {
    sessionKey: r.session_key,
    turnSeq: r.turn_seq,
    eventType: r.event_type,
    assetId: r.asset_id,
    assetType: r.asset_type,
    payload: {},
  };
}

function statLine(name: string, stats: EvidenceSupplyStats): string {
  return (
    `${name} → fetchedRows=${stats.fetchedRows} in=${stats.fetchedIn} ` +
    `head=${stats.fetchedExcludedHead} tail=${stats.fetchedExcludedTail} boundary=${stats.fetchedExcludedBoundary} ` +
    `nonMono=${stats.fetchedExcludedNonMonotonic} otherTurn=${stats.fetchedOtherTurn} noAsset=${stats.fetchedNoAssetId} ` +
    `hookIn=${stats.injectedInHookDone} visIn=${stats.injectedInVisibleAssets} merged=${stats.mergedDualSource}`
  );
}

describe("56 · 证据供给 T1–T6（契约 = 50 spec §11）", () => {
  it("T1 纯 key_tool_call 单元（无任何证据供给）⇒ 候选恒 []（B1 先焊回归）", () => {
    const out = createEvidenceSupplyProvider(fakeRepo([unit(1)])).supply({
      sessionKey: S,
      turnSeq: 1,
      visibleAssets: undefined, // key_tool_call 的 payload 没有 visibleAssets
    });
    console.log(`T1 → candidates=${JSON.stringify(out.candidates)}`);
    expect(out.candidates).toEqual([]);
    expect(out.stats.fetchedRows).toBe(0);
    expect(out.stats.injectedInHookDone).toBe(0);
    expect(out.stats.injectedInVisibleAssets).toBe(0);
    expect(out.fetchedTurnSeq).toBe(null);
  });

  it("T2 fetched 门控矩阵：in_turn(本轮) 进（带轮次落点）；四态 + otherTurn + noAssetId 各一格排除", () => {
    // ① in_turn(1) ⇒ 进，且轮次落点 = 1
    const g1 = createEvidenceSupplyProvider(fakeRepo([unit(1), fetched("A"), unit(1)])).supply({
      sessionKey: S,
      turnSeq: 1,
    });
    console.log(`T2① in_turn → ${JSON.stringify(g1.candidates)} fetchedTurnSeq=${g1.fetchedTurnSeq}`);
    expect(g1.candidates).toEqual([{ assetId: "A", assetType: "skill", evidenceSourceType: "fetched" }]);
    expect(g1.stats.fetchedIn).toBe(1);
    expect(g1.fetchedTurnSeq).toBe(1);

    // ②–⑤ 四态各一格：不进 + 对应桶 +1
    const gates: Array<{
      name: string;
      rows: AttributionEventRowWithRowid[];
      bucket: keyof EvidenceSupplyStats;
    }> = [
      { name: "head", rows: [fetched("A"), unit(1)], bucket: "fetchedExcludedHead" },
      { name: "tail", rows: [unit(1), fetched("A")], bucket: "fetchedExcludedTail" },
      { name: "boundary", rows: [unit(1), fetched("A"), unit(2)], bucket: "fetchedExcludedBoundary" },
      {
        name: "non_monotonic",
        rows: [unit(1, 1000), fetched("A", 3000), unit(1, 2000)],
        bucket: "fetchedExcludedNonMonotonic",
      },
    ];
    for (const g of gates) {
      const out = createEvidenceSupplyProvider(fakeRepo(g.rows)).supply({ sessionKey: S, turnSeq: 1 });
      console.log(`T2 ${statLine(g.name, out.stats)}`);
      expect(out.candidates, `${g.name} 不许进候选（含"带标记进"）`).toEqual([]);
      expect(out.stats[g.bucket], `${g.name} 计数桶`).toBe(1);
      expect(out.stats.fetchedRows).toBe(1);
      expect(out.fetchedTurnSeq).toBe(null);
    }

    // ⑥ in_turn 但非当前轮 ⇒ otherTurn
    const g6 = createEvidenceSupplyProvider(fakeRepo([unit(1), fetched("A"), unit(1), unit(2)])).supply({
      sessionKey: S,
      turnSeq: 2,
    });
    console.log(`T2 ${statLine("otherTurn", g6.stats)}`);
    expect(g6.candidates).toEqual([]);
    expect(g6.stats.fetchedOtherTurn).toBe(1);

    // ⑦ in_turn 本轮但 asset_id NULL ⇒ noAssetId（brainstorm A3）
    const g7 = createEvidenceSupplyProvider(fakeRepo([unit(1), fetched(null), unit(1)])).supply({
      sessionKey: S,
      turnSeq: 1,
    });
    console.log(`T2 ${statLine("noAssetId", g7.stats)}`);
    expect(g7.candidates).toEqual([]);
    expect(g7.stats.fetchedNoAssetId).toBe(1);
  });

  it("T3 双源合并：同 assetId fetched+injected ⇒ 单条、fetched 优先、双源事实落 detail_json", async () => {
    // ── provider 层：合并 + 计数 ──
    const out = createEvidenceSupplyProvider(
      fakeRepo([unit(1), fetched("skl-dual-0001"), unit(1), hookDone("skl-dual-0001", 1)]),
    ).supply({ sessionKey: S, turnSeq: 1 });
    console.log(
      `T3 provider → ${JSON.stringify(out.candidates)} merged=${out.stats.mergedDualSource} dual=${JSON.stringify(out.dualSource)}`,
    );
    expect(out.candidates).toEqual([
      { assetId: "skl-dual-0001", assetType: "skill", evidenceSourceType: "fetched" },
    ]);
    expect(out.stats.mergedDualSource).toBe(1);
    expect(out.dualSource).toEqual([
      { assetId: "skl-dual-0001", assetType: "skill", fetchedTurnSeq: 1, injectedVia: "hook.done" },
    ]);

    // ── worker 层（真临时库）：双源事实落 judgement 的 detail_json ──
    withTempDb();
    __resetAttributionEventRepoForTests();
    try {
      const eventRepo = getAttributionEventRepo();
      eventRepo.appendMany(
        [unit(1), fetched("skl-dual-0001"), unit(1), hookDone("skl-dual-0001", 1)].map(toNew),
      );
      queueRepo().enqueue({
        unitId: "u-dual",
        sessionKey: S,
        payload: {
          kind: "key_tool_call",
          turnSeq: 1,
          msgSeq: 16,
          payload: { text: "对 skl-dual-0001 做了一次调用" }, // mock 命中 ⇒ verdict confirmed
        },
      });

      const result = await runWorker(
        workerDeps({ evidenceSupply: createEvidenceSupplyProvider(eventRepo) }),
        { drain: true },
      );
      expect(result.completed).toBe(1);

      const rows = detailsRepo().listBySession(S);
      expect(rows.length).toBe(1);
      const detail = JSON.parse(rows[0]!.detail_json) as {
        candidateCount: number;
        evidenceSupply?: { stats: EvidenceSupplyStats; dualSource: unknown[]; fetchedTurnSeq: number | null };
      };
      console.log(`T3 worker → evidence_source_type=${rows[0]!.evidence_source_type} detail=${rows[0]!.detail_json}`);
      expect(rows[0]!.evidence_source_type).toBe("fetched"); // 标注落库列（生产侧 F2 证据）
      expect(detail.candidateCount).toBe(1); // 双源合并为一条
      expect(detail.evidenceSupply?.dualSource).toEqual([
        { assetId: "skl-dual-0001", assetType: "skill", fetchedTurnSeq: 1, injectedVia: "hook.done" },
      ]);
      expect(detail.evidenceSupply?.stats.mergedDualSource).toBe(1);
      expect(detail.evidenceSupply?.fetchedTurnSeq).toBe(1);
    } finally {
      teardownTempDb();
    }
  });

  it("T4 标注：fetched 路 ⇒ 'fetched'，injected 路 ⇒ 'injected'（钉死硬编码删除）", () => {
    const out = createEvidenceSupplyProvider(
      fakeRepo([unit(1), fetched("skl-f-1"), unit(1), hookDone("skl-i-1", 1)]),
    ).supply({ sessionKey: S, turnSeq: 1 });
    console.log(`T4 → ${JSON.stringify(out.candidates)}`);
    expect(out.candidates).toEqual([
      { assetId: "skl-f-1", assetType: "skill", evidenceSourceType: "fetched" },
      { assetId: "skl-i-1", assetType: "skill", evidenceSourceType: "injected" },
    ]);
  });

  it("T5 零写：provider 全路径跑完后写计数增量全 0 + 水位行数不变（T25 姿势）", () => {
    withTempDb();
    __resetAttributionEventRepoForTests();
    try {
      const repo = getAttributionEventRepo();
      // 供给面造数据（写计数会涨 —— 这是**写**侧，不是 provider）
      repo.appendMany(
        [unit(1), fetched("skl-z-1"), unit(1), hookDone("skl-z-2", 1)].map(toNew),
      );
      const db = getDb();
      expect(db, "临时库不可用 ⇒ T5 无意义").not.toBe(null);
      const wmBefore = (
        db!.prepare("SELECT COUNT(*) AS n FROM attribution_archive_watermark").get() as { n: number }
      ).n;
      const before = getAttributionWriteCounters();

      const out = createEvidenceSupplyProvider(repo).supply({ sessionKey: S, turnSeq: 1 });
      expect(out.candidates.length, "provider 没读到候选 ⇒ 零写断言是空跑").toBeGreaterThan(0);
      expect(out.stats.fetchedRows, "provider 没读到 fetched 行 ⇒ 零写断言是空跑").toBe(1);

      const after = getAttributionWriteCounters();
      const wmAfter = (
        db!.prepare("SELECT COUNT(*) AS n FROM attribution_archive_watermark").get() as { n: number }
      ).n;
      console.log(
        `T5 → counters before=${JSON.stringify(before)} after=${JSON.stringify(after)} watermark ${wmBefore}→${wmAfter}`,
      );
      expect(after).toEqual(before); // appended / dedupeConflicts / failures 增量全 0
      expect(wmAfter).toBe(wmBefore); // 水位行数不变
    } finally {
      teardownTempDb();
    }
  });

  it("T6 DB 降级：Null repo ⇒ 两路空、visibleAssets 便捷路径仍在（不失联）", () => {
    const out = createEvidenceSupplyProvider(fakeRepo([])).supply({
      sessionKey: S,
      turnSeq: 1,
      visibleAssets: [{ assetId: "skl-v-1", assetType: "skill" }],
    });
    console.log(`T6 → ${JSON.stringify(out.candidates)}`);
    expect(out.candidates).toEqual([
      { assetId: "skl-v-1", assetType: "skill", evidenceSourceType: "injected" },
    ]);
    expect(out.stats.fetchedRows).toBe(0);
    expect(out.stats.injectedInHookDone).toBe(0);
    expect(out.stats.injectedInVisibleAssets).toBe(1);
  });
});
