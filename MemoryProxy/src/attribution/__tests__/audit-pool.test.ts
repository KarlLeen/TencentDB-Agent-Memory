/**
 * 110 · D6 落地：`suspect:text_overlap` 筛选类（**补 74 遗留的池判据独立单测**——本文件是
 * `src/attribution/__tests__/` 下首个池判据测试）。
 *
 * T1 达档 ⇒ 入池；T2 未达档 / 无影子 / 非 unconfirmed ⇒ **不入**（防"全部 unconfirmed 都被拉进池"）；
 * T3 只读：池构建不改 verdict / 不写 status / 行数不变（筛选不改判定）；
 * T4 同步（R3 机制化）：`70 spec §2.2` 表格类名 == `AUDIT_CATEGORIES` 的 suspect 子集 + 定义句"五类"，
 *    且路由对 `category` 的校验**使用同一常量**（防硬编码枚举漂移）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { getAttributionEventRepo } from "../../db/attributionEventRepo.js";
import { AUDIT_CATEGORIES, buildAuditPool, TEXT_OVERLAP_RUN_MIN } from "../audit-pool.js";
import {
  getAttributionJudgementDetailsRepo,
  type NewJudgementDetail,
} from "../judgement-details-repo.js";
import { getAttributionStatusEventsRepo } from "../status-events-repo.js";
import { teardownTempDb, withTempDb } from "./_helpers/base-harness.js";

afterEach(() => {
  teardownTempDb();
});

/** 造 unit 事件（让 session 进池的 sessions 列表）+ 一条判定行。 */
function seed(sessionKey: string, unitId: string, msgSeq: number, over: Partial<NewJudgementDetail>): void {
  getAttributionEventRepo().append({
    sessionKey,
    eventType: "decision_unit.created",
    unitId,
    turnSeq: 1,
    msgSeq,
    payload: { unitType: "code_change" },
  });
  getAttributionJudgementDetailsRepo().insertIdempotent({
    unitId,
    sessionKey,
    assetId: null,
    assetType: null,
    round: 1,
    verdict: "unconfirmed",
    evidenceSourceType: null,
    promptSha256: null,
    judgeImpl: "test:v1",
    detail: { rationaleRef: "mechanical:test" },
    ...over,
  });
}

/** 影子数组（`shadowBestContiguousRunChars` 为该类判据唯一读取字段）。 */
function shadow(runs: Array<number | "unknown">): { citationMetricsShadow: Array<Record<string, unknown>> } {
  return {
    citationMetricsShadow: runs.map((r, i) => ({ assetId: `a${i}`, shadowBestContiguousRunChars: r })),
  };
}

const hasTextOverlap = (unitId: string): boolean => {
  const pool = buildAuditPool();
  return pool.items.some((x) => x.unit_id === unitId && x.category === "suspect:text_overlap");
};

