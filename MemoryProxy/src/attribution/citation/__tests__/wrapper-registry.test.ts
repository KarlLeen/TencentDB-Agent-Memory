/**
 * c-2 单测（design §4.8.3 / §5 T18、T19、T20、T27）。
 *
 * 装置选择：直接吃 **render-golden 四 case 的真实渲染串**（F24）—— 不是"我编一个像包装的串"。
 * 于是本文件与既有 `render-golden.test.ts` 形成**联动门禁**（F30）：
 *   渲染器改了形态 ⇒ `render-golden.test.ts` 先红（要求刷新快照）；
 *   刷新后若新形态落不进模板表 ⇒ T27 的**认领账**对不上 ⇒ 本文件红（这是有意的）。
 *
 * 四张账：
 *   T18 删字节审计 —— `removed[]` 每段都必须被表内某条模板**整段认领**（无认领 = 不剥）。
 *   T19 幂等 + 净除 —— `strip(strip(x)) === strip(x)`；剥离后块标签/列表前缀不再出现。
 *   T20 反例（R8）—— "像包装但不是包装"的正文一律原样保留（防过度剥离）。
 *   T27 表覆盖账 —— 每个 case 用到了哪些模板（= 表是否还与渲染器对得上）。
 */

import { describe, expect, it } from "vitest";

import { GOLDEN_CASE_IDS, renderGoldenCase } from "../../../injection/injectors/__tests__/render-golden-cases.js";
import {
  DEFAULT_WRAPPER_REGISTRY,
  type RemovedSpan,
  type WrapperRegistry,
  stripRenderWrappers,
} from "../wrapper-registry.js";

const registryById = new Map(DEFAULT_WRAPPER_REGISTRY.templates.map((t) => [t.templateId, t]));

function golden(id: string): string {
  const rendered = renderGoldenCase(id);
  expect(rendered, `renderGoldenCase(${id}) 返回 null`).not.toBeNull();
  return rendered!.content;
}

/**
 * 四 case 的**认领账**（T27）：每行 = 该 case 里被识别出的包装由哪些模板认领 + 总删除段数。
 * 数字是人手核过真实渲染串得出的（knowledge 2 标签 + 2 自闭合标记；profile 6 对标签；
 * l1 1 对标签 + 3 条前缀；skill 1 条段首标题）。**数字变化 = 渲染器形态或模板表变了**，
 * 必须显式复核后更新此表（不许默默改）。
 */
const LEDGER: Record<string, { templateIds: string[]; removedCount: number }> = {
  "knowledge:wiki+graph+telemetry": {
    templateIds: ["block-tag:knowledge_tools", "marker-tag:knowledge-self-closing"],
    removedCount: 4,
  },
  "profile:self-l3cut+imported-l2": {
    templateIds: [
      "block-tag:tdai_profile_memory",
      "block-tag:agent",
      "block-tag:l3_core_memory",
      "block-tag:l2_scene_index",
      "block-tag:memory-tools-guide",
    ],
    removedCount: 12,
  },
  "l1:self-two+imported-one": {
    templateIds: ["block-tag:tdai_recalled_l1_memories", "list-prefix:l1-memory-item"],
    removedCount: 5,
  },
  "skill:wrap-listing": {
    templateIds: ["list-prefix:skills-heading"],
    removedCount: 1,
  },
};

describe("T18 删字节审计：removed[] 每段都由表内模板整段认领", () => {
  for (const id of GOLDEN_CASE_IDS) {
    it(`真实 golden 串 · 无未认领删除: ${id}`, () => {
      const content = golden(id);
      const { text, removed } = stripRenderWrappers(content);

      // 1) 每段：模板必须在表内，且 claims(raw) 成立（整段认领，不是"含一下"）
      for (const span of removed) {
        const template = registryById.get(span.templateId);
        expect(template, `removed 段引用了表外模板 ${span.templateId}`).toBeDefined();
        const raw = content.slice(span.rawStart, span.rawEnd);
        expect(template!.claims(raw), `模板 ${span.templateId} 不认领其声称删除的字节: ${JSON.stringify(raw)}`).toBe(
          true,
        );
      }

      // 2) 账必须自洽：非空、偏移有序、互不重叠、确实变短
      expect(removed.length).toBeGreaterThan(0);
      for (let i = 1; i < removed.length; i += 1) {
        expect(removed[i]!.rawStart).toBeGreaterThanOrEqual(removed[i - 1]!.rawEnd);
      }
      expect(text.length).toBe(content.length - removed.reduce((n, s) => n + (s.rawEnd - s.rawStart), 0));

      // 3) 硬约束：远端拼接必须与原串逐字节一致（删除账不能只是"记账"）
      let rebuilt = "";
      let prev = 0;
      for (const span of removed) {
        rebuilt += content.slice(prev, span.rawStart);
        prev = span.rawEnd;
      }
      rebuilt += content.slice(prev);
      expect(rebuilt).toBe(text);
    });
  }
});

