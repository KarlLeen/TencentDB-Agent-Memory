/**
 * 基座-a 单测：判定明细落点表（幂等 / judgement_id 确定性）。
 * 覆盖 design §5 的 T5、T6。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetAttributionJudgementDetailsRepoForTests,
  deriveJudgementId,
  getAttributionJudgementDetailsCounters,
} from "../judgement-details-repo.js";
import { detailsRepo, teardownTempDb, withTempDb } from "./_helpers/base-harness.js";

beforeEach(() => {
  withTempDb();
});

afterEach(() => {
  teardownTempDb();
});

function detail(over: Partial<Parameters<ReturnType<typeof detailsRepo>["insertIdempotent"]>[0]> = {}) {
  return {
    unitId: "u-1",
    sessionKey: "sess-1",
    spaceId: "space-1",
    assetId: "asset-a",
    assetType: "skill",
    round: 0,
    verdict: "confirmed" as const,
    evidenceSourceType: "injected" as const,
    promptSha256: "6ed16597732f5a196378e4081d1a2b873271e08fe22172f2add3bb2d5557d0ac",
    judgeImpl: "mock:v1",
    detail: { rationaleRef: "mock:payload-contains:asset-a", candidateCount: 1 },
    ...over,
  };
}

describe("T5 落库幂等（红线 8）", () => {
  it("同 judgement_id 二次 INSERT OR IGNORE → 1 行 + ignored +1", () => {
    const repo = detailsRepo();

    const first = repo.insertIdempotent(detail());
    expect(first.inserted).toBe(true);
    expect(repo.count()).toBe(1);

    // 重放（崩溃后租约重复判定）：同三元组 ⇒ 同 judgement_id ⇒ 忽略
    const second = repo.insertIdempotent(detail({ detail: { rationaleRef: "changed" } }));
    expect(second.inserted).toBe(false);
    expect(second.judgementId).toBe(first.judgementId);
    expect(repo.count()).toBe(1);

    // 原行不被覆盖（OR IGNORE 语义：先到先得）
    expect(JSON.parse(repo.getById(first.judgementId)!.detail_json).rationaleRef).toBe(
      "mock:payload-contains:asset-a",
    );

    const counters = getAttributionJudgementDetailsCounters();
    expect(counters.inserted).toBe(1);
    expect(counters.ignored).toBe(1);
    expect(counters.failures).toBe(0);
  });

  it("未归因（asset_id=null）重放同样只落 1 行 —— 不靠 NULL 唯一性兜底", () => {
    const repo = detailsRepo();
    // 这条是 R2 的正面证明：若用 UNIQUE(unit_id, asset_id, round) 当锚，
    // NULL 互不相等 ⇒ 这里会落 2 行。
    expect(repo.insertIdempotent(detail({ assetId: null, assetType: null, verdict: "unconfirmed" })).inserted).toBe(true);
    expect(repo.insertIdempotent(detail({ assetId: null, assetType: null, verdict: "unconfirmed" })).inserted).toBe(false);
    expect(repo.count()).toBe(1);
  });

  it("不同 round / 不同 asset 是不同落点", () => {
    const repo = detailsRepo();
    repo.insertIdempotent(detail());
    repo.insertIdempotent(detail({ round: 1 }));
    repo.insertIdempotent(detail({ assetId: "asset-b" }));
    expect(repo.count()).toBe(3);
    expect(repo.listByUnit("u-1")).toHaveLength(3);
  });
});

describe("T6 judgement_id 确定性", () => {
  it("同三元组两次派生逐字节相同；且是纯函数（跨 repo 实例一致）", () => {
    const a = deriveJudgementId("u-1", "asset-a", 0);
    const b = deriveJudgementId("u-1", "asset-a", 0);
    expect(a).toBe(b);
    expect(a).toMatch(/^jd_[0-9a-f]{12}$/);
    // 纯函数：不经 DB 也一致（reset 单例后仍相同 ⇒ id 不依赖任何运行态）
    __resetAttributionJudgementDetailsRepoForTests();
    expect(deriveJudgementId("u-1", "asset-a", 0)).toBe(a);
  });

  it("asset_id=null 与 \"\" 取同一口径（当前取 \"\"）—— 取舍明确写死", () => {
    expect(deriveJudgementId("u-1", null, 0)).toBe(deriveJudgementId("u-1", "", 0));
    // 但与真 assetId 必须不同（不能把未归因和归因撞成一个）
    expect(deriveJudgementId("u-1", null, 0)).not.toBe(deriveJudgementId("u-1", "asset-a", 0));
    // round 参与派生
    expect(deriveJudgementId("u-1", null, 0)).not.toBe(deriveJudgementId("u-1", null, 1));
  });
});