describe("110 · D6 落地：suspect:text_overlap（筛选信号，不判定）", () => {
  it("T1 达档（run = 8 与 48）⇒ 入池；命中集携带完整 categories", () => {
    withTempDb();
    seed("s-110", "u-at-8", 0, { detail: { rationaleRef: "mechanical:test", ...shadow([2, 8]) } });
    seed("s-110", "u-at-48", 1, { detail: { rationaleRef: "mechanical:test", ...shadow([48]) } });
    const pool = buildAuditPool();
    const item = pool.items.find((x) => x.unit_id === "u-at-8" && x.category === "suspect:text_overlap");
    expect(item, "run=8（= TEXT_OVERLAP_RUN_MIN 边界）应达档").toBeTruthy();
    expect(item!.verdict).toBe("unconfirmed"); // 筛选不改 verdict
    expect(item!.categories).toContain("suspect:text_overlap");
    expect(hasTextOverlap("u-at-48")).toBe(true);
    expect(TEXT_OVERLAP_RUN_MIN).toBe(8); // 默认档写死（109 依据）
  });

  it("T2 未达档（run = 7）/ 无影子 / 非数字 / 非 unconfirmed ⇒ 不入（防池膨胀）", () => {
    withTempDb();
    seed("s-110", "u-below", 0, { detail: { rationaleRef: "mechanical:test", ...shadow([7, 3]) } });
    seed("s-110", "u-noshadow", 1, { detail: { rationaleRef: "mechanical:test" } });
    seed("s-110", "u-unknown", 2, { detail: { rationaleRef: "mechanical:test", ...shadow(["unknown"]) } });
    seed("s-110", "u-confirmed", 3, {
      verdict: "confirmed",
      detail: { rationaleRef: "mechanical:test", ...shadow([292]) },
    });
    expect(hasTextOverlap("u-below"), "run=7 < 8").toBe(false);
    expect(hasTextOverlap("u-noshadow"), "无影子 ≠ 达档").toBe(false);
    expect(hasTextOverlap("u-unknown"), "非数字视作无依据").toBe(false);
    expect(hasTextOverlap("u-confirmed"), "筛选同受 unconfirmed 前提约束").toBe(false);
    // 反向（R4 机制化）：池里存在 unconfirmed 行，但都不是靠"所有 unconfirmed"进来的
    const pool = buildAuditPool();
    const overlapUnits = pool.items.filter((x) => x.category === "suspect:text_overlap").map((x) => x.unit_id);
    expect(overlapUnits).toEqual([]);
  });

  it("115 · C4③④：给定真实 space 能取到该 space 的条目；缺省 _default 不跨 space（不静默全量）", () => {
    withTempDb();
    seed("s-115", "u-sp-p0", 0, { spaceId: "sp-p0", detail: { rationaleRef: "mechanical:test" } });
    seed("s-115", "u-default", 1, { spaceId: "default", detail: { rationaleRef: "mechanical:test" } });
    const p0 = buildAuditPool({ spaceId: "sp-p0" });
    expect(p0.items.some((x) => x.unit_id === "u-sp-p0"), "给定 sp-p0 ⇒ 能取到").toBe(true);
    expect(p0.items.some((x) => x.unit_id === "u-default"), "不混入其它 space").toBe(false);
    const dflt = buildAuditPool(); // 缺省 _default
    expect(
      dflt.items.filter((x) => x.unit_id === "u-sp-p0" || x.unit_id === "u-default"),
      "缺省 _default ⇒ 两行都不匹配 ⇒ 空（**不是**返回全部 space 的数据）",
    ).toEqual([]);
  });

  it("T3 只读：池构建不改 verdict / 不写 status / 判定行不变（筛选不改判定）", () => {
    withTempDb();
    seed("s-110", "u-readonly", 0, { detail: { rationaleRef: "mechanical:test", ...shadow([24]) } });
    const details = getAttributionJudgementDetailsRepo();
    const before = details.listByUnit("u-readonly").map((r) => ({ verdict: r.verdict, detail: r.detail_json }));
    buildAuditPool();
    const after = details.listByUnit("u-readonly").map((r) => ({ verdict: r.verdict, detail: r.detail_json }));
    expect(after).toEqual(before); // verdict + detail_json 逐字不变
    expect(details.count()).toBe(1); // 行数不变
    expect(getAttributionStatusEventsRepo().listBySession("s-110").length).toBe(0); // 零状态写入
  });

  it("T4 同步（R3 机制化）：70 spec §2.2 表格 == suspect 子集 + 定义句五类；路由用同一常量", () => {
    const doc = readFileSync(
      fileURLToPath(new URL("../../../docs/implementation/70-panel-read-and-audit-pool.md", import.meta.url)),
      "utf8",
    );
    const fromDoc = [
      ...new Set([...doc.matchAll(/^\|\s*`(suspect:[a-z_]+)`\s*\|/gm)].map((m) => m[1]!)),
    ].sort();
    const fromCode = AUDIT_CATEGORIES.filter((c) => c.startsWith("suspect:")).sort();
    expect(fromDoc, "70 spec §2.2 表格的 suspect 类清单必须与 AUDIT_CATEGORIES 一致").toEqual([...fromCode]);
    expect(doc).toContain("`suspect:*` 五类的并集"); // 定义句已同步（R3）
    const route = readFileSync(fileURLToPath(new URL("../../routes/attribution-read.ts", import.meta.url)), "utf8");
    expect(route).toContain("AUDIT_CATEGORIES"); // category 校验用同一常量
    expect(route).not.toMatch(/"suspect:/); // 不出现硬编码枚举
  });
});
