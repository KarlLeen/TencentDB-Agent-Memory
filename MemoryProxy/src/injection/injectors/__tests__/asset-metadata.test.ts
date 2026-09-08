/**
 * metadata.assets 单测（docs/implementation/15-injector-asset-metadata.md §4/§6）：
 *   - asset-refs 纯工具（joinLinesWithOffsets / spanOfLines / validateAssets）
 *   - Tier A：knowledge / profile / l1 的 spans 切片一致性与资产身份
 *   - Tier B：skill 的 identity-only
 *   - hook-cache 同款 JSON 整块序列化的 metadata roundtrip
 *
 * 注：三类 hook-cache repo 的实现都是 JSON.stringify(blocks) 整块存取，
 * 这里用同款 JSON roundtrip 断言 metadata（含新 assets）不丢失。
 */
import { describe, expect, it } from "vitest";
import {
  joinLinesWithOffsets,
  spanOfLines,
  validateAssets,
  type InjectedAssetRef,
} from "../asset-refs.js";
import { renderKnowledgeToolsBlockWithAssetSpans } from "../knowledge-tools-injector.js";
import type { KnowledgeItem } from "../../../knowledge/core-client.js";
import {
  MEMORY_TOOLS_GUIDE,
  renderProfileMemoryBlock,
  type AgentProfileBundle,
} from "../tdai-profile-memory-injector.js";
import type { FixedAssetCtx } from "../tdai-fixed-asset.js";
import { renderRecallBlock } from "../tdai-l1-recall-injector.js";
import { SkillInjector, wrapAvailableSkillsBlock } from "../skill-injector.js";
import type { CoreSkillClient } from "../../../skill/core-client.js";
import type { CoreSkillConfig } from "../../../types.js";

const selfCtx: FixedAssetCtx = {
  teamId: "team1",
  userId: "u1",
  agentId: "agtself",
  agentName: "Main",
  isSelf: true,
  memoryAssetId: "chat_memory-team1-agtself",
};
const importedCtx: FixedAssetCtx = {
  teamId: "team1",
  userId: "u1",
  agentId: "agtbob",
  agentName: "Bob",
  isSelf: false,
  memoryAssetId: "chat_memory-team1-agtbob",
};

describe("asset-refs 纯工具", () => {
  it("joinLinesWithOffsets 与 join('\\n') 字节一致且 offsets 正确", () => {
    const lines = ["a", "bc", "", "def\nghi"];
    const { content, offsets } = joinLinesWithOffsets(lines);
    expect(content).toBe(lines.join("\n"));
    expect(offsets).toHaveLength(lines.length);
    for (let i = 0; i < lines.length; i++) {
      expect(content.startsWith(lines[i], offsets[i])).toBe(true);
    }
    expect(joinLinesWithOffsets([]).content).toBe("");
  });

  it("spanOfLines 把行区间换算成 char 区间", () => {
    const lines = ["ab", "cde", "f"];
    const { content, offsets } = joinLinesWithOffsets(lines);
    expect(content).toBe("ab\ncde\nf");
    expect(content.slice(spanOfLines(offsets, lines, 0, 2).start)).toBe("ab\ncde\nf");
    const mid = spanOfLines(offsets, lines, 1, 1);
    expect(content.slice(mid.start, mid.end)).toBe("cde");
  });

  it("validateAssets 检出重复/越界/重叠/空切片", () => {
    const content = "0123456789";
    const ok: InjectedAssetRef[] = [
      { assetId: "a", assetType: "skill", spans: [{ start: 0, end: 3 }] },
      { assetId: "b", assetType: "llm_wiki", spans: [{ start: 4, end: 6 }, { start: 7, end: 10 }] },
    ];
    expect(validateAssets(content, ok)).toEqual([]);

    const dup: InjectedAssetRef[] = [
      { assetId: "a", assetType: "skill", spans: [{ start: 0, end: 2 }] },
      ...ok,
    ];
    expect(validateAssets(content, dup)).toContain("duplicate assetId: a");

    const outOfBounds: InjectedAssetRef[] = [
      { assetId: "a", assetType: "skill", spans: [{ start: 0, end: 99 }] },
    ];
    expect(validateAssets(content, outOfBounds).some((e) => e.includes("out of bounds"))).toBe(true);

    const overlap: InjectedAssetRef[] = [
      { assetId: "a", assetType: "skill", spans: [{ start: 0, end: 5 }] },
      { assetId: "b", assetType: "skill", spans: [{ start: 4, end: 7 }] },
    ];
    expect(validateAssets(content, overlap).some((e) => e.includes("overlapping spans"))).toBe(
      true,
    );

    const emptySpan: InjectedAssetRef[] = [
      { assetId: "a", assetType: "skill", spans: [{ start: 2, end: 2 }] },
    ];
    expect(validateAssets(content, emptySpan).some((e) => e.includes("empty span text"))).toBe(
      true,
    );
  });
});

