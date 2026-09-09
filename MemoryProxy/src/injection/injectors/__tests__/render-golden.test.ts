/**
 * R6 golden 字节回归（15-injector-asset-metadata.md §8 item 6 / §6 golden）：
 * 四个产资产 injector 的 content 组装路径，逐字节 == committed 快照。
 *
 * - content 一动即红：改文案 / 改换行 / 改 join / 拼 span 时顺手改文本，全部被拦。
 * - metadata.assets 是 S0 合法增量，不在字节比对范围内（结构与切片一致性由
 *   asset-metadata.test.ts 守）。
 * - 快照刷新：`npm run record:render-golden`（先 diff 快照确认是有意的文案变更）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GOLDEN_CASE_IDS, renderGoldenCase } from "./render-golden-cases.js";
import { validateAssets } from "../asset-refs.js";

const snapshot: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("./render-golden.snap.json", import.meta.url)), "utf8"),
);

describe("R6 golden 字节回归（content 逐字节 == 快照）", () => {
  it("快照已生成（缺快照先跑 npm run record:render-golden）", () => {
    expect(Object.keys(snapshot).length).toBeGreaterThan(0);
  });

  for (const id of GOLDEN_CASE_IDS) {
    it(`content 逐字节一致: ${id}`, () => {
      const rendered = renderGoldenCase(id);
      expect(rendered, `renderGoldenCase(${id}) 返回 null`).not.toBeNull();
      const content = rendered!.content;
      expect(snapshot[id], `快照缺 ${id} —— 先跑 npm run record:render-golden`).toBeDefined();
      expect(content).toBe(snapshot[id]);
      expect(content.length).toBe(snapshot[id].length);
    });
  }
});

describe("R6 golden 附带不变式（assets 结构仍自洽）", () => {
  for (const id of GOLDEN_CASE_IDS) {
    it(`validateAssets 通过: ${id}`, () => {
      const rendered = renderGoldenCase(id);
      if (!rendered || rendered.assets.length === 0) return;
      expect(validateAssets(rendered.content, rendered.assets)).toEqual([]);
    });
  }
});
