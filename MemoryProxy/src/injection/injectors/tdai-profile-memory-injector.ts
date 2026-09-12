import type { AgentContext, AnchorTarget, CacheStrategy, ContextBlock, InjectionHook, HookPriority, PrewarmInput } from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { TdaiClient } from "../../tdai/client.js";
import type { TdaiMemoryConfig } from "../../tdai/types.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import type { CoreSkillConfig } from "../../types.js";
import { getMetadataClient } from "../../meta/client.js";
import { resolveFixedAssetCtxs, type FixedAssetCtx } from "./tdai-fixed-asset.js";
import { joinLinesWithOffsets, spanOfLines, type InjectedAssetRef } from "./asset-refs.js";
// 98 · S8-b：消费 S8-a 聚合层（97）——精排键与索引行信用列同源；零新 SQL（复用既有读口）。
import { rankByCredit, rollupCreditsByAsset } from "../../attribution/credit-score.js";
import {
  getAttributionStatusEventsRepo,
  STATUS_EVENT_TYPE_ASSET_CORRECTED,
} from "../../attribution/status-events-repo.js";

/**
 * L2/L3 注入（按 openclaw / hermes 官方做法重构）：
 *   - L3 (persona) → 注入完整内容（稳定且通常较短，作为长期画像）
 *   - L2 (scenarios) → **只注入 Scene Navigation 索引（路径列表 + summary）**，
 *     不预读全文。LLM 需要细节时主动调 `tdai_read_scene` 工具按 path 拉取。
 *   - 同时附 memory-tools-guide 文案，告诉 LLM 怎么用工具 + 调用上限。
 *
 * 这样可以：
 *   1. 大幅降低首轮 token 消耗（L2 全文经常上千 chars × N 个）
 *   2. 让 LLM 按需取文，而不是被无关的场景污染上下文
 *
 * 跨 agent："自有 + 借入"按 agent 分段；每段下面 L3 + Scene 索引并列。
 *
 * 控制面不可达时降级：仅注入当前 agent 的 L3 + Scene 索引。
 */
export class TdaiProfileMemoryInjector implements InjectionHook {
  id = "tdai-profile-memory-injector";
  point = "system.suffix" as const;
  anchor: AnchorTarget = { slot: "memory", relation: "inside_append" };
  priority: HookPriority = HOOK_PRIORITY.MEMORY + 10;
  description = "Inject TDAI L3 (persona) + L2 scene index (path-only, agent reads via tool)";
  /** L2/L3 profile snapshot is injected once after session registration, like skill listing. */
  cacheStrategy: CacheStrategy = "session_init";

  /**
   * @param baseConfig  starter TdaiClient config; per-request `serviceId` will
   *   be overridden with `session.space_id` in `renderBlocksForContext`. This
   *   config's `serviceId` acts as a fallback when no `space_id` is present.
   * @param coreSkillCfg  kernel gateway config for MetadataClient (fixed-asset
   *   agent resolution).
   */
  constructor(
    private baseConfig: TdaiMemoryConfig,
    private coreSkillCfg: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs"> | null = null,
    /**
     * 98 · S8-b：注入面排序开关（`attribution.ranking.enabled`，缺省 false）。
     * false（缺省）⇒ 渲染走既有路径、**逐字节现状**（render-golden 对照）、零库访问；
     * true ⇒ 索引行加列 + 截断之后按信用分稳定精排。
     */
    private rankingEnabled = false,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const caps = ctx.metadata.custom?.assetCapabilities as { chat_memory?: boolean } | undefined;
    if (caps?.chat_memory === false) return [];
    return this.renderBlocksForContext(ctx);
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    if (input.assetCapabilities?.chat_memory === false) return [];
    return this.renderBlocksForContext(createPrewarmAgentContext(input));
  }

  private async renderBlocksForContext(ctx: AgentContext): Promise<ContextBlock[]> {
    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];

    const session = (ctx.metadata.custom as any)?.session as { user_key?: string; space_id?: string } | undefined;
    const userKey = session?.user_key;
    // spaceId 来自 session 注册时保存的 URL path 中的 `/proxy/<spaceId>/...`；
    // 用作内核的 `x-tdai-service-id` 头做租户路由。空字符串会被内核拒绝（invalid_user_key）
    // —— caller 已在 session-init 阶段做 bypass 处理。
    const spaceId = session?.space_id ?? "";
    const mc = this.coreSkillCfg && userKey
      ? getMetadataClient(this.coreSkillCfg, spaceId, userKey)
      : null;
    const ctxs = await resolveFixedAssetCtxs(ctx, identity, mc);

