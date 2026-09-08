/**
 * F1（s0-s2-review P2）：resolveFixedAssetCtxs 身份合成三路径直测。
 *
 * 此前 asset-metadata/smoke 全部用手工 FixedAssetCtx 字面量绕过 resolver（rg 引用为 0），
 * imported 绑定回填 / team 修正 / self 合成若回归，17+4 个测试仍全绿。本文件用 fake
 * MetadataClient 覆盖 15-spec §5.2/§6/§8 明文的四态：
 *   - 无 client 兜底 self-only
 *   - detail 含 self + imported（team 修正 / 错误 team 过滤 / self 镜像过滤 / >2 截断）
 *   - items=0（review F3：仍走修正后 team 重组 self）
 *   - 内核 / 单个来源 agent 抛错降级
 * 外加 ctx 级缓存（同 ctx 重复调用不重打内核）。
 */

import { describe, expect, it } from "vitest";

import type { AgentContext } from "../../types.js";
import type { TdaiIdentity } from "../../../tdai/types.js";
import type {
  AgentEntity,
  AgentFixedAssetDetail,
  FixedAssetItem,
  MetadataClient,
} from "../../../meta/client.js";
import { resolveFixedAssetCtxs, type FixedAssetCtx } from "../tdai-fixed-asset.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

function chatMemoryAssetId(teamId: string, agentId: string): string {
  return `chat_memory-${teamId}-${agentId}`;
}

/** 与实现同构：agent id 必须含 "-agt" 段，否则 parseChatMemoryAssetId 不认。 */
const AGT = {
  self: "agt-self",
  a: "agt-a",
  b: "agt-b",
  c: "agt-c",
  z: "agt-z",
} as const;

class FakeMetaClient {
  fixedCalls = 0;
  agentCalls: string[] = [];
  detail: AgentFixedAssetDetail = { agent: {}, items: [], total: 0 };
  agents = new Map<string, AgentEntity>();
  failFixed = false;

  async getAgentFixedAssets(): Promise<AgentFixedAssetDetail> {
    this.fixedCalls++;
    if (this.failFixed) throw new Error("kernel down");
    return this.detail;
  }