describe("T27 表覆盖账：四 case 用到的模板集合 == 台账（防渲染器改形态而表不知情）", () => {
  for (const id of GOLDEN_CASE_IDS) {
    it(`模板覆盖与删除段数: ${id}`, () => {
      const expected = LEDGER[id];
      expect(expected, `台账缺 ${id}`).toBeDefined();
      const { removed } = stripRenderWrappers(golden(id));
      const used = [...new Set(removed.map((s) => s.templateId))].sort();
      expect(used).toEqual([...expected!.templateIds].sort());
      expect(removed.length).toBe(expected!.removedCount);
    });
  }
});

describe("T19 剥离幂等 + 真包装净除", () => {
  for (const id of GOLDEN_CASE_IDS) {
    it(`strip(strip(x)) === strip(x) 且二次 removed 为空: ${id}`, () => {
      const once = stripRenderWrappers(golden(id));
      const twice = stripRenderWrappers(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.removed).toEqual([]);
    });
  }

  it("四 case 剥离后不再出现块标签 / L1 前缀 / skills 段首标题", () => {
    const knowledge = stripRenderWrappers(golden("knowledge:wiki+graph+telemetry")).text;
    expect(knowledge).not.toContain("<knowledge_tools>");
    expect(knowledge).not.toContain("</knowledge_tools>");
    expect(knowledge).not.toContain("wiki-1"); // 自闭合标记整体删除（含属性）
    expect(knowledge).toContain("## code-graph：何时调"); // 正文保留

    const profile = stripRenderWrappers(golden("profile:self-l3cut+imported-l2")).text;
    for (const tag of [
      "<tdai_profile_memory>",
      "</tdai_profile_memory>",
      "<memory-tools-guide>",
      "</memory-tools-guide>",
      "<l2_scene_index>",
      "</l2_scene_index>",
    ]) {
      expect(profile, `剥离后仍含 ${tag}`).not.toContain(tag);
    }
    expect(profile).not.toContain("<agent ");
    expect(profile).not.toContain("</agent>");
    expect(profile).toContain("- `/scene/order` — 支付流程"); // 正文保留

    const l1 = stripRenderWrappers(golden("l1:self-two+imported-one")).text;
    expect(l1).not.toContain("<tdai_recalled_l1_memories>");
    expect(l1).not.toContain("</tdai_recalled_l1_memories>");
    expect(l1).not.toContain("1. [episodic]");
    expect(l1).toContain("alpha 事件"); // 正文保留

    const skill = stripRenderWrappers(golden("skill:wrap-listing")).text;
    expect(skill.startsWith("## Skills (mandatory)")).toBe(false);
    expect(skill).toContain("Before replying, scan the skills below."); // 正文保留
  });
});

describe("T20 反例（R8）：像包装但不是包装 ⇒ 一律原样保留", () => {
  it("R8-a 未成对标签不剥：正文里的字面量 </knowledge_tools> / 单边 <l3_core_memory>", () => {
    const lone = "正文含 </knowledge_tools> 字面量，且这里只有一个 <l3_core_memory> 开标签。";
    const res = stripRenderWrappers(lone);
    expect(res.removed).toEqual([]);
    expect(res.text).toBe(lone);
  });

  it("R8-a 就近成对：2 个开 1 个闭 ⇒ 只剥真成对的那一对，散文里的那个开标签保留", () => {
    const text = "<l3_core_memory>真段</l3_core_memory>\n散文里又提了一次 <l3_core_memory> 这个词";
    const res = stripRenderWrappers(text);
    expect(res.removed.map((s) => s.templateId)).toEqual([
      "block-tag:l3_core_memory",
      "block-tag:l3_core_memory",
    ]);
    expect(res.text).toBe("真段\n散文里又提了一次 <l3_core_memory> 这个词");
  });

  it("R8-b 列表前缀要有块上下文：资产正文首行 `1. something` 原样保留", () => {
    const text = "1. something\n2. another";
    const res = stripRenderWrappers(text);
    expect(res.removed).toEqual([]);
    expect(res.text).toBe(text);
  });

  it("R8-b 反向：同一形状在 L1 块上下文内 ⇒ 剥（证明上面的『不剥』是上下文判的，不是形状判的）", () => {
    const text = "<tdai_recalled_l1_memories>\n1. [episodic] [self score=0.900] alpha\n</tdai_recalled_l1_memories>";
    const res = stripRenderWrappers(text);
    expect(res.removed.some((s) => s.templateId === "list-prefix:l1-memory-item")).toBe(true);
    expect(res.text).toContain("alpha");
    expect(res.text).not.toContain("1. [episodic]");
  });

  it("R8-c 缝胶只认文本边界：文档中间的 \\n\\n 不剥（无法证明是 handler 加的）", () => {
    const text = "<knowledge_tools>a</knowledge_tools>\n\n<memory-tools-guide>b</memory-tools-guide>";
    const res = stripRenderWrappers(text);
    expect(res.text).toBe("a\n\nb"); // 中间胶水保留
    expect(res.removed.some((s) => s.templateId.startsWith("seam-glue"))).toBe(false);
  });

  it("R8-c 正向：文首紧贴最外层标签前的胶水剥掉（被排除前缀与归档块之间的接缝）", () => {
    const text = "PRE\n\n<knowledge_tools>\nx\n</knowledge_tools>";
    const res = stripRenderWrappers(text);
    expect(res.removed.some((s) => s.templateId === "seam-glue:leading")).toBe(true);
    expect(res.text).toBe("PRE\nx\n");
  });

  it("R8-c 正向：文末紧贴最外层标签后的胶水剥掉", () => {
    const text = "<knowledge_tools>\nx\n</knowledge_tools>\n\n";
    const res = stripRenderWrappers(text);
    expect(res.removed.some((s) => s.templateId === "seam-glue:trailing")).toBe(true);
    expect(res.text).toBe("\nx\n");
  });

  it("R8-d 不认识的标签一律不动（<url> / <知识id> / <tdai_memory_tools> / <skill_tools>）", () => {
    const text = "见 <url>/tools/list 与 -d '{\"knowledge_id\":\"<知识id>\"}'，以及 <skill_tools> 块。";
    const res = stripRenderWrappers(text);
    expect(res.removed).toEqual([]);
    expect(res.text).toBe(text);
  });

  it("R8 兜底：<knowledge 开头但缺 type=/id= 的散文不算自闭合标记", () => {
    const text = "我们内部叫 <knowledge 概念>，不是资产标记。";
    const res = stripRenderWrappers(text);
    expect(res.removed).toEqual([]);
    expect(res.text).toBe(text);
  });
});