    // Build a per-request TdaiClient with the correct tenant. Falls back to
    // baseConfig.serviceId (config value) when spaceId is empty.
    const client = new TdaiClient({
      ...this.baseConfig,
      serviceId: spaceId || this.baseConfig.serviceId,
    });

    // 对每个 agent 独立拉 L3 + L2 索引（不读 L2 全文）
    const groups = await Promise.all(ctxs.map((c) => loadAgentProfile(client, c)));

    // 全部为空 → 仍注入 tools-guide（LLM 可主动 search L1 / 读 L2）
    // 98 · S8-b：开关开才加载排序数据（关 ⇒ 零库访问、渲染逐字节现状）。
    const ranking = this.rankingEnabled ? loadL2Ranking(groups) : undefined;
    const rendered = renderProfileMemoryBlock(groups, ranking);
    if (!rendered) {
      return [{
        type: "text",
        content: MEMORY_TOOLS_GUIDE,
        metadata: { source: this.id, agentCount: 0, l3Count: 0, l2Count: 0, mode: "tools-only", assets: [] },
      }];
    }

    return [
      {
        type: "text",
        content: rendered.content,
        metadata: {
          source: this.id,
          agentCount: groups.length,
          l3Count: rendered.stats.l3Count,
          l2IndexCount: rendered.stats.l2IndexCount,
          mode: "index+tools",
          assets: rendered.assets,
        },
      },
    ];
  }
}

export interface ProfileMemoryRenderResult {
  /** `<tdai_profile_memory>` + memory-tools-guide 的完整渲染文本。 */
  content: string;
  /** metadata.assets：每个有内容的 group 一条 chat_memory 资产；spans 指向该 group 的 `<agent>…</agent>` 段。 */
  assets: InjectedAssetRef[];
  stats: { l3Count: number; l2IndexCount: number };
}

/**
 * 98 · S8-b：L2 索引行的排序/标黄数据（键 = 行级 asset_id，即 `e.path`）。
 * - `creditByPath`：来自 S8-a `rollupCreditsByAsset()`——缺席/`null` = 无数据 ⇒ **不渲染该列、不参与精排**（不许凑 0）；
 * - `correctedAtByPath`：`asset_corrected` 的**检测时间**（= 该行 `created_at`），渲染时**成对**给出（60 spec §5 ②）。
 */
export interface L2RankingData {
  creditByPath: ReadonlyMap<string, number | null>;
  correctedAtByPath: ReadonlyMap<string, number>;
}

/** 98 · S8-b：只读加载（仅开关开时调用；零新 SQL——信用分复用 97 rollup，标黄按 path 查既有读口）。 */
export function loadL2Ranking(groups: readonly AgentProfileBundle[]): L2RankingData {
  const creditByPath = new Map<string, number | null>(
    rollupCreditsByAsset().map((r) => [r.asset_id, r.credit]),
  );
  const correctedAtByPath = new Map<string, number>();
  const repo = getAttributionStatusEventsRepo();
  for (const g of groups) {
    for (const e of g.l2Entries) {
      if (correctedAtByPath.has(e.path)) continue;
      const rows = repo.listByAsset(e.path, { eventType: STATUS_EVENT_TYPE_ASSET_CORRECTED });
      if (rows.length > 0) correctedAtByPath.set(e.path, rows[rows.length - 1]!.created_at);
    }
  }
  return { creditByPath, correctedAtByPath };
}

/** 98 · S8-b：对已截断的 L2 候选做**稳定**精排（复用 S8-a 的 rankByCredit：非 null 降序、null 原位不动）。 */
function rankL2Entries<T extends { path: string }>(
  entries: readonly T[],
  creditByPath: ReadonlyMap<string, number | null>,
): T[] {
  return rankByCredit(entries.map((e) => ({ e, credit: creditByPath.get(e.path) ?? null }))).map(
    (w) => w.e,
  );
}

/**
 * 纯渲染：把已加载的 profile 组拼成块并计算 asset refs。
 * 全部为空返回 null（调用方落 tools-only 块，assets=[]）。
 * content 与重构前的 `lines.join("\n")` 逐字节一致（只加 offset 跟踪，不改文案/换行）；
 * **98 起**：`ranking` 缺省（开关关）⇒ 渲染路径与既有**逐字节一致**；传入才加列 + 精排。
 */
