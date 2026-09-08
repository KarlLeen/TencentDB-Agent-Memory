/**
 * loopx 真实资产冒烟（S0 §6/§7 的离线形态）。
 *
 * 数据源：本机 Memory Hub 静态导出 `/Users/karl4chill/dev/TC/memory-assets-export`
 * （Demo Team 下 Loopx engineer / Code Fixer 两个真实 agent 的 L1/L2/L3/skills/wiki）。
 * 该目录是私有工作历史，明确不进 git —— 本测试**运行时读取**真实文件，不把内容拷进 repo。
 *
 * 定位：验证「真实长度的 L3 / 真实批量 L1 / 真实 skill 身份 / 真实 wiki」过四个
 * 产资产渲染函数后，§4.5 切片一致性 / 身份 / 不变式仍然成立（纯合成短样本覆盖不到
 * 的地方，如 113KB L1 文件、真实 skill_id/version 形态）。
 *
 * 目录或 env `TDAI_MEMORY_ASSETS_EXPORT` 指向不存在时整体 skip（CI 安全）。
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  validateAssets,
  type InjectedAssetRef,
} from "../asset-refs.js";
import {
  renderKnowledgeToolsBlockWithAssetSpans,
} from "../knowledge-tools-injector.js";
import type { KnowledgeItem } from "../../../knowledge/core-client.js";
import {
  MEMORY_TOOLS_GUIDE,
  renderProfileMemoryBlock,
  stripSceneNavigation,
  type AgentProfileBundle,
} from "../tdai-profile-memory-injector.js";
import type { FixedAssetCtx } from "../tdai-fixed-asset.js";
import {
  renderRecallBlock,
  type L1RecallItem,
} from "../tdai-l1-recall-injector.js";
import { SkillInjector, wrapAvailableSkillsBlock } from "../skill-injector.js";
import type { CoreSkillClient } from "../../../skill/core-client.js";
import type { CoreSkillConfig } from "../../../types.js";

const ASSETS_EXPORT =
  process.env.TDAI_MEMORY_ASSETS_EXPORT ??
  // 本文件: MemoryProxy/src/injection/injectors/__tests__/ → 上溯 6 级到 dev/TC
  new URL("../../../../../../memory-assets-export", import.meta.url).pathname;

const LOOPX_L1 = resolve(ASSETS_EXPORT, "memory/L1-memories-loopx-engineer.md");
const CODE_FIXER_L1 = resolve(ASSETS_EXPORT, "memory/L1-memories-code-fixer.md");
const LOOPX_L2 = resolve(ASSETS_EXPORT, "memory/L2-scenarios-loopx-engineer.md");
const CODE_FIXER_L2 = resolve(ASSETS_EXPORT, "memory/L2-scenarios-code-fixer.md");
const LOOPX_L3 = resolve(ASSETS_EXPORT, "memory/L3-persona-loopx-engineer.md");
const CODE_FIXER_L3 = resolve(ASSETS_EXPORT, "memory/L3-persona-code-fixer.md");
const WIKI_INDEX = resolve(ASSETS_EXPORT, "knowledge/wiki-page-index.md");
const SKILLS_DIR = resolve(ASSETS_EXPORT, "skills");

const hasRealAssets = existsSync(LOOPX_L1) && existsSync(CODE_FIXER_L1);

// ── 导出文件解析（只取本测试需要的结构化字段）────────────────────────────

interface L1Row {
  type: string;
  id: string;
  content: string;
}

function parseL1(path: string): L1Row[] {
  const rows: L1Row[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^-\s*\*\*\[([^\]]+)\]\*\*\s*\(([^)]*id=([^)]+))\)\s*(.*)$/.exec(line);
    if (!m) continue;
    rows.push({ type: m[1], id: m[3].trim(), content: m[4].trim() });
  }
  return rows;
}

interface L2Entry {
  path: string;
  summary: string;
}

/** 每个 `## <title>.md` 段落 → { path: "/<title>", summary: <meta summary> }。 */
function parseL2Scenarios(path: string): L2Entry[] {
  const text = readFileSync(path, "utf8");
  const entries: L2Entry[] = [];
  for (const section of text.split(/(?=^## )/m)) {
    const titleM = /^## (.+)\.md\s*$/m.exec(section);
    if (!titleM) continue;
    const summaryM = /^summary:\s*(.+)$/m.exec(section);
    entries.push({
      path: `/${titleM[1].trim()}`,
      summary: summaryM?.[1]?.trim() ?? "",
    });
  }
  return entries;
}

function readL3Persona(path: string): string {
  // 导出文件首行是 "# L3 画像 — <name>" 的导出头，persona 正文从其下开始。
  const text = readFileSync(path, "utf8");
  const body = text.replace(/^# L3 画像[^\n]*\n/, "").trim();
  return stripSceneNavigation(body).trim();
}

function chatMemoryAssetId(teamId: string, agentId: string): string {
  return `chat_memory-${teamId}-${agentId}`;
}

/** 真实 agent：Loopx engineer（owner_agent 在导出 skills 的 front-matter 里）。 */
function resolveRealOwnerAgent(): string {
  if (!existsSync(SKILLS_DIR)) return "agt-unknown";
  for (const file of readdirSync(SKILLS_DIR)) {
    if (!file.endsWith(".md")) continue;
    const m = /owner_agent:\s*(agt-[\w-]+)/.exec(readFileSync(resolve(SKILLS_DIR, file), "utf8"));
    if (m) return m[1];
  }
  return "agt-unknown";
}

const REAL_TEAM_ID = process.env.TDAI_TEAM_ID ?? "team-frdzo8670j"; // Demo Team（导出 README 记载）
const REAL_OWNER_AGENT = resolveRealOwnerAgent();

// ── 夹具 ctx ─────────────────────────────────────────────────────────────────

function selfCtx(agentId: string, agentName: string): FixedAssetCtx {
  return {
    teamId: REAL_TEAM_ID,
    userId: "u-demo",
    agentId,
    agentName,
    isSelf: true,
    memoryAssetId: chatMemoryAssetId(REAL_TEAM_ID, agentId),
  };
}

function importedCtx(agentId: string, agentName: string): FixedAssetCtx {
  return {
    teamId: REAL_TEAM_ID,
    userId: "u-demo",
    agentId,
    agentName,
    isSelf: false,
    memoryAssetId: chatMemoryAssetId(REAL_TEAM_ID, agentId),
  };
}

describe.skipIf(!hasRealAssets)("loopx 真实资产 → profile / l1 / knowledge / skill", () => {
  it("profile：真实 L3+L2（Loopx engineer self + Code Fixer imported）过渲染，spans 切片一致", () => {
    const loopxL3 = readL3Persona(LOOPX_L3);
    const codeFixerL3 = readL3Persona(CODE_FIXER_L3);
    const loopxL2 = parseL2Scenarios(LOOPX_L2);
    const codeFixerL2 = parseL2Scenarios(CODE_FIXER_L2);
    expect(loopxL3.length).toBeGreaterThan(0);
    expect(loopxL2.length).toBeGreaterThan(0);

    const bundles: AgentProfileBundle[] = [
      { ctx: selfCtx(REAL_OWNER_AGENT, "Loopx engineer"), l3: { content: loopxL3 }, l2Entries: loopxL2 },
      { ctx: importedCtx("agt-code-fixer", "Code Fixer"), l3: { content: codeFixerL3 }, l2Entries: codeFixerL2 },
      // 空 group：被检索但无资产 → 不产生 ref
      { ctx: importedCtx("agt-archiver", "Archiver"), l3: null, l2Entries: [] },
    ];

    const out = renderProfileMemoryBlock(bundles)!;
    expect(out.content.startsWith("<tdai_profile_memory>")).toBe(true);
    expect(out.content.endsWith(MEMORY_TOOLS_GUIDE)).toBe(true);
    expect(out.assets).toHaveLength(2);

    const selfRef = out.assets[0];
    expect(selfRef.assetId).toBe(chatMemoryAssetId(REAL_TEAM_ID, REAL_OWNER_AGENT));
    const selfSlice = out.content.slice(selfRef.spans![0].start, selfRef.spans![0].end);
    expect(selfSlice.startsWith("<agent name=")).toBe(true);
    expect(selfSlice.endsWith("</agent>")).toBe(true);
    // 真实 persona 特征锚点 + 真实 L2 索引路径
    expect(selfSlice).toContain("# User Narrative Profile");
    expect(selfSlice).toContain(`\`${loopxL2[0].path}\``);

    const impRef = out.assets[1];
    expect(impRef.assetId).toBe(chatMemoryAssetId(REAL_TEAM_ID, "agt-code-fixer"));
    const impSlice = out.content.slice(impRef.spans![0].start, impRef.spans![0].end);
    expect(impSlice.startsWith("<agent name=")).toBe(true);
    expect(impSlice.endsWith("</agent>")).toBe(true);

    // 真实 L3 均 < 6000 → 无截断；不变式通过
    expect(selfRef.truncated).toBeUndefined();
    expect(out.stats).toEqual({ l3Count: 2, l2IndexCount: loopxL2.length + codeFixerL2.length });
    expect(validateAssets(out.content, out.assets)).toEqual([]);
  });

  it("l1：真实 113KB L1 记忆条目过渲染，按贡献 agent 聚 ref、逐行 span 与命中行一致", () => {
    const selfRows = parseL1(LOOPX_L1);
    const impRows = parseL1(CODE_FIXER_L1);
    expect(selfRows.length).toBeGreaterThan(50); // loopx-engineer 296 条的真实规模
    expect(impRows.length).toBeGreaterThan(0);

    const self = selfCtx(REAL_OWNER_AGENT, "Loopx engineer");
    const imp = importedCtx("agt-code-fixer", "Code Fixer");
    const byAgent = new Map<string, FixedAssetCtx>([
      [self.agentId, self],
      [imp.agentId, imp],
      ["agt-archiver", importedCtx("agt-archiver", "Archiver")], // 0 命中
    ]);

    const items: L1RecallItem[] = [
      { id: selfRows[0].id, type: selfRows[0].type, content: selfRows[0].content, score: 0.92, fromAgentId: self.agentId },
      { id: impRows[0].id, type: impRows[0].type, content: impRows[0].content, score: 0.85, fromAgentId: imp.agentId, fromAgentName: "Code Fixer" },
      { id: selfRows[1].id, type: selfRows[1].type, content: selfRows[1].content, score: 0.8, fromAgentId: self.agentId },
      { id: selfRows[2].id, type: selfRows[2].type, content: selfRows[2].content, score: 0.7, fromAgentId: self.agentId },
      { id: impRows[1].id, type: impRows[1].type, content: impRows[1].content, score: 0.6, fromAgentId: imp.agentId, fromAgentName: "Code Fixer" },
    ];

    const out = renderRecallBlock(items, self.agentId, byAgent)!;
    expect(out.assets).toHaveLength(2); // archiver 0 命中不出现
    expect(out.assets.map((a) => a.assetId)).toEqual([
      chatMemoryAssetId(REAL_TEAM_ID, REAL_OWNER_AGENT),
      chatMemoryAssetId(REAL_TEAM_ID, "agt-code-fixer"),
    ]);
    expect(out.assets[0].spans).toHaveLength(3);
    expect(out.assets[1].spans).toHaveLength(2);

    // 命中行的真实内容出现在对应 span 切片
    const selfSlices = out.assets[0].spans!.map((s) => out.content.slice(s.start, s.end));
    expect(selfSlices.join("\n")).toContain(selfRows[0].content);
    expect(selfSlices.join("\n")).toContain(selfRows[2].content);
    const impSlices = out.assets[1].spans!.map((s) => out.content.slice(s.start, s.end));
    expect(impSlices.join("\n")).toContain(impRows[0].content);

    expect(validateAssets(out.content, out.assets)).toEqual([]);
    // 行格式保留真实条目原文，不被改写
    expect(out.content).toContain(`1. [${selfRows[0].type}] [self score=0.920] ${selfRows[0].content}`);
  });

  it("knowledge：真实 wiki 资产（wiki_id 来自导出）+ code-graph 过渲染，元素 span 含真实 id", () => {
    const wikiIndex = readFileSync(WIKI_INDEX, "utf8");
    const wikiId = /wiki_id:\s*(\S+)/.exec(wikiIndex)?.[1];
    expect(wikiId).toBeTruthy();

    const wiki: KnowledgeItem = {
      knowledge_id: wikiId!,
      type: "wiki",
      service_url: "http://knowledge-svc/wiki/" + wikiId,
      name: "loopx-computer-use-content-ops",
      summary: "loopx content-ops 领域 Wiki（88 页设计文档索引，来自真实导出）",
      team_id: REAL_TEAM_ID,
      user_id: "u-demo",
      created_at: "2026-09-03T00:00:00Z",
      updated_at: "2026-09-03T00:00:00Z",
    };
    // 真实 code-graph 资产 id 需从 meta list-accessible 回查；冒烟用导出可见的 repo 占位身份
    const graph: KnowledgeItem = {
      knowledge_id: "kg-huangruiteng-loopx",
      type: "code-graph",
      service_url: "http://knowledge-svc/graph/huangruiteng-loopx",
      name: "huangruiteng/loopx",
      summary: "prebuilt code index",
      team_id: REAL_TEAM_ID,
      user_id: "u-demo",
      repo_url: "https://github.com/huangruiteng/loopx",
      repo_slug: "huangruiteng/loopx",
      branch: "main",
      created_at: "2026-09-03T00:00:00Z",
      updated_at: "2026-09-03T00:00:00Z",
    };

    const rendered = renderKnowledgeToolsBlockWithAssetSpans([wiki, graph], "svc-demo")!;
    const assets: InjectedAssetRef[] = [
      { assetId: wiki.knowledge_id, assetType: "llm_wiki", name: wiki.name, spans: [rendered.spans[0]] },
      { assetId: graph.knowledge_id, assetType: "code_graph", name: graph.name, spans: [rendered.spans[1]] },
    ];
    expect(rendered.content).toContain(`id="${wikiId}"`);
    expect(rendered.content).toContain('match="huangruiteng/loopx"');
    for (const ref of assets) {
      const slice = rendered.content.slice(ref.spans![0].start, ref.spans![0].end);
      expect(slice).toContain(`id="${ref.assetId}"`);
      expect(slice.endsWith(" />")).toBe(true);
    }
    expect(validateAssets(rendered.content, assets)).toEqual([]);
  });

  it("skill：真实 skill_id/version/name（来自导出 front-matter）过 identity-only 清单", async () => {
    const files = readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(5);

    const hits: Array<{ skill_id: string; version: number; name: string }> = [];
    for (const f of files) {
      const head = readFileSync(resolve(SKILLS_DIR, f), "utf8");
      const m = /> skill_id:\s*(\S+).*?version:\s*(\d+)/.exec(head);
      if (!m) continue;
      const name = /^name:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? f.replace(/\.md$/, "");
      hits.push({ skill_id: m[1], version: Number(m[2]), name });
    }
    expect(hits.length).toBe(files.length); // 13 个导出 skill 全部带真实身份行
    const listing = hits.map((h) => `${h.name} — ${h.name}`).join("\n");

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

    const list = await inj.execute({
      metadata: {
        custom: {
          session: { team_id: REAL_TEAM_ID, agent_id: REAL_OWNER_AGENT },
        },
      },
    } as never);
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe(wrapAvailableSkillsBlock(listing));
    const md = list[0].metadata as Record<string, unknown>;
    expect(md.assets).toEqual(
      hits.map((h) => ({ assetId: h.skill_id, assetType: "skill", name: h.name, version: h.version })),
    );
  });
});
