/**
 * 97 · S8-a 信用分聚合层单测（C5 七格 + 排序辅助附格；合成数据）。
 *
 * ① Σused=0 ⇒ null；② used=0 且 baseline 有值 ⇒ credit=baseline；③ 次数越多越贴近真实
 * （单调收敛，双侧）；④ 去重口径（同会话 5 次 used + 1 corrected ⇒ 只算 1 对）；⑤ corrected > used
 * ⇒ fail-closed（夹取 + 计数，不抛）；⑥ k 边界；⑦ baseline 加权而非"平均的平均"。
 * ④⑦ 走临时库（真读 rollupByAsset）；余为纯函数。
 */
import { describe, expect, it } from "vitest";

import { getDb } from "../../db/index.js";
import {
  __resetCreditClampCountersForTests,
  computeAssetCredit,
  CREDIT_K_DEFAULT,
  getCreditClampCounters,
  rankByCredit,
  rollupCreditsByAsset,
} from "../credit-score.js";
import { teardownTempDb, withTempDb } from "./_helpers/base-harness.js";

/** 手工落一行 status event（绕过 repo；用于精确控制去重场景）。 */
let seeded = 0;
function insertStatusRow(opts: {
  statusId: string;
  sessionKey: string;
  assetId: string;
  eventType: string;
}): void {
  seeded += 1;
  getDb()!
    .prepare(
      `INSERT INTO attribution_status_events
         (status_id, unit_id, session_key, space_id, asset_id, asset_type, round, event_type, outcome,
          turn_seq, msg_seq, payload_json, created_at)
       VALUES (?, ?, ?, '_default', ?, 'skill', 0, ?, NULL, NULL, NULL, '{}', ?)`,
    )
    .run(opts.statusId, `u-${opts.statusId}`, opts.sessionKey, opts.assetId, opts.eventType, Date.now() + seeded);
}