export function renderProfileMemoryBlock(
  groups: AgentProfileBundle[],
  ranking?: L2RankingData,
): ProfileMemoryRenderResult | null {
  const rendered = groups.filter((g) => g.l3 || g.l2Entries.length > 0);
  if (rendered.length === 0) return null;

  const lines: string[] = [
    "<tdai_profile_memory>",
    "以下是 TDAI 为当前 agent 维护的长期工作记忆（自有 + 借入分段；L2 仅给索引，按需用工具读全文）：",
  ];
  // 每个 group 在 lines 中的起止行 + L3 是否被截断
  const hints: Array<{ first: number; last: number; l3Cut: boolean }> = [];

  let l3Count = 0;
  let l2TotalCount = 0;
  for (const g of rendered) {
    const tag = g.ctx.isSelf ? "self" : "imported_from";
    const first = lines.length;
    lines.push(
      `<agent name=${JSON.stringify(g.ctx.agentName)} role=${JSON.stringify(tag)} agent_id=${JSON.stringify(g.ctx.agentId)}>`,
    );
    let l3Cut = false;
    if (g.l3?.content) {
      l3Count++;
      const l3Text = truncate(g.l3.content, 6000);
      l3Cut = l3Text !== g.l3.content;
      lines.push("<l3_core_memory>", l3Text, "</l3_core_memory>");
    }
    if (g.l2Entries.length > 0) {
      lines.push("<l2_scene_index>");
      // 98 · S8-b：截断之后（候选集 = 内核给定的本轮集合，**不改集合**）按信用分**稳定**降序精排；
      // 同分 / 无数据（credit=null）保持原序。**无 ranking ⇒ 既有顺序逐字不变**（golden 字节）。
      const entries = ranking ? rankL2Entries(g.l2Entries, ranking.creditByPath) : g.l2Entries;
      for (const e of entries) {
        l2TotalCount++;
        // 索引行：路径 + summary（如果有）；正文用 tool 拉
        // 98 · S8-b 加列（只在开关开且数据非 null 时**追加**；不改既有文本、不重排块结构）：
        const cols: string[] = [];
        if (ranking) {
          const credit = ranking.creditByPath.get(e.path);
          if (typeof credit === "number") cols.push(`credit=${credit.toFixed(3)}`);
          const correctedAt = ranking.correctedAtByPath.get(e.path);
          if (typeof correctedAt === "number") {
            // 60 spec §5 三条硬约束：② **成对**给检测时间（= created_at）；① 不得渲染为"当前版本"；
            // ③ 需要"当前版本"时必须从 fetched 行侧重算——本行不显示任何 version，天然不依赖 corrected payload 当当前值。
            cols.push(`⚠️ 可能已过期（检测时间: ${new Date(correctedAt).toISOString()}）`);
          }
        }
        const suffix = cols.length > 0 ? ` [${cols.join(", ")}]` : "";
        if (e.summary) {
          lines.push(`- \`${e.path}\` — ${truncate(e.summary, 200)}${suffix}`);
        } else {
          lines.push(`- \`${e.path}\`${suffix}`);
        }
      }
      lines.push("</l2_scene_index>");
    }
    lines.push("</agent>");
    hints.push({ first, last: lines.length - 1, l3Cut });
  }

  lines.push("</tdai_profile_memory>");
  // 紧跟一段 memory-tools-guide，告诉 LLM 三个工具的用法 + 调用上限
  lines.push("");
  lines.push(MEMORY_TOOLS_GUIDE);

  const { content, offsets } = joinLinesWithOffsets(lines);

  const assets: InjectedAssetRef[] = [];
  for (let i = 0; i < rendered.length; i++) {
    const g = rendered[i];
    // 解析不出真实资产（memoryAssetId 缺省）→ 宁缺勿造：内容仍注入，但不挂 ref。
    if (!g.ctx.memoryAssetId) continue;
    const h = hints[i];
    assets.push({
      assetId: g.ctx.memoryAssetId,
      assetType: "chat_memory",
      name: g.ctx.agentName,
      spans: [spanOfLines(offsets, lines, h.first, h.last)],
      truncated: h.l3Cut || undefined,
    });
  }

  return { content, assets, stats: { l3Count, l2IndexCount: l2TotalCount } };
}

function createPrewarmAgentContext(input: PrewarmInput): AgentContext {
  return {
    messages: [],
    tools: [],
    requestParams: {},
    metadata: {
      protocol: "anthropic",
      traceId: `prewarm:${input.keyId}`,
      keyId: input.keyId,
      modelId: "prewarm",
      stream: false,
      agentSource: "session-init",
      custom: { session: input.sessionInfo },
    },
  };
}

/** 记忆使用指南：L0/L1 按需用工具检索（不再自动召回），L3 直注、L2 索引直注。 */
export const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## ⚠️ 重要：这不是文档，这是你的可用能力

