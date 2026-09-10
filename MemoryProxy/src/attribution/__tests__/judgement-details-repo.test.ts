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
import { getDb } from "../../db/index.js";
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
    expect(first.kind).toBe("inserted");
    expect(repo.count()).toBe(1);

    // 重放（崩溃后租约重复判定）：同 (unit_id, round) 且同 asset ⇒ 判为 duplicate
    const second = repo.insertIdempotent(detail({ detail: { rationaleRef: "changed" } }));
    expect(second.kind).toBe("duplicate");
    expect(second.judgementId).toBe(first.judgementId);
    expect(repo.count()).toBe(1);

    // detail_json 仍是首写（后到者不改 detail）；verdict 会被后到者覆盖（known limitation，见 50 spec）
    expect(JSON.parse(repo.getById(first.judgementId)!.detail_json).rationaleRef).toBe(
      "mock:payload-contains:asset-a",
    );

    // A4：重放后 counters 不动（inserted 仍 1，ignored 才 +1，anomaly/failures 必须为 0）
    const counters = getAttributionJudgementDetailsCounters();
    expect(counters.inserted).toBe(1);
    expect(counters.ignored).toBe(1);
    expect(counters.anomaly).toBe(0);
    expect(counters.failures).toBe(0);
  });

  it("未归因（asset_id=null）重放同样只落 1 行 —— 不靠 NULL 唯一性兜底", () => {
    const repo = detailsRepo();
    // 这条是 R2 的正面证明：若用 UNIQUE(unit_id, asset_id, round) 当锚，
    // NULL 互不相等 ⇒ 这里会落 2 行。
    expect(repo.insertIdempotent(detail({ assetId: null, assetType: null, verdict: "unconfirmed" })).kind).toBe("inserted");
    expect(repo.insertIdempotent(detail({ assetId: null, assetType: null, verdict: "unconfirmed" })).kind).toBe("duplicate");
    expect(repo.count()).toBe(1);
  });

  it("不同 round 是不同落点；同 (unit_id, round) 换 asset ⇒ anomaly 而非第 2 行", () => {
    const repo = detailsRepo();
    expect(repo.insertIdempotent(detail()).kind).toBe("inserted");
    expect(repo.insertIdempotent(detail({ round: 1 })).kind).toBe("inserted");
    // 语义变更（本交付单元）：旧口径允许 (u-1, round 0) 因 asset 不同再落一行；
    // 新口径下 (unit_id, round) 是唯一落点，换 asset 判为 anomaly，不落第 3 行。
    expect(repo.insertIdempotent(detail({ assetId: "asset-b" })).kind).toBe("anomaly");
    expect(repo.count()).toBe(2);
    expect(repo.listByUnit("u-1")).toHaveLength(2);
  });

  // A3（真 repo + 唯一索引）：判别式在真实落库路径上的正面证据
  it("A3 同 (unit_id, round) 第二次给不同 assetId ⇒ kind=anomaly，库里仍恰 1 行", () => {
    const repo = detailsRepo();
    const first = repo.insertIdempotent(detail());
    expect(first.kind).toBe("inserted");

    const second = repo.insertIdempotent(detail({ assetId: "asset-b" }));
    expect(second.kind).toBe("anomaly");
    expect(second.judgementId).not.toBe(first.judgementId);

    // 直接用 SQL 数行，不借 repo 自己的口径
    const n = (
      getDb()!
        .prepare("SELECT COUNT(*) n FROM attribution_judgement_details WHERE unit_id = ? AND round = ?")
        .get("u-1", 0) as { n: number }
    ).n;
    expect(n).toBe(1);
    expect(repo.count()).toBe(1);
    expect(repo.listByUnit("u-1")).toHaveLength(1);
    expect(getAttributionJudgementDetailsCounters()).toMatchObject({
      inserted: 1,
      ignored: 0,
      anomaly: 1,
      failures: 0,
    });
  });

  // 反简化哨兵（对照实验）：把 ON CONFLICT ... DO UPDATE ... WHERE 换成 DO NOTHING 后
  // 重放与 anomaly 都"没有返回行"，两种语义不可区分 —— 同一批行为会在 A3 上变红。
  it("反简化哨兵：DO NOTHING 下 duplicate 与 anomaly 同形（无返回行）", () => {
    const db = getDb()!;
    const stmt = db.prepare(`
      INSERT INTO attribution_judgement_details
        (judgement_id, unit_id, session_key, space_id, asset_id, asset_type, round, verdict,
         evidence_source_type, prompt_sha256, judge_impl, detail_json, created_at)
      VALUES
        (@judgementId, @unitId, @sessionKey, @spaceId, @assetId, @assetType, @round, @verdict,
         @evidenceSourceType, @promptSha256, @judgeImpl, @detailJson, @createdAt)
      ON CONFLICT(unit_id, round) DO NOTHING
      RETURNING created_at
    `);
    const bind = (assetId: string, createdAt: number) => ({
      judgementId: deriveJudgementId("u-donothing", assetId, 0),
      unitId: "u-donothing",
      sessionKey: "s-1",
      spaceId: "_default",
      assetId,
      assetType: "skill",
      round: 0,
      verdict: "confirmed",
      evidenceSourceType: "injected",
      promptSha256: null,
      judgeImpl: "mock:v1",
      detailJson: "{}",
      createdAt,
    });

    expect(stmt.get(bind("asset-a", 1000))).toBeDefined();
    // 重放：无返回行 ⇒ 与"异常"同形，duplicate 无法识别
    expect(stmt.get(bind("asset-a", 2000))).toBeUndefined();
    // anomaly：同样无返回行 ⇒ 判别式失效
    expect(stmt.get(bind("asset-b", 3000))).toBeUndefined();
    const n = (
      db
        .prepare("SELECT COUNT(*) n FROM attribution_judgement_details WHERE unit_id = ? AND round = ?")
        .get("u-donothing", 0) as { n: number }
    ).n;
    expect(n).toBe(1);
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