describe("97 · S8-a 信用分聚合（七格）", () => {
  it("① Σused = 0 ⇒ baseline null 且 credit null（不许凑 0.5）", () => {
    const r = computeAssetCredit(
      { asset_id: "a", used_sessions: 0, corrected_sessions: 0 },
      { used: 0, corrected: 0 },
    );
    expect(r.baseline).toBeNull();
    expect(r.credit).toBeNull();
  });

  it("② used = 0 且 baseline 有值 ⇒ credit = baseline", () => {
    const r = computeAssetCredit(
      { asset_id: "a", used_sessions: 0, corrected_sessions: 0 },
      { used: 10, corrected: 2 },
    );
    expect(r.baseline).toBeCloseTo(0.8, 12);
    expect(r.credit).toBeCloseTo(0.8, 12);
  });

  it("③ 次数越多越贴近真实（单调收敛，双侧）", () => {
    const team = { used: 40, corrected: 20 }; // baseline = 0.5
    // 正确资产（0 corrected）：随 used 增大向 1 收敛
    const good = [1, 5, 25].map(
      (n) => computeAssetCredit({ asset_id: "g", used_sessions: n, corrected_sessions: 0 }, team).credit!,
    );
    expect(good[0]!).toBeLessThan(good[1]!);
    expect(good[1]!).toBeLessThan(good[2]!);
    expect(good[2]!).toBeLessThan(1);
    // 错误资产（全 corrected）：随 used 增大向 0 收敛
    const bad = [1, 5, 25].map(
      (n) => computeAssetCredit({ asset_id: "b", used_sessions: n, corrected_sessions: n }, team).credit!,
    );
    expect(bad[0]!).toBeGreaterThan(bad[1]!);
    expect(bad[1]!).toBeGreaterThan(bad[2]!);
    expect(bad[2]!).toBeGreaterThan(0);
  });

  it("④ 去重口径：同会话 5 次 used + 1 corrected ⇒ 只算 1 对（不是 5/1）", () => {
    withTempDb();
    try {
      // s1：同一会话 5 条 used + 1 条 corrected（同一 asset）
      for (let i = 0; i < 5; i += 1) {
        insertStatusRow({ statusId: `se-4-u${i}`, sessionKey: "s1", assetId: "asset-4", eventType: "asset_used" });
      }
      insertStatusRow({ statusId: "se-4-c0", sessionKey: "s1", assetId: "asset-4", eventType: "asset_corrected" });
      // s2：另一会话 1 条 used（对照 ⇒ 仍去重计入）
      insertStatusRow({ statusId: "se-4-u9", sessionKey: "s2", assetId: "asset-4", eventType: "asset_used" });

      const rows = rollupCreditsByAsset();
      const a = rows.find((r) => r.asset_id === "asset-4")!;
      expect(a.used).toBe(2); // s1 去重 1 + s2 的 1（若用原始行数则是 6）
      expect(a.corrected).toBe(1);
    } finally {
      teardownTempDb();
    }
  });

  it("⑤ corrected > used ⇒ fail-closed：夹取 + 计数，不抛", () => {
    __resetCreditClampCountersForTests();
    const team = { used: 10, corrected: 2 }; // baseline = 0.8
    let r: ReturnType<typeof computeAssetCredit> | undefined;
    expect(() => {
      r = computeAssetCredit({ asset_id: "a", used_sessions: 3, corrected_sessions: 5 }, team);
    }).not.toThrow();
    expect(r!.corrected).toBe(3); // 夹取到 used
    expect(r!.credit).toBeCloseTo((0 + CREDIT_K_DEFAULT * 0.8) / (3 + CREDIT_K_DEFAULT), 12);
    expect(getCreditClampCounters().clamped).toBe(1);
  });

  it("⑥ k 边界：k=0 ⇒ 硬比例；k 很大 ⇒ 趋近 baseline", () => {
    const team = { used: 10, corrected: 2 }; // baseline = 0.8
    const input = { asset_id: "a", used_sessions: 4, corrected_sessions: 1 };
    const hard = computeAssetCredit(input, team, 0);
    expect(hard.credit).toBe(0.75); // (4-1)/4 精确
    const prior = computeAssetCredit(input, team, 1_000_000);
    expect(prior.credit).toBeCloseTo(0.8, 5); // 趋近 baseline
  });

  it("⑦ baseline 用加权（Σused−Σcorrected)/Σused，而非各资产平均的平均", () => {
    withTempDb();
    try {
      // A：1 会话 used、0 corrected。B：9 个会话，每会话 1 used + 1 corrected。
      insertStatusRow({ statusId: "se-7-a-u", sessionKey: "s-a", assetId: "asset-A", eventType: "asset_used" });
      for (let i = 0; i < 9; i += 1) {
        insertStatusRow({ statusId: `se-7-b-u${i}`, sessionKey: `s-b${i}`, assetId: "asset-B", eventType: "asset_used" });
        insertStatusRow({ statusId: `se-7-b-c${i}`, sessionKey: `s-b${i}`, assetId: "asset-B", eventType: "asset_corrected" });
      }
      const rows = rollupCreditsByAsset();
      const a = rows.find((r) => r.asset_id === "asset-A")!;
      const b = rows.find((r) => r.asset_id === "asset-B")!;
      expect(a.used).toBe(1);
      expect(b.used).toBe(9);
      // 加权 = (10-9)/10 = 0.1；"平均的平均" = (1 + 0)/2 = 0.5 ⇒ 必须为 0.1
      expect(a.baseline).toBeCloseTo(0.1, 12);
      expect(b.baseline).toBeCloseTo(0.1, 12);
    } finally {
      teardownTempDb();
    }
  });

  it("附·C3 rankByCredit：非 null 项降序，null 项原位不动（不参与）", () => {
    const items = [
      { id: "x", credit: null as number | null },
      { id: "a", credit: 0.1 },
      { id: "y", credit: null as number | null },
      { id: "b", credit: 0.9 },
    ];
    const ranked = rankByCredit(items);
    expect(ranked.map((r) => r.id)).toEqual(["x", "b", "y", "a"]); // 位 1/3 被降序填充；null 原位
  });
});