describe("knowledge-tools：Tier A 元素 spans", () => {
  const wiki: KnowledgeItem = {
    knowledge_id: "wiki-1",
    type: "wiki",
    service_url: "https://wiki.example/refund",
    name: "退款政策",
    summary: "退款规则概述",
    team_id: "team1",
    user_id: "u1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  };
  const graph: KnowledgeItem = {
    knowledge_id: "repo-1",
    type: "code-graph",
    service_url: "https://graph.example/tc",
    name: "TC 代码库",
    summary: "N files, M symbols",
    team_id: "team1",
    user_id: "u1",
    repo_url: "https://host/org/repo",
    repo_slug: "org/repo",
    branch: "main",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  };
  const resources = [wiki, graph];
  const rendered = renderKnowledgeToolsBlockWithAssetSpans(resources, "svc");
  const result = rendered!;
  const assets: InjectedAssetRef[] = resources.map((r, i) => ({
    assetId: r.knowledge_id,
    assetType: (r.type === "wiki" ? "llm_wiki" : "code_graph") as "llm_wiki" | "code_graph",
    name: r.name,
    spans: [result.spans[i]],
  }));

  it("渲染文本框架不变，且 <knowledge> 元素只出现两次", () => {
    expect(result.content.startsWith("<knowledge_tools>")).toBe(true);
    expect(result.content.endsWith("</knowledge_tools>\n")).toBe(true);
    expect(result.content.split("<knowledge ").length - 1).toBe(resources.length);
  });

  it("spans 与元素一一对应：锚点 = 元素起点，切片含 id/name 且以 ' />' 收尾", () => {
    for (let i = 0; i < resources.length; i++) {
      const r = resources[i];
      const span = result.spans[i];
      const expectedStart = result.content.indexOf(`<knowledge type="${r.type}" id="${r.knowledge_id}"`);
      expect(span.start).toBe(expectedStart);
      const slice = result.content.slice(span.start, span.end);
      expect(slice.startsWith(`<knowledge type="${r.type}" id="${r.knowledge_id}"`)).toBe(true);
      expect(slice.endsWith(" />")).toBe(true);
      expect(slice).toContain(`name="${r.name}"`);
    }
  });

  it("assets 通过不变式校验（assetId 不重复 / spans 界内不重叠）", () => {
    expect(validateAssets(result.content, assets)).toEqual([]);
  });

  it("整块 JSON roundtrip 后 metadata.assets 不丢失（hook-cache 同款序列化）", () => {
    const block = {
      type: "text",
      content: result.content,
      metadata: {
        source: "knowledge-tools-injector",
        cacheKey: "knowledge-tools-injector:agent:test",
        assets,
      },
    };
    const back = JSON.parse(JSON.stringify(block));
    expect(back.metadata.assets).toEqual(assets);
    expect(back.metadata.cacheKey).toBe(block.metadata.cacheKey);
  });

  it("空资源 → null", () => {
    expect(renderKnowledgeToolsBlockWithAssetSpans([], "svc")).toBeNull();
  });
});

describe("profile：Tier A group spans + chat_memory 身份", () => {
  const quietCtx: FixedAssetCtx = {
    teamId: "team1",
    userId: "u1",
    agentId: "agtquiet",
    agentName: "Quiet",
    isSelf: false,
    memoryAssetId: "chat_memory-team1-agtquiet",
  };
  const bundles: AgentProfileBundle[] = [
    // self：L3 超过 6000 → truncated
    { ctx: selfCtx, l3: { content: "L".repeat(6005) }, l2Entries: [] },
    // imported：只有 L2
    { ctx: importedCtx, l3: null, l2Entries: [{ path: "/scene/order", summary: "支付流程" }] },
    // 空 group：不应产生 ref
    { ctx: quietCtx, l3: null, l2Entries: [] },
  ];
  const rendered = renderProfileMemoryBlock(bundles)!;

  it("空 group 不产生 ref；content 框架不变", () => {
    expect(rendered.content.startsWith("<tdai_profile_memory>")).toBe(true);
    expect(rendered.content.endsWith(MEMORY_TOOLS_GUIDE)).toBe(true);
    expect(rendered.assets).toHaveLength(2);
  });

  it("每个 group 的 span 覆盖 <agent>…</agent> 段，self 的 L3 截断打 truncated", () => {
    const selfRef = rendered.assets[0];
    expect(selfRef.assetId).toBe("chat_memory-team1-agtself");
    expect(selfRef.assetType).toBe("chat_memory");
    expect(selfRef.truncated).toBe(true);
    const selfSlice = rendered.content.slice(selfRef.spans![0].start, selfRef.spans![0].end);
    expect(selfSlice.startsWith("<agent name=")).toBe(true);
    expect(selfSlice).toContain('agent_id="agtself"');
    expect(selfSlice.endsWith("</agent>")).toBe(true);

    const impRef = rendered.assets[1];
    expect(impRef.assetId).toBe("chat_memory-team1-agtbob");
    expect(impRef.truncated).toBeUndefined();
    const impSlice = rendered.content.slice(impRef.spans![0].start, impRef.spans![0].end);
    expect(impSlice).toContain('agent_id="agtbob"');
    expect(impSlice).toContain("/scene/order");
    expect(impSlice.endsWith("</agent>")).toBe(true);
  });

  it("stats 与不变式", () => {
    expect(rendered.stats).toEqual({ l3Count: 1, l2IndexCount: 1 });
    expect(rendered.assets.length).toBe(2);
    expect(rendered.content.length).toBeGreaterThan(0);
    expect(validateAssets(rendered.content, rendered.assets)).toEqual([]);
  });

  it("全部为空 → null（调用方落 tools-only 块）", () => {
    const empty: AgentProfileBundle = { ctx: quietCtx, l3: null, l2Entries: [] };
    expect(renderProfileMemoryBlock([empty])).toBeNull();
  });
});

describe("l1-recall：Tier A 逐行 spans + 按贡献 agent 聚合", () => {
  const quietCtx: FixedAssetCtx = {
    teamId: "team1",
    userId: "u1",
    agentId: "agtquiet",
    agentName: "Quiet",
    isSelf: false,
    memoryAssetId: "chat_memory-team1-agtquiet",
  };
  const byAgent = new Map<string, FixedAssetCtx>([
    [selfCtx.agentId, selfCtx],
    [importedCtx.agentId, importedCtx],
    [quietCtx.agentId, quietCtx], // 被检索但 0 命中 → 不应出现在 assets
  ]);
  const items = [
    { id: "m1", type: "episodic", content: "alpha 事件", score: 0.9, fromAgentId: selfCtx.agentId },
    { id: "m2", type: "semantic", content: "beta 知识", score: 0.8, fromAgentId: selfCtx.agentId },
    { id: "m3", content: "gamma 记忆", score: 0.5, fromAgentId: importedCtx.agentId, fromAgentName: "Bob" },
  ];
  const rendered = renderRecallBlock(items, selfCtx.agentId, byAgent)!;

  it("同一 agent 多条命中合并为一条 ref + 多段 spans", () => {
    expect(rendered.assets).toHaveLength(2);
    expect(rendered.assets[0].assetId).toBe("chat_memory-team1-agtself");
    expect(rendered.assets[0].spans).toHaveLength(2);
    expect(rendered.assets[1].assetId).toBe("chat_memory-team1-agtbob");
    expect(rendered.assets[1].spans).toHaveLength(1);
  });

  it("0 命中的 agent 不进入 assets（sources 语义保留在其调用方）", () => {
    expect(rendered.assets.some((a) => a.assetId === "chat_memory-team1-agtquiet")).toBe(false);
  });

  it("行格式不变，每条 span 切片含对应命中内容", () => {
    expect(rendered.content.startsWith("<tdai_recalled_l1_memories>")).toBe(true);
    expect(rendered.content.endsWith("</tdai_recalled_l1_memories>")).toBe(true);
    expect(rendered.content).toContain("1. [episodic] [self score=0.900] alpha 事件");
    expect(rendered.content).toContain("3. [memory] [from Bob score=0.500] gamma 记忆");

    const selfRef = rendered.assets[0];
    const slices = selfRef.spans!.map((s) => rendered.content.slice(s.start, s.end));
    expect(slices.join("\n")).toContain("alpha 事件");
    expect(slices.join("\n")).toContain("beta 知识");
  });

  it("不变式 + 空 items → null", () => {
    expect(validateAssets(rendered.content, rendered.assets)).toEqual([]);
    expect(renderRecallBlock([], selfCtx.agentId, byAgent)).toBeNull();
  });
});

describe("skill：Tier B identity-only", () => {
  const hits = [
    { skill_id: "skill-deploy", version: 3, name: "部署规范" },
    { skill_id: "skill-review", version: 1, name: "评审检查单" },
  ];
  const listing = "skill-deploy — 部署规范\nskill-review — 评审检查单";

  const clientOverride = {
    listListing: async () => ({ mode: "full" as const, hits, listing }),
  } as unknown as CoreSkillClient;

  const inj = new SkillInjector(
    {
      coreSkill: {
        endpoint: "http://127.0.0.1:1",
        serviceToken: "t",
        serviceId: "s",
        timeoutMs: 1000,
      } as CoreSkillConfig,
    },
    clientOverride,
  );

  it("assets = hits 的身份（assetId/type/name/version），content 与 wrap 一致", async () => {
    const list = await inj.execute({
      metadata: {
        custom: {
          session: { team_id: "team1", agent_id: "agtself" },
        },
      },
    } as never);
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe(wrapAvailableSkillsBlock(listing));
    const md = list[0].metadata as Record<string, unknown>;
    expect(md.skillCount).toBe(2);
    expect(md.mode).toBe("full");
    expect(md.assets).toEqual([
      { assetId: "skill-deploy", assetType: "skill", name: "部署规范", version: 3 },
      { assetId: "skill-review", assetType: "skill", name: "评审检查单", version: 1 },
    ]);
  });
});
