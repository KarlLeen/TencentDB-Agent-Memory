/**
 * 105 · C5/C6 单测：资产级切片（计算层）。
 *
 * C5 防错切（合成夹具）：两块 × 各 2 资产（各带**独占标记串**）⇒
 *   ① 每资产切片必须是原块文本的子串；② A 的切片不含 B 的独占标记。
 * C6 不得回归：非 listing 形态 / 空块 ⇒ 返回 null（调用方回退块级，行为与 104 后一致）。
 */
import { describe, expect, it } from "vitest";

import { sliceAvailableSkillsItems } from "../asset-slices.js";

function listingBlock(items: string[]): string {
  return `铺垫散文。\n<available_skills>\n${items.map((x) => `- ${x}`).join("\n")}\n</available_skills>\n收尾散文。`;
}

describe("105 · C5 防错切（合成夹具：两块 × 各 2 资产）", () => {
  const blockA = listingBlock(["alpha-skl: ALPHA-MARK 的独占描述", "beta-skl: BETA-MARK 的独占描述"]);
  const blockB = listingBlock(["gamma-skl: GAMMA-MARK 的独占描述", "delta-skl: DELTA-MARK 的独占描述"]);

  it("① 每资产切片必须是原块文本的子串", () => {
    for (const s of sliceAvailableSkillsItems(blockA)!) expect(blockA.includes(s)).toBe(true);
    for (const s of sliceAvailableSkillsItems(blockB)!) expect(blockB.includes(s)).toBe(true);
  });

  it("② A 的切片不含 B 的独占标记（并且按出现序对齐）", () => {
    const [a1, a2] = sliceAvailableSkillsItems(blockA)!;
    expect(a1!.includes("ALPHA-MARK")).toBe(true);
    expect(a1!.includes("BETA-MARK")).toBe(false);
    expect(a2!.includes("BETA-MARK")).toBe(true);
    expect(a2!.includes("ALPHA-MARK")).toBe(false);
    // 跨块（blockB 的标记不出现在 blockA 的任何切片里）
    for (const s of sliceAvailableSkillsItems(blockA)!) {
      expect(s.includes("GAMMA-MARK")).toBe(false);
      expect(s.includes("DELTA-MARK")).toBe(false);
    }
  });
});

describe("105 · C6 不得回归（非 listing / 空块 ⇒ null，调用方回退块级）", () => {
  it("普通文本（无 available_skills 块）⇒ null", () => {
    expect(sliceAvailableSkillsItems("普通资产正文，无 listing 块。")).toBe(null);
  });

  it("空 listing（无条目）⇒ null", () => {
    expect(sliceAvailableSkillsItems("<available_skills>\n( none )\n</available_skills>")).toBe(null);
  });

  it("只有开标签、无闭标签 ⇒ null（不猜）", () => {
    expect(sliceAvailableSkillsItems("<available_skills>\n- a: b\n")).toBe(null);
  });
});
