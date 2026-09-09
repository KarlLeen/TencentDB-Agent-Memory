/**
 * R6 golden 字节回归 —— canonical cases（15-injector-asset-metadata.md §8 item 6 / §6 golden）。
 *
 * 只锁 **content 字节**：metadata.assets 是 S0 的合法增量（纯追加），不参与字节比对；
 * 比对对象 = 每个产资产 injector 的 content 组装路径（改文案/改换行/改 join 都会红）。
 *
 * 快照 `render-golden.snap.json` 由 `scripts/qa/record-render-golden.ts` 生成（与 corpus
 * 同理：输入固定、输出为 golden）。改 content 组装前：先跑 recorder 生成新快照、diff 看清
 * 改动面，再决定是否接受（通常应拒绝非文案变更 —— 它会让 spans/切片一致性漂移）。
 */
import type { InjectedAssetRef } from "../asset-refs.js";
import type { KnowledgeItem } from "../../../knowledge/core-client.js";
import { renderKnowledgeToolsBlockWithAssetSpans } from "../knowledge-tools-injector.js";
import { renderProfileMemoryBlock } from "../tdai-profile-memory-injector.js";
import type { AgentProfileBundle } from "../tdai-profile-memory-injector.js";
import type { FixedAssetCtx } from "../tdai-fixed-asset.js";
import { renderRecallBlock } from "../tdai-l1-recall-injector.js";
import { wrapAvailableSkillsBlock } from "../skill-injector.js";

export const GOLDEN_CASE_IDS = [
  "knowledge:wiki+graph+telemetry",
  "profile:self-l3cut+imported-l2",
  "l1:self-two+imported-one",
  "skill:wrap-listing",
] as const;
export type GoldenCaseId = (typeof GOLDEN_CASE_IDS)[number];

// ── 共享 ctx / fixture（与 asset-metadata.test.ts 同源形状，内容稳定） ────────────

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
const quietCtx: FixedAssetCtx = {
  teamId: "team1",
  userId: "u1",
  agentId: "agtquiet",
  agentName: "Quiet",
  isSelf: false,
  memoryAssetId: "chat_memory-team1-agtquiet",
};

/** 全部 golden case 的 content 渲染；未知 id 返回 null（test 里会 fail）。 */
export function renderGoldenCase(
  id: string,
): { content: string; assets: InjectedAssetRef[] } | null {
  switch (id) {
    case "knowledge:wiki+graph+telemetry":
      return renderKnowledgeCase();
    case "profile:self-l3cut+imported-l2":
      return renderProfileCase();
    case "l1:self-two+imported-one":
      return renderL1Case();
    case "skill:wrap-listing":
      return { content: wrapAvailableSkillsBlock(SKILL_LISTING), assets: [] };
    default:
      return null;
  }
}

// ── knowledge ──────────────────────────────────────────────────────────────────

function renderKnowledgeCase(): { content: string; assets: InjectedAssetRef[] } | null {
  const rendered = renderKnowledgeToolsBlockWithAssetSpans(KNOWLEDGE_RESOURCES, "svc", {
    sessionKey: "sess-1",
    userId: "user-1",
    teamId: "team-1",
    agentId: "agt-1",
    agentSource: "cli",
    spaceId: "sp-1",
  });
  if (!rendered) return null;
  const assets: InjectedAssetRef[] = KNOWLEDGE_RESOURCES.map((r, i) => ({
    assetId: r.knowledge_id,
    assetType: (r.type === "wiki" ? "llm_wiki" : "code_graph") as "llm_wiki" | "code_graph",
    name: r.name,
    spans: [rendered.spans[i]],
  }));
  return { content: rendered.content, assets };
}

const KNOWLEDGE_RESOURCES: KnowledgeItem[] = [
  {
    knowledge_id: "wiki-1",
    type: "wiki",
    service_url: "https://wiki.example/refund",
    name: "退款政策",
    summary: "退款规则概述",
    team_id: "team1",
    user_id: "u1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
  },
  {
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
  },
];

// ── profile ────────────────────────────────────────────────────────────────────

function renderProfileCase(): { content: string; assets: InjectedAssetRef[] } | null {
  const bundles: AgentProfileBundle[] = [
    // self：L3 超 6000 → 触发 truncate 尾部标记
    { ctx: selfCtx, l3: { content: "L".repeat(6005) }, l2Entries: [] },
    // imported：只有 L2 索引（一条带 summary、一条不带）
    {
      ctx: importedCtx,
      l3: null,
      l2Entries: [
        { path: "/scene/order", summary: "支付流程" },
        { path: "/scene/legacy" },
      ],
    },
    // 空 group：content 里不出现，也不产 ref
    { ctx: quietCtx, l3: null, l2Entries: [] },
  ];
  const rendered = renderProfileMemoryBlock(bundles);
  if (!rendered) return null;
  return { content: rendered.content, assets: rendered.assets };
}

// ── l1 recall ─────────────────────────────────────────────────────────────────

function renderL1Case(): { content: string; assets: InjectedAssetRef[] } | null {
  const byAgent = new Map<string, FixedAssetCtx>([
    [selfCtx.agentId, selfCtx],
    [importedCtx.agentId, importedCtx],
    [quietCtx.agentId, quietCtx], // 被检索但 0 命中 → 不产 ref
  ]);
  const items = [
    { id: "m1", type: "episodic", content: "alpha 事件", score: 0.9, fromAgentId: selfCtx.agentId },
    { id: "m2", type: "semantic", content: "beta 知识", score: 0.8, fromAgentId: selfCtx.agentId },
    {
      id: "m3",
      content: "gamma 记忆",
      score: 0.5,
      fromAgentId: importedCtx.agentId,
      fromAgentName: "Bob",
    },
  ];
  const rendered = renderRecallBlock(items, selfCtx.agentId, byAgent);
  if (!rendered) return null;
  return { content: rendered.content, assets: rendered.assets };
}

// ── skill（Tier B：listing 上游预渲染，wrap 逻辑字节锁定） ───────────────────────

const SKILL_LISTING = "skill-deploy — 部署规范\nskill-review — 评审检查单";