describe("c-2 审计闸：registry 是**真实约束**，不是装饰参数", () => {
  it("空表 ⇒ 一个字节都不剥（无可认领 = 不算剥离）", () => {
    const empty: WrapperRegistry = { templates: [] };
    const text = "<knowledge_tools>\n1. [episodic] [self score=0.900] x\n</knowledge_tools>\n";
    const res = stripRenderWrappers(text, empty);
    expect(res.removed).toEqual([]);
    expect(res.text).toBe(text);
  });

  it("表里只有一半模板 ⇒ 只剥被认领的那一半（约束按条生效，不是全局开关）", () => {
    const partial: WrapperRegistry = {
      templates: DEFAULT_WRAPPER_REGISTRY.templates.filter((t) => t.templateId === "block-tag:knowledge_tools"),
    };
    const text =
      "<knowledge_tools>x</knowledge_tools>\n<tdai_recalled_l1_memories>\n1. [episodic] [self score=0.900] alpha\n</tdai_recalled_l1_memories>";
    const res = stripRenderWrappers(text, partial);
    // knowledge 成对标签被剥（表内有）
    expect(res.removed.map((s) => s.templateId)).toEqual(["block-tag:knowledge_tools", "block-tag:knowledge_tools"]);
    // L1 标签与其前缀都无人认领 ⇒ 原样保留（形状明明被扫描到了，是"表里没有"才没删）
    expect(res.text).toContain("<tdai_recalled_l1_memories>");
    expect(res.text).toContain("</tdai_recalled_l1_memories>");
    expect(res.text).toContain("1. [episodic]");
  });

  it("claims 必须**整段**成立：声称的模板若只是『含一下』该形状，不算认领", () => {
    const knowledgeTemplate = registryById.get("block-tag:knowledge_tools")!;
    expect(knowledgeTemplate.claims("<knowledge_tools>")).toBe(true);
    expect(knowledgeTemplate.claims("</knowledge_tools>")).toBe(true);
    expect(knowledgeTemplate.claims("前缀 <knowledge_tools> 后缀")).toBe(false);
    expect(knowledgeTemplate.claims("<knowledge_tools")).toBe(false);
  });

  it("空输入 / 无包装输入：不抛、removed 为空、文本不变", () => {
    expect(stripRenderWrappers("")).toEqual({ text: "", removed: [] });
    const plain: string = "no wrappers here";
    expect(stripRenderWrappers(plain)).toEqual({ text: plain, removed: [] });
  });

  it("removed 类型形状：只带 rawStart/rawEnd/templateId（审计账里没有自由文本）", () => {
    const { removed } = stripRenderWrappers("<knowledge_tools>\nx\n</knowledge_tools>");
    for (const span of removed as RemovedSpan[]) {
      expect(Object.keys(span).sort()).toEqual(["rawEnd", "rawStart", "templateId"]);
    }
  });
});