  async getAgent(agentId: string): Promise<AgentEntity> {
    this.agentCalls.push(agentId);
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent not found: ${agentId}`);
    return agent;
  }
}

function item(agentId: string, teamId: string): FixedAssetItem {
  return { asset_id: chatMemoryAssetId(teamId, agentId), asset_type: "chat_memory", name: agentId };
}

function agentOf(agentId: string, teamId: string, name?: string): AgentEntity {
  return {
    agent_id: agentId,
    team_id: teamId,
    owner_user_id: `u-${agentId}`,
    name: name ?? agentId,
  };
}

function identity(overrides: Partial<TdaiIdentity> = {}): TdaiIdentity {
  return {
    teamId: "T-orig",
    userId: "u-me",
    agentId: AGT.self,
    sessionId: "sess-1",
    ...overrides,
  };
}

function makeCtx(): AgentContext {
  return {
    messages: [],
    tools: [],
    requestParams: {},
    metadata: { protocol: "anthropic", custom: {} },
  } as unknown as AgentContext;
}

function expectSelf(
  ctx: FixedAssetCtx,
  teamId: string,
  overrides: Partial<FixedAssetCtx> = {},
): void {
  expect(ctx.isSelf).toBe(true);
  expect(ctx.memoryAssetId).toBe(chatMemoryAssetId(teamId, ctx.agentId));
  expect(ctx).toMatchObject({ teamId, isSelf: true, ...overrides });
}

/** MetadataClient 是带私有字段的 class（名义类型），fake 需显式 cast。 */
function resolveWith(
  ctx: AgentContext,
  id: TdaiIdentity,
  client: FakeMetaClient | null,
): Promise<FixedAssetCtx[]> {
  return resolveFixedAssetCtxs(ctx, id, client as unknown as MetadataClient | null);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("resolveFixedAssetCtxs", () => {
  it("no client → identity-based self only, cached", async () => {
    const ctx = makeCtx();
    const id = identity();
    const out = await resolveWith(ctx, id, null);
    expect(out).toHaveLength(1);
    expectSelf(out[0], "T-orig", { agentId: AGT.self, userId: "u-me", agentName: AGT.self });
    // 同 ctx 命中缓存（无 client 分支也写缓存）
    const again = await resolveWith(ctx, id, null);
    expect(again).toEqual(out);
  });

  it("detail with corrected team + self + valid imports → rebased self first, imported bound to item.asset_id", async () => {
    const client = new FakeMetaClient();
    client.detail = {
      agent: { agent_id: AGT.self, team_id: "T-correct", owner_user_id: "u-self", name: "Self Name" },
      items: [
        item(AGT.a, "T-correct"),
        item(AGT.b, "T-correct"),
      ],
      total: 2,
    };
    client.agents.set(AGT.a, agentOf(AGT.a, "T-correct", "Agent A"));
    client.agents.set(AGT.b, agentOf(AGT.b, "T-correct", "Agent B"));

    const out = await resolveWith(makeCtx(), identity(), client);

    expect(out).toHaveLength(3);
    // self：用修正后 team 重组（identity.teamId=T-orig ≠ T-correct）
    expectSelf(out[0], "T-correct", { agentId: AGT.self, agentName: "Self Name", userId: "u-self" });
    // imported：绑定 item 的 asset_id 原样带回，agentName 来自来源 agent
    expect(out[1]).toMatchObject({ agentId: AGT.a, agentName: "Agent A", isSelf: false });
    expect(out[1].memoryAssetId).toBe(chatMemoryAssetId("T-correct", AGT.a));
    expect(out[2]).toMatchObject({ agentId: AGT.b, isSelf: false });
    expect(out[2].memoryAssetId).toBe(chatMemoryAssetId("T-correct", AGT.b));
    expect(client.agentCalls).toEqual([AGT.a, AGT.b]);
  });

  it("filters wrong-team items and self-mirror items out of imported", async () => {
    const client = new FakeMetaClient();
    client.detail = {
      agent: { agent_id: AGT.self, team_id: "T-correct" },
      items: [
        item(AGT.a, "T-correct"),
        item(AGT.z, "T-other"), // 错误 team → 跳过（getAgent 不应被调用）
        item(AGT.self, "T-correct"), // self 镜像 → 跳过
        item(AGT.b, "T-correct"),
      ],
      total: 4,
    };
    client.agents.set(AGT.a, agentOf(AGT.a, "T-correct"));
    client.agents.set(AGT.b, agentOf(AGT.b, "T-correct"));

    const out = await resolveWith(makeCtx(), identity(), client);

    expect(out.map((c) => c.agentId)).toEqual([AGT.self, AGT.a, AGT.b]);
    expect(client.agentCalls).toEqual([AGT.a, AGT.b]); // agt-z 未查询
    expect(out[1].memoryAssetId).toBe(chatMemoryAssetId("T-correct", AGT.a));
  });

  it("caps imported at 2 (slice)", async () => {
    const client = new FakeMetaClient();
    client.detail = {
      agent: { agent_id: AGT.self, team_id: "T-correct" },
      items: [item(AGT.a, "T-correct"), item(AGT.b, "T-correct"), item(AGT.c, "T-correct")],
      total: 3,
    };
    client.agents.set(AGT.a, agentOf(AGT.a, "T-correct"));
    client.agents.set(AGT.b, agentOf(AGT.b, "T-correct"));
    client.agents.set(AGT.c, agentOf(AGT.c, "T-correct"));

    const out = await resolveWith(makeCtx(), identity(), client);

    expect(out).toHaveLength(3); // self + 2 imported
    expect(out.map((c) => c.agentId)).toEqual([AGT.self, AGT.a, AGT.b]);
  });

  it("items=0 with corrected team still rebases self (review F3 regression)", async () => {
    const client = new FakeMetaClient();
    client.detail = {
      agent: { agent_id: AGT.self, team_id: "T-correct", owner_user_id: "u-self", name: "Self Name" },
      items: [],
      total: 0,
    };

    const out = await resolveWith(makeCtx(), identity(), client);

    expect(out).toHaveLength(1);
    // 修复前：items=0 会落到顶部 identity.teamId 合成（T-orig）→ 与 items>0 口径分裂
    expectSelf(out[0], "T-correct", { agentId: AGT.self, agentName: "Self Name", userId: "u-self" });
    expect(out[0].teamId).not.toBe("T-orig");
  });

  it("kernel failure → silent degrade to identity-based self only", async () => {
    const client = new FakeMetaClient();
    client.failFixed = true;

    const out = await resolveWith(makeCtx(), identity(), client);

    expect(out).toHaveLength(1);
    expectSelf(out[0], "T-orig", { agentId: AGT.self });
  });

  it("single imported source agent lookup failure → skip that item, keep the rest", async () => {
    const client = new FakeMetaClient();
    client.detail = {
      agent: { agent_id: AGT.self, team_id: "T-orig" },
      items: [item(AGT.a, "T-orig"), item(AGT.b, "T-orig")],
      total: 2,
    };
    client.agents.set(AGT.a, agentOf(AGT.a, "T-orig")); // agt-b 故意缺 → getAgent 抛

    const out = await resolveWith(makeCtx(), identity(), client);

    expect(client.agentCalls).toContain(AGT.b); // 查询过但失败
    expect(out.map((c) => c.agentId)).toEqual([AGT.self, AGT.a]); // agt-b 被跳过
  });

  it("caches per-ctx: repeated calls on same ctx do not re-hit the kernel", async () => {
    const client = new FakeMetaClient();
    client.detail = { agent: { agent_id: AGT.self, team_id: "T-orig" }, items: [], total: 0 };
    const ctx = makeCtx();

    const first = await resolveWith(ctx, identity(), client);
    const second = await resolveWith(ctx, identity(), client);

    expect(client.fixedCalls).toBe(1);
    expect(second).toEqual(first);

    const freshCtx = makeCtx();
    await resolveWith(freshCtx, identity(), client);
    expect(client.fixedCalls).toBe(2); // 新 ctx 才重打内核
  });
});