以下 \`<tdai_memory_tools>\` 中列出的 tdai_memory_search / tdai_conversation_search
等，是**你可以主动调用的能力**（不是仅供参考的文档）。它们通过 **Bash + curl**
使用（见上方 \`<tdai_memory_tools>\` 段里的完整调用说明与 URL）。

**禁止**回答类似"我没有这个工具 / 需要 MCP / 需要斜杠命令"。
**正确做法**：判定需要查记忆时，直接在 Bash 里执行 curl，proxy 会自动注入身份与鉴权。

## 记忆使用规则（遇到以下场景必须先查再答）

L3（persona 长期画像）与 L2 场景索引已直接注入 system。L0/L1 需要用工具主动检索。

### 必须先查记忆再回答的场景（命中任一条即触发工具调用）

1. **用户提及历史/过去/之前**：如 "我之前说过 / 我告诉过你 / 上次 / 你还记不记得 / 我们聊过 / 之前那个"
   → 用 \`tdai_conversation_search\`（L0 原文找具体消息）
2. **用户涉及自己身份/偏好/习惯**：如 "我叫什么 / 我的名字 / 我喜欢 / 我的团队 / 我常用 / 我不喜欢 / 我不允许"
   → 用 \`tdai_memory_search\`（L1 原子记忆查偏好/规则）
3. **用户要求你回忆/找**：如 "回忆一下 / 想起 / 找出 / 有没有关于 X 的记录 / 查我们之前"
   → 直接触发工具，不要凭空回答
4. **答案强依赖历史事实**：如 "那个 bug 我们怎么修的 / 上次方案是啥 / 我们的约定是什么"
   → 关键词化后 \`tdai_memory_search\`

**典型流程**（用户："我叫什么"）：
\`\`\`bash
# Step 1: 先查
curl -sfk -X POST <bridge>/atomic/search \\
  -H 'Content-Type: application/json' -H 'x-conversation-id: <sid>' \\
  -d '{"query": "用户姓名 name 身份", "limit": 5}'
# Step 2: 从 items[].content 里提取答案后回复
# 若为空: 明确告诉用户 "我在记忆里没找到，你叫什么？" —— 不要装作知道
\`\`\`

### 不需要查的场景

- 用户问 "你是谁" / "帮我改代码" / "写个脚本" / 通用编程问题
- 当前会话上下文（同轮消息）里已能回答
- 已经在 \`<l3_core_memory>\` 段落里直接看到答案

### ⚠️ 调用约束

- 每轮 \`tdai_memory_search\` + \`tdai_conversation_search\` **合计 ≤ 3 次**（\`tdai_read_scene\` / \`tdai_scenario_ls\` / \`tdai_atomic_query\` 不计入）
- 检索无果时**明确说明**"我在记忆里没找到 X"，不要幻想
- 同一 L2 path 不要重复读
</memory-tools-guide>`;

export interface AgentProfileBundle {
  ctx: FixedAssetCtx;
  l3: { content: string } | null;
  /** L2 索引：仅 path + 可选 summary，**不**读全文。 */
  l2Entries: Array<{ path: string; summary?: string }>;
}

async function loadAgentProfile(client: TdaiClient, c: FixedAssetCtx): Promise<AgentProfileBundle> {
  const tdaiCtx = { teamId: c.teamId, userId: c.userId, agentId: c.agentId, agentName: c.agentName };
  const [l3, l2Entries] = await Promise.all([client.readL3ForCtx(tdaiCtx), client.listL2ForCtx(tdaiCtx)]);
  // L3(persona) 可能在尾部内嵌一份「Scene Navigation」场景索引（plugin 侧 read 会带导航段）。
  // 我们已经单独注入 <l2_scene_index>，必须剥掉 persona 尾部这份，避免 L2 索引重复注入。
  const l3Stripped = l3 ? stripSceneNavigation(l3.content) : "";
  return {
    ctx: c,
    l3: l3Stripped.trim() ? { content: l3Stripped } : null,
    l2Entries: (l2Entries ?? []).map((e) => ({ path: e.path, summary: e.summary })),
  };
}

/**
 * 剥离 persona 尾部的「Scene Navigation (Scene Index)」段。
 * 与 plugin 端 scene-navigation.ts 的 NAV_HEADER 对齐（带或不带前置 `---` 都能命中）。
 */
export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf("## 🗺️ Scene Navigation");
  if (idx === -1) return personaContent;
  // 连同紧邻的 `---` 分隔符与前后空白一起去掉
  let cut = personaContent.slice(0, idx);
  cut = cut.replace(/\s*-{3,}\s*$/, "");
  return cut.trimEnd();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}
