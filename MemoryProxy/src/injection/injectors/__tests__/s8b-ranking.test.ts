/**
 * 98 · S8-b 测试：候选索引行**加列** + 截断后**稳定精排** + 开关（合成数据）。
 *
 * 契约（98 §2）：
 *  - C1 索引行只加列：`asset_id`（= 行内已有 path）显式在列；信用分 `null` **不得**渲染成数字；
 *  - C2 精排（D4）：**截断之后**（候选集不变——本渲染不引入新截断，只在既有集合内重排）、
 *    信用分降序、**同分/null 保持原序（稳定）**；不与相关性加权相加；
 *  - C3 标黄：成对给**检测时间**、不得渲染为"当前版本"（60 spec §5 三条硬约束）；
 *  - C4 开关关 = **逐字节现状**（缺省路径不传 ranking；既有 render-golden.test.ts 守字节）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildConfig } from "../../../config.js";
import {
  renderProfileMemoryBlock,
  type AgentProfileBundle,
  type L2RankingData,
} from "../tdai-profile-memory-injector.js";

const CTX = {
  teamId: "t1",
  userId: "u1",
  agentId: "ag1",
  agentName: "Main",
  isSelf: true,
  memoryAssetId: "chat_memory-t1-ag1",
};

function bundle(entries: Array<{ path: string; summary?: string }>): AgentProfileBundle {
  return { ctx: CTX, l3: null, l2Entries: entries };
}

function ranking(
  credits: Record<string, number | null>,
  corrected: Record<string, number> = {},
): L2RankingData {
  return {
    creditByPath: new Map(Object.entries(credits)),
    correctedAtByPath: new Map(Object.entries(corrected)),
  };
}

function l2Lines(content: string): string[] {
  return content.split("\n").filter((l) => l.startsWith("- `"));
}

describe("98 · S8-b 索引行 + 精排", () => {
  it("T1 加列：信用分与标黄（成对检测时间）追加在既有文本之后；无'当前版本'", () => {
    const groups = [bundle([{ path: "p/one", summary: "s1" }, { path: "p/two" }])];
    const r = renderProfileMemoryBlock(
      groups,
      ranking({ "p/one": 0.833, "p/two": null }, { "p/one": 1_700_000_000_000 }),
    )!;
    const lines = l2Lines(r.content);
    // 既有部分逐字保留 + 追加列
    expect(lines[0]).toBe(
      "- `p/one` — s1 [credit=0.833, ⚠️ 可能已过期（检测时间: 2023-11-14T22:13:20.000Z）]",
    );
    // 无数据行：既有文本原样（path 显式在列）
    expect(lines[1]).toBe("- `p/two`");
    // ① 不得渲染为"当前版本"
    expect(r.content).not.toContain("当前版本");
    // ② 标黄成对（检测时间与告警同现）
    expect(r.content).toContain("可能已过期（检测时间: 2023-11-14T22:13:20.000Z）");
  });

  it("T2 精排（截断之后）：信用分降序、null 原位不动、候选集不变", () => {
    const entries = [
      { path: "a", summary: "sa" },
      { path: "b", summary: "sb" },
      { path: "c", summary: "sc" },
    ];
    const r = renderProfileMemoryBlock([bundle(entries)], ranking({ a: 0.2, b: null, c: 0.9 }))!;
    const order = l2Lines(r.content).map((l) => l.match(/`([^`]+)`/)![1]);
    // 非 null 位 {0,2} 降序填 [c,a]；null 的 b 原位（索引 1）不动
    expect(order).toEqual(["c", "b", "a"]);
    // 候选集不变（顺序之外，集合相等）
    expect([...order].sort()).toEqual(["a", "b", "c"]);
    // 无 ranking ⇒ 原序（缺省路径）
    const raw = renderProfileMemoryBlock([bundle(entries)])!;
    expect(l2Lines(raw.content).map((l) => l.match(/`([^`]+)`/)![1])).toEqual(["a", "b", "c"]);
  });

  it("T3 空 ranking（无任何数据）⇒ 与无 ranking 逐字节相同", () => {
    const groups = [bundle([{ path: "p/x", summary: "sx" }, { path: "p/y" }])];
    const withEmpty = renderProfileMemoryBlock(groups, ranking({}))!;
    const without = renderProfileMemoryBlock(groups)!;
    expect(withEmpty.content).toBe(without.content);
  });

  it("T4 R5 钉：credit=null 不渲染（不得出现 credit=0 或数字 0）", () => {
    const r = renderProfileMemoryBlock([bundle([{ path: "p/n" }])], ranking({ "p/n": null }))!;
    expect(r.content).not.toContain("credit=");
    expect(l2Lines(r.content)[0]).toBe("- `p/n`");
  });

  it("T5 开关：缺省 false；yaml 显式 true 才生效（同 enqueue 口径）", () => {
    expect(buildConfig({}).attribution!.ranking!.enabled).toBe(false);
    const tmp = path.join(os.tmpdir(), `s8b-${Date.now()}.yaml`);
    fs.writeFileSync(tmp, "attribution:\n  ranking:\n    enabled: true\n", "utf8");
    try {
      expect(buildConfig({ configFile: tmp }).attribution!.ranking!.enabled).toBe(true);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("T6 稳定性：同分保持原序（稳定排序）", () => {
    const entries = [{ path: "a" }, { path: "b" }, { path: "c" }];
    const r = renderProfileMemoryBlock([bundle(entries)], ranking({ a: 0.5, b: 0.5, c: 0.5 }))!;
    const order = l2Lines(r.content).map((l) => l.match(/`([^`]+)`/)![1]);
    expect(order).toEqual(["a", "b", "c"]);
  });
});
