/**
 * 66 · S6 实现单测试矩阵（60 spec + 勘正 2/3）：
 *
 * item 0：分公式 + 去硬编码 + **存量兼容（重放格：旧行 + 新代码重放 ⇒ duplicate 且行数不变）**；
 * 单元 A：L1 版本漂移 golden + **窗口外反例** + V2（不回改逐字节快照）+ 幂等；
 * 单元 B：`task_boundary` 生产（compaction ⇒ 该批 trigger；无信号 ⇒ 缺省）+ 收窄断言。
 * 反向控制（手工、用后即还原）：R0 公式统一 ⇒ 重放格红；R1 关 L1 检测 ⇒ golden 红；
 * R2 corrected 改 used 行 ⇒ V2 红；R3 无信号也产 task_boundary ⇒ 负向格红。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildConfig } from "../../config.js";
import { getAttributionEventRepo } from "../../db/attributionEventRepo.js";
import { getDb } from "../../db/index.js";
import {
  __resetDecisionUnitStateForTests,
  runDecisionUnitExtraction,
} from "../../decision-units/decision-unit-runner.js";
import { applyVersionDriftCorrections } from "../corrected-rules.js";
import { __resetAttributionJudgeQueueRepoForTests, getAttributionJudgeQueueRepo } from "../judge-queue-repo.js";
import {
  __resetAttributionStatusEventsRepoForTests,
  getAttributionStatusEventsRepo,
  STATUS_EVENT_TYPE_ASSET_CORRECTED,
} from "../status-events-repo.js";
import { teardownTempDb, withTempDb } from "./_helpers/base-harness.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return true;
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
}

function statusRows(sessionKey: string): Array<{ status_id: string; event_type: string; payload_json: string }> {
  return getDb()!
    .prepare(
      "SELECT status_id, event_type, payload_json FROM attribution_status_events WHERE session_key = ? ORDER BY created_at ASC, status_id ASC",
    )
    .all(sessionKey) as Array<{ status_id: string; event_type: string; payload_json: string }>;
}

function queueTriggers(sessionKey: string): Array<{ trigger: string; round: number }> {
  return getDb()!
    .prepare("SELECT trigger, round FROM attribution_judge_queue WHERE session_key = ? ORDER BY queue_id ASC")
    .all(sessionKey) as Array<{ trigger: string; round: number }>;
}

describe("66 · item 0 存量兼容（重放格：断的是对的性质）", () => {
  it("旧公式行 + 新代码重放同一 used 事件 ⇒ duplicate 且行数不变（id 命中旧行）", () => {
    withTempDb();
    try {
      // 手工落"旧公式"的 used 行：**独立算旧 id**（不调生产函数——证明旧行真实存在）
      const legacyId = `se_${createHash("sha1").update("u-legacy|asset-a|0", "utf8").digest("hex").slice(0, 12)}`;
      // ⚠️ 旧行时间戳**错开 1s**：判别 inserted/duplicate 依赖"RETURNING.created_at === 本次值"，
      // 同毫秒重放会被误判为 inserted（59 的**已登记边界**：只错一格计数、不丢数据）——
      // 本格要测的是"幂等命中"，用错开时间戳让 kind 判定准确（行数断言为冗余保险）。
      getDb()!
        .prepare(
          `INSERT INTO attribution_status_events
             (status_id, unit_id, session_key, space_id, asset_id, asset_type, round, event_type, outcome,
              turn_seq, msg_seq, payload_json, created_at)
           VALUES (?, ?, ?, '_default', ?, ?, 0, 'asset_used', NULL, NULL, NULL, '{}', ?)`,
        )
        .run(legacyId, "u-legacy", "sess-legacy", "asset-a", "skill", Date.now() - 1000);
      const before = statusRows("sess-legacy").length;

      // 新代码重放同一 used 事件（缺省 eventType=used ⇒ 三元组 ⇒ 应命中旧行）
      const res = getAttributionStatusEventsRepo().insertIdempotent({
        unitId: "u-legacy",
        sessionKey: "sess-legacy",
        assetId: "asset-a",
        assetType: "skill",
        round: 0,
        outcome: null,
        payload: {},
      });
      const after = statusRows("sess-legacy");
      console.log(`66 重放格 → kind=${res.kind} id=${res.statusId}（=旧行 ${res.statusId === legacyId}）；行数 ${before}→${after.length}`);
      expect(res.statusId, "派生式必须命中旧行 id").toBe(legacyId);
      expect(res.kind, "重放 ⇒ duplicate（幂等锚命中，不落第二行）").toBe("duplicate");
      expect(after.length, "行数不变").toBe(before);
    } finally {
      teardownTempDb();
    }
  });

  it("67 · route-bearing fail-closed 四格：缺 route ⇒ failed+0 行；带 route ⇒ inserted；used 带/不带 route 行为不变", () => {
    withTempDb();
    try {
      const repo = getAttributionStatusEventsRepo();
      // ① asset_corrected **缺 route** ⇒ failed + 计数 + 零落行（不猜、不伪造）
      const r1 = repo.insertIdempotent({
        unitId: "u-rb-1",
        sessionKey: "sess-rb",
        assetId: "asset-a",
        assetType: "skill",
        round: 0,
        eventType: "asset_corrected",
        outcome: null,
        payload: {},
      });
      // ② 对照：带 route ⇒ 正常 inserted
      const r2 = repo.insertIdempotent({
        unitId: "u-rb-2",
        sessionKey: "sess-rb",
        assetId: "asset-a",
        assetType: "skill",
        round: 0,
        eventType: "asset_corrected",
        route: "version_drift",
        outcome: null,
        payload: {},
      });
      console.log(
        `67 四格 → ①缺route=${JSON.stringify(r1)}；②带route=${JSON.stringify(r2)}；行数=${statusRows("sess-rb").length}`,
      );
      expect(r1.kind, "① 缺 route ⇒ failed").toBe("failed");
      expect(r2.kind, "② 带 route ⇒ inserted").toBe("inserted");
      expect(statusRows("sess-rb").length, "① 零落行 + ② 恰 1 行").toBe(1);

      // ③ asset_used 带/不带 route ⇒ 行为完全不变（legacy 三元组；route 被忽略）
      const r3a = repo.insertIdempotent({
        unitId: "u-rb-legacy",
        sessionKey: "sess-rb",
        assetId: "asset-a",
        assetType: "skill",
        round: 0,
        outcome: null,
        payload: {},
      });
      const r3b = repo.insertIdempotent({
        unitId: "u-rb-legacy",
        sessionKey: "sess-rb",
        assetId: "asset-a",
        assetType: "skill",
        round: 0,
        route: "some_route", // used 带 route：应被忽略、派生式不变 ⇒ 重放命中同 id
        outcome: null,
        payload: {},
      });
      const legacyId = `se_${createHash("sha1").update("u-rb-legacy|asset-a|0", "utf8").digest("hex").slice(0, 12)}`;
      console.log(
        `67 四格 used → 无route=${JSON.stringify({ kind: r3a.kind, id: r3a.statusId })}；带route=${JSON.stringify({ kind: r3b.kind, id: r3b.statusId })}；legacyId=${legacyId}`,
      );
      expect(r3a.kind).toBe("inserted");
      expect(r3a.statusId, "used 沿用 legacy 三元组").toBe(legacyId);
      expect(r3b.kind, "used 带 route ⇒ 重放命中（route 不参与 used 派生）").toBe("duplicate");
      expect(r3b.statusId).toBe(r3a.statusId);
      expect(statusRows("sess-rb").length, "③ 未新增行").toBe(2);
    } finally {
      teardownTempDb();
    }
  });

  it("白名单：未知事件型 fail-closed（不写 + failed 计数，不伪造）", () => {
    withTempDb();
    try {
      const res = getAttributionStatusEventsRepo().insertIdempotent({
        unitId: "u-wl",
        sessionKey: "sess-wl",
        assetId: "asset-a",
        assetType: "skill",
        round: 0,
        eventType: "asset_validated", // 仍禁写（60 spec §5 收窄只放开 corrected）
        outcome: null,
        payload: {},
      });
      console.log(`66 白名单 → ${JSON.stringify(res)}`);
      expect(res.kind).toBe("failed");
      expect(statusRows("sess-wl").length).toBe(0);
    } finally {
      teardownTempDb();
    }
  });
});

describe("66 · 单元 A：L1 版本漂移（golden + 窗口外反例 + V2 + 幂等）", () => {
  function seedFetched(sessionKey: string, assetId: string, versions: number[]): void {
    getAttributionEventRepo().appendMany(
      versions.map((v) => ({
        sessionKey,
        eventType: "asset_fetched",
        assetId,
        assetType: "skill",
        payload: { version: v },
      })),
    );
  }

  function seedUsed(sessionKey: string, unitId: string, assetId: string): string {
    const r = getAttributionStatusEventsRepo().insertIdempotent({
      unitId,
      sessionKey,
      assetId,
      assetType: "skill",
      round: 0,
      outcome: null,
      payload: { judgement_id: `jd_${unitId}` },
    });
    return r.statusId;
  }

  it("golden：窗口内 v1→v2 漂移 ⇒ 每条 used 行 1 条 corrected（只回指）+ 重放 duplicate", () => {
    withTempDb();
    try {
      const S = "sess-l1";
      seedFetched(S, "asset-l1", [1, 2]);
      const usedId = seedUsed(S, "u-l1", "asset-l1");
      const usedSnap = JSON.stringify(statusRows(S)[0]);

      const out = applyVersionDriftCorrections(S);
      console.log(`66 L1 golden → ${JSON.stringify(out)}`);
      expect(out.assetsWithDrift).toBe(1);
      expect(out.correctedInserted).toBe(1);

      const rows = statusRows(S);
      expect(rows.length).toBe(2);
      const corrected = rows.find((r) => r.event_type === STATUS_EVENT_TYPE_ASSET_CORRECTED)!;
      const cp = JSON.parse(corrected.payload_json) as Record<string, unknown>;
      console.log(`66 L1 corrected → ${JSON.stringify(cp)}`);
      expect(cp.correction_route).toBe("version_drift");
      expect(cp.used_status_id).toBe(usedId);
      expect(cp.judgement_id).toBe("jd_u-l1");
      expect(cp.anchored_version).toBe(1);
      expect(cp.latest_version).toBe(2);
      // V2：used 行逐字节未变（不回改）
      expect(JSON.stringify(rows.find((r) => r.event_type === "asset_used"))).toBe(usedSnap);

      // 幂等：再跑一次 ⇒ duplicate（五元组锚）
      const again = applyVersionDriftCorrections(S);
      console.log(`66 L1 重放 → ${JSON.stringify(again)}`);
      expect(again.correctedDuplicate).toBe(1);
      expect(statusRows(S).length).toBe(2);
    } finally {
      teardownTempDb();
    }
  });

  it("反例：无漂移（仅 v1）⇒ 0 条；窗口外 v2（别的 session）⇒ 0 条", () => {
    withTempDb();
    try {
      const S = "sess-l1-neg";
      seedFetched(S, "asset-n1", [1]); // 单版本
      seedUsed(S, "u-n1", "asset-n1");
      // 窗口外：v2 落在另一个 session（L1 只扫给定 session；不回查补齐）
      seedFetched("sess-other", "asset-n1", [1, 2]);
      seedUsed("sess-other", "u-n1b", "asset-n1");

      const out = applyVersionDriftCorrections(S);
      console.log(`66 L1 反例 → ${JSON.stringify(out)}`);
      expect(out.correctedInserted).toBe(0);
      expect(out.assetsSkippedNoVersion).toBe(1); // 仅 1 个可取版本 ⇒ 跳过（不猜）
      expect(statusRows(S).length).toBe(1);
    } finally {
      teardownTempDb();
    }
  });
});

describe("146 · L2/L3 = 触发式（不实现）+ L3 必不产（行为格 + 文本锚）", () => {
  it("行为格：\"取不到\"与\"单版本无法判定\"两种不确定态 ⇒ **0 条 corrected**（必不产）", () => {
    withTempDb();
    try {
      const S = "sess-146-l3";
      // 60 spec §2.3 反例：不确定 ≠ 确定不存在 ⇒ 必不产（只有明确 404 / ACL 明确拒绝 才可产）。
      // 本线**无 L3 生产者**；此格钉住两条"不确定"路径的行为：
      //   ① asset-v：fetched 行**无 version**（取不到 ⇒ 连扫描都不进）；
      //   ② asset-u：只有**单版本**（无法判定漂移 ⇒ 跳过，不猜）。
      getAttributionEventRepo().appendMany([
        { sessionKey: S, eventType: "asset_fetched", assetId: "asset-v", assetType: "skill", payload: {} },
        { sessionKey: S, eventType: "asset_fetched", assetId: "asset-u", assetType: "skill", payload: { version: 1 } },
      ]);
      for (const [unitId, assetId] of [["u-146-l3v", "asset-v"], ["u-146-l3u", "asset-u"]] as const) {
        getAttributionStatusEventsRepo().insertIdempotent({
          unitId,
          sessionKey: S,
          assetId,
          assetType: "skill",
          round: 0,
          outcome: null,
          payload: { judgement_id: `jd_${unitId}` },
        });
      }
      const out = applyVersionDriftCorrections(S);
      console.log(`146 必不产 → ${JSON.stringify(out)}`);
      expect(out.correctedInserted).toBe(0);
      expect(out.correctedDuplicate).toBe(0);
      expect(out.assetsSkippedNoVersion).toBe(1); // asset-u（单版本）；asset-v 取不到 ⇒ 不进扫描
      expect(statusRows(S).length).toBe(2); // 只有两条 used 行（零 corrected）
      expect(statusRows(S).every((r) => r.event_type !== STATUS_EVENT_TYPE_ASSET_CORRECTED)).toBe(true);
    } finally {
      teardownTempDb();
    }
  });

  it("文本锚：60 spec §2.4 已登记 L2/L3 触发条件 + 必不产清单（R2 钉：放宽 ⇒ 红）", () => {
    const doc = readFileSync(
      fileURLToPath(new URL("../../../docs/implementation/60-corrected-rules.md", import.meta.url)),
      "utf8",
    );
    console.log(`146 spec 锚 → 必不产=${doc.includes("必不产清单（不得放宽）")}；L2 触发=${doc.includes("提取绑定落地那一单")}`);
    expect(doc).toContain("`146` 裁定：L2 / L3 = **触发式登记**");
    expect(doc).toContain("**提取绑定落地那一单**"); // L2 触发条件
    expect(doc).toContain("**离线圈**"); // L3 触发时机
    expect(doc).toContain("必不产清单（不得放宽）"); // R2 锚点
    expect(doc).toContain("网络错误 / 超时 / 5xx / ACL 服务不可用 ⇒ **不产事件**");
  });
});
