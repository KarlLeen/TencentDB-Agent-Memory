/**
 * 哨兵 1 · **端到端升级版**（2026-09-10，§7.1 归一化）：真 HTTP 主链路 + 真 bridge
 * ⇒ 两侧落在同一个 `session_key`。
 *
 * 为什么必须另起一个装置（而不是留在 `bridge-fetch-events.test.ts` 的哨兵 1）：
 *   那里的哨兵 1 直接调 `runDecisionUnitExtraction`，主链路那一侧的 `sessionKey` 是测试
 *   **手工喂**进去的字符串（`driveMainTurns`）⇒ 它证明的是"两侧口径约定一致"（**管道级**），
 *   证伪不了"主链路退回 composite"这一类回归 —— 与"golden 直接调 judge、绕过 consumeRow"
 *   **同族**的覆盖缺口。本装置让主链路走**真 `createApp` + 真 HTTP**，`sessionKey` 由
 *   `anthropicHandler.ts:670-672` 的 `resolveConversationId(c)` 真算（这就是 bridge 侧
 *   新增那行调用的**同一个函数**），只在最外层观察落行 ⇒ 把"端到端对齐"从推断变成**观测**。
 *
 * 覆盖范围（2026-09-10 更新，`52-unify-session-header-parsers` 之后）：下面 1/1b 原先是
 * "**不**覆盖"的边界声明，那两类分歧**本轮已被修掉**（三份列表 → 一份），故同步改写——
 * 留着旧声明会变成**过时且误导**的边界：
 *   1. **已覆盖**：`51-…-report.md` §5.2 / §8.5 的那两类"多出来的 header"分歧
 *      （`x-claude-code-session-id` / `x-deepseek-harness-session-id` 与 `x-chat-id`
 *      同时出现；以及"cc 排在第 5 位"这种**位置错**）—— 见用例 13 的 27 格矩阵，
 *      `#7/#8/#9` 正是这三类。**生效前提**：三条链路共用**同一个** `resolveConversationId`
 *      （两份私有 `deriveSessionId` 已删除）；若有人再抄一份列表或改动优先级，`#7/#8/#9` 会红。
 *   1b. **已收敛（53）**：`identity.ts` 原先自带的第 4 份解析器（53 前在 `identity.ts:131-139`）已改为直调
 *      唯一真相 `resolveConversationIdFromHeaders` —— 该函数现在同时被 `resolveConversationId` 与
 *      `identity.ts` 的调试日志调用，**会话头名单只剩一份**；这个 `sessionId` 只进 `[identity]` 日志、
 *      不进 bridge 路径（故本矩阵无需覆盖它）。
 *   2. 上游 / kernel 用 stub（只记录、不参与判定），判定全在落行侧（与 S4a 同纪律）。
 *
 * 变红的**第一嫌疑**（写给将来看到失败的人）：若主链路退回 composite，
 * `asset_fetched.session_key` 仍是裸 `CONV` 而 `decision_unit.created.session_key`
 * 会变成 `claude-code:CONV` ⇒ 本用例的集合相等断言直接红，且下面那条
 * "composite 形态不许出现"的负例断言会把原因指出来。
 */
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { serve } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import {
  __resetAttributionEventRepoForTests,
  setAttributionEventRepo,
  type AttributionEventRepo,
  type AttributionEventRow,
  type NewAttributionEvent,
} from "../../db/attributionEventRepo.js";
import { __resetDbForTests } from "../../db/index.js";
import { createBridgeFetchEventSink } from "../../attribution/bridge-fetch-events.js";
import { __resetDecisionUnitStateForTests } from "../../decision-units/decision-unit-runner.js";
import {
  __resetBridgeTelemetrySinksForTests,
  addBridgeTelemetrySink,
} from "../../memory/bridge-telemetry.js";
import { __resetProxyStorageForTests } from "../../storage/factory.js";
import { __resetSessionStoreForTests, getSessionStore } from "../../session/store.js";
import type { SessionInitState } from "../../session/types.js";
import type { ProxyConfig } from "../../types.js";
import { createApp } from "../../server.js";
import {
  S4_KERNEL_FIXTURE,
  startKernelStub,
  startUpstreamStub,
  type HttpStub,
} from "../../injection/__tests__/_helpers/s4-stubs.js";

const CONV = "conv-e2e";
/** bridge 侧的会话复合键（F10：带 agent 前缀）；主链路侧的是 `claude-code:CONV`。 */
const BRIDGE_COMPOSITE = `codebuddy:${CONV}`;
const MAIN_COMPOSITE = `claude-code:${CONV}`;
const SPACE = "sp-e2e";
const USER = "u-e2e";
const SKILL_ID = "sk-e2e-0001";

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** 两个连续主请求 ⇒ 第二条把上一条消息密封出 ≥1 个决策单元（与 P-0 夹具同构）。 */
const MAIN_TURN_1 = [
  { role: "user", content: "给 a.ts 加个函数" },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "a.ts" } }],
  },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] },
];
const MAIN_TURN_2 = [
  ...MAIN_TURN_1,
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "e2", name: "Edit", input: { file_path: "b.ts" } }],
  },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "e2", content: "ok" }] },
];

/** anthropic 主请求体（非流式；模型价目表为空 ⇒ 不触发 model gate）。 */
function anthropicBody(messages: unknown[]): unknown {
  return { model: "claude-e2e-stub", max_tokens: 64, stream: false, messages };
}

// ── fake 落行 repo（与 bridge-fetch-events.test.ts 同款；fake 行是 camelCase）──────

type FakeAttributionRepo = AttributionEventRepo & { rows: NewAttributionEvent[] };

function makeFakeRepo(): FakeAttributionRepo {
  const rows: NewAttributionEvent[] = [];
  return {
    rows,
    append(e) {
      rows.push(e);
    },
    appendMany(events) {
      rows.push(...events);
    },
    listBySession(): AttributionEventRow[] {
      return [];
    },
    listByAsset(): AttributionEventRow[] {
      return [];
    },
  };
}

function rowsOf(repo: FakeAttributionRepo, eventType: string): NewAttributionEvent[] {
  return repo.rows.filter((r) => r.eventType === eventType);
}

// ── 真 proxy（createApp + 真 listen，与 S4a smoke 同姿势）─────────────────────────

interface StartedProxy {
  port: number;
  close(): Promise<void>;
}

async function startProxy(config: ProxyConfig): Promise<StartedProxy> {
  const app = createApp(config);
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * 以真实 `DEFAULT_CONFIG` 为底，只覆盖本装置需要的字段（避免"第二个配置漂移源"）。
 *
 * 关键几项：
 *   - `decisionUnitExtractor.enabled=true` → 主链路 `anthropicHandler.ts:1027` 的守卫打开；
 *   - `bridgeFetchEvents.enabled=true`    → `server.ts:136` 由**生产装配**注册 S4 sink
 *     （所以这里故意**不**手工 `addBridgeTelemetrySink`：要测的就是真装配）；
 *   - `injectors=[]`                      → 注入面不产块、不改 `messages`（抽取只看真 messages）；
 *   - `sessionInit.enabled=true` + kernel stub + `debugForceIdentity` → 复刻 S4a 已验证的
 *     配置（会话身份来自 kernel，而非测试手工塞 store）。
 */
function e2eConfig(upstreamUrl: string, kernelUrl: string): ProxyConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: "127.0.0.1", port: 0 };
  cfg.upstream = { ...cfg.upstream, url: upstreamUrl };
  cfg.coreSkill = {
    ...cfg.coreSkill,
    endpoint: kernelUrl,
    serviceToken: "sk-mem-e2e",
    serviceId: SPACE,
    timeoutMs: 2000,
  };
  cfg.costGuard = { ...cfg.costGuard, enabled: false };
  cfg.langfuse = { ...cfg.langfuse, enabled: false };
  cfg.sessionInit = {
    ...cfg.sessionInit,
    enabled: true,
    maxRetries: cfg.sessionInit?.maxRetries ?? 3,
    injectAgentContext: true,
    injectTaskContext: true,
    debugForceIdentity: {
      team_id: S4_KERNEL_FIXTURE.teamId,
      agent_id: S4_KERNEL_FIXTURE.agentId,
      task_id: S4_KERNEL_FIXTURE.taskId,
    },
    debugForceUserId: USER,
    debugVerboseLogging: false,
  };
  cfg.injection = {
    ...cfg.injection,
    enabled: true,
    injectors: [],
    decisionUnitExtractor: { enabled: true },
    bridgeFetchEvents: { enabled: true },
    attributionEvents: { enabled: false },
  };
  return cfg;
}

let upstream: HttpStub;
let kernel: HttpStub;
let proxy: StartedProxy;

async function postJson(
  port: number,
  apiPath: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

/** 主链路两种序列化后的形态（断失败时能直接看出"是不是退回 composite 了"）。 */
const sessionKeysOf = (repo: FakeAttributionRepo, eventType: string): string[] =>
  rowsOf(repo, eventType).map((r) => r.sessionKey);

beforeAll(async () => {
  upstream = await startUpstreamStub();
  kernel = await startKernelStub();
  proxy = await startProxy(e2eConfig(upstream.url, kernel.url));
});

afterAll(async () => {
  await proxy?.close();
  await upstream?.close();
  await kernel?.close();
  __resetBridgeTelemetrySinksForTests();
  __resetAttributionEventRepoForTests();
  __resetProxyStorageForTests();
  __resetSessionStoreForTests();
  __resetDecisionUnitStateForTests();
  __resetDbForTests();
});

beforeEach(() => {
  upstream.requests.length = 0;
  kernel.requests.length = 0;
  // ⚠️ 这里**故意不**调 `__resetBridgeTelemetrySinksForTests()`：S4 sink 是 `createApp`
  //    时由**生产装配**（`server.ts:136`）注册**一次**的，本装置要测的就是那次装配。
  //    在 beforeEach 里清空 = 把被测对象静默拆掉 ⇒ `[skill-bridge] status=200` 照样绿、
  //    落行数却是 0（首次实现就踩了这个坑，靠"0 行"断言自曝）。
  __resetAttributionEventRepoForTests();
  __resetProxyStorageForTests();
  __resetSessionStoreForTests();
  __resetDecisionUnitStateForTests();
});

afterEach(() => {
  __resetBridgeTelemetrySinksForTests();
  __resetAttributionEventRepoForTests();
  __resetProxyStorageForTests();
  __resetDbForTests();
});

describe("用例 12 · 端到端对齐（真 HTTP 主链路 ⇒ 真 S4 落行）", () => {
  it("真 /v1/messages 两轮 与 真 /skill-bridge 落在同一个裸 session_key", async () => {
    const repo = makeFakeRepo();
    setAttributionEventRepo(repo);

    // bridge 侧会话：真 store（与生产同一条 L2 恢复路径），复合键同 F10 口径。
    await getSessionStore().set(BRIDGE_COMPOSITE, {
      status: "initialized",
      sessionInfo: {
        session_id: CONV,
        user_id: USER,
        team_id: "t-e2e",
        agent_id: "ag-e2e",
        space_id: SPACE,
        user_key: "uk-e2e",
      },
    } as unknown as SessionInitState);

    // ── ① 真主链路：两轮 /v1/messages（agent 前缀路径 ⇒ agent_source=claude-code）──
    const mainHeaders = {
      "x-claude-code-session-id": CONV,
      authorization: "Bearer sk-mem-e2e",
    };
    const r1 = await postJson(proxy.port, `/claude-code/${SPACE}/v1/messages`, anthropicBody(MAIN_TURN_1), mainHeaders);
    expect(r1.status, `第 1 轮主请求未 200（body: ${r1.text.slice(0, 400)}）`).toBe(200);
    const r2 = await postJson(proxy.port, `/claude-code/${SPACE}/v1/messages`, anthropicBody(MAIN_TURN_2), mainHeaders);
    expect(r2.status, `第 2 轮主请求未 200（body: ${r2.text.slice(0, 400)}）`).toBe(200);

    // 正向证据：主链路**真的**被跑到了（否则下面可能"完美空集相等"地假绿）。
    expect(
      upstream.requestsTo("/messages").length,
      "上游 stub 一条 /messages 都没收到 → 主链路没真的转发，落行证据无效",
    ).toBe(2);

    // ── ② 真 bridge：同一逻辑会话（header 口径不同但 resolveConversationId 收敛到同一裸键）──
    const rb = await postJson(
      proxy.port,
      "/skill-bridge/v3/skill/get",
      { skill_id: SKILL_ID },
      { ...JSON_HEADERS, "x-conversation-id": CONV },
    );
    expect(rb.status, `bridge 未 200（body: ${rb.text.slice(0, 400)}）`).toBe(200);

    // ── ③ 观测面：两侧各恰好一个键，且相等、且是裸键 ──────────────────────────────
    const fetched = new Set(sessionKeysOf(repo, "asset_fetched"));
    const units = new Set(sessionKeysOf(repo, "decision_unit.created"));

    expect(rowsOf(repo, "asset_fetched").length, "bridge 没落行 → 断言无意义").toBeGreaterThan(0);
    expect(rowsOf(repo, "decision_unit.created").length, "主链路没落决策单元行 → 断言无意义").toBeGreaterThan(0);
    expect(units.size, `决策单元侧键不唯一：${[...units].join(", ")}`).toBe(1);
    expect(fetched.size, `抓取侧键不唯一：${[...fetched].join(", ")}`).toBe(1);
    expect([...fetched]).toEqual([...units]); // ← 核心断言（S5 锚定的前提）
    expect([...fetched]).toEqual([CONV]);

    // ── ④ 回归签名（把"退回 composite"这个第一嫌疑钉出来）────────────────────────
    expect([...units]).not.toContain(MAIN_COMPOSITE);
    expect([...fetched]).not.toContain(BRIDGE_COMPOSITE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 用例 13 · 会话头解析统一矩阵（3 链路 × 9 组合 = 27 格）
//
// `51-…-report.md` §5.3 那张矩阵的**端到端**版 + 第 3 条链路（memory-bridge）。
// 三条链路：主链路 `/claude-code/<space>/v1/messages`、`/skill-bridge/v3/skill/get`、
// `/memory-bridge/v3/scenario/ls` —— 全部真 `createApp` + 真 `listen(0)` + 真 HTTP。
//
// 为什么不是"同一 header 口径下两侧收敛"那种重言式：每格都带**外来期望值**（下表
// `expect`），且 9 个组合里有 3 个（#7/#8/#9）在修复前**三条链路互相不一致**。
//
// 观测通道（不依赖任何私有函数）：把会话**只** seed 在 `codebuddy:<expect>` 下 ⇒
//   200 = 该链路确实按 `<expect>` 去查找（L1 候选 = [键, codebuddy:键, claude-code:键]）；
//   落行 `session_key` = 该链路实际使用的归因键。
//
// 修复前逐格实测（2026-09-10，`52-unify-session-header-parsers` 动工前）：
//   #1–#6 三条链路全一致；
//   #7 skill=**401**（无落行）/ memory=200 `c-cc` / main=`c-cc` ⇒ **两 bridge 之间也分歧**；
//   #8 skill=401 + 落行 `c-chat2` / memory=401 + 落行 `c-chat2` / main=`c-cc2`；
//   #9 skill=401 + 落行 `c-chat3` / memory=401 + 落行 `c-chat3` / main=`c-dsh`。
//   （#8/#9 的 401 是因为只 seed 了 `codebuddy:c-cc2`/`c-dsh`；落行键 = 它实际查找的键。）
// ─────────────────────────────────────────────────────────────────────────────

const BRIDGE_SOURCE_OF = (r: NewAttributionEvent): string =>
  String((r.payload as Record<string, unknown> | undefined)?.bridgeSource ?? "");

const MATRIX: Array<{ id: number; name: string; headers: Record<string, string>; expect: string }> = [
  { id: 1, name: "conv", headers: { "x-conversation-id": "c-conv" }, expect: "c-conv" },
  { id: 2, name: "sess", headers: { "x-session-id": "c-sess" }, expect: "c-sess" },
  { id: 3, name: "chat", headers: { "x-chat-id": "c-chat" }, expect: "c-chat" },
  { id: 4, name: "thread", headers: { "x-thread-id": "c-thread" }, expect: "c-thread" },
  {
    id: 5,
    name: "conv+cc+chat",
    headers: { "x-conversation-id": "c-c1", "x-claude-code-session-id": "c-c2", "x-chat-id": "c-c3" },
    expect: "c-c1",
  },
  { id: 6, name: "sess+chat", headers: { "x-session-id": "c-s1", "x-chat-id": "c-s2" }, expect: "c-s1" },
  { id: 7, name: "cc only", headers: { "x-claude-code-session-id": "c-cc" }, expect: "c-cc" },
  {
    id: 8,
    name: "cc+chat",
    headers: { "x-claude-code-session-id": "c-cc2", "x-chat-id": "c-chat2" },
    expect: "c-cc2",
  },
  {
    id: 9,
    name: "dsh+chat",
    headers: { "x-deepseek-harness-session-id": "c-dsh", "x-chat-id": "c-chat3" },
    expect: "c-dsh",
  },
];

/** 每格从零开始：会话**只** seed 在 `codebuddy:<key>` 下（= 唯一可观测的"链路查了哪个键"）。 */
async function seedOnly(key: string): Promise<void> {
  __resetSessionStoreForTests();
  __resetDecisionUnitStateForTests();
  await getSessionStore().set(`codebuddy:${key}`, {
    status: "initialized",
    sessionInfo: {
      session_id: key,
      user_id: USER,
      team_id: "t-e2e",
      agent_id: "ag-e2e",
      space_id: SPACE,
      user_key: "uk-e2e",
    },
  } as unknown as SessionInitState);
}

describe("用例 13 · 会话头解析统一矩阵（3 链路 × 9 组合）", () => {
  it("27 格：三条链路对每个 header 组合必须解析出同一个键", async () => {
    // ⚠️ 必须显式注册 S4 sink：本装置的 afterEach 会 `__resetBridgeTelemetrySinksForTests()`，
    //    而 createApp 时由生产装配注册的那一个只在**本文件第一个用例**内有效。只注册一次
    //    （循环内注册会累积 sinks ⇒ 每次 emit 落 N 行，观测失真）。
    addBridgeTelemetrySink(createBridgeFetchEventSink());
    const observed: string[] = [];

    for (const combo of MATRIX) {
      const repo = makeFakeRepo();
      setAttributionEventRepo(repo);
      await seedOnly(combo.expect);

      // ① /skill-bridge（真 HTTP）
      const rs = await postJson(
        proxy.port,
        "/skill-bridge/v3/skill/get",
        { skill_id: SKILL_ID },
        { ...JSON_HEADERS, ...combo.headers },
      );
      const skillKey = repo.rows.find((r) => BRIDGE_SOURCE_OF(r) === "skill-bridge")?.sessionKey;

      // ② /memory-bridge（真 HTTP）
      const rm = await postJson(
        proxy.port,
        "/memory-bridge/v3/scenario/ls",
        {},
        { ...JSON_HEADERS, ...combo.headers },
      );
      const memKey = repo.rows.find((r) => BRIDGE_SOURCE_OF(r) === "memory-bridge")?.sessionKey;

      // ③ 主链路（真 HTTP，两轮 ⇒ 第二条把上一条密封出决策单元）
      const mh = { authorization: "Bearer sk-mem-e2e", ...combo.headers };
      const r1 = await postJson(proxy.port, `/claude-code/${SPACE}/v1/messages`, anthropicBody(MAIN_TURN_1), mh);
      const r2 = await postJson(proxy.port, `/claude-code/${SPACE}/v1/messages`, anthropicBody(MAIN_TURN_2), mh);
      const mainKeys = [...new Set(rowsOf(repo, "decision_unit.created").map((r) => r.sessionKey))];

      observed.push(
        `#${combo.id} ${combo.name} | skill=${String(skillKey)} | memory=${String(memKey)} | main=${mainKeys.join(",") || "-"}`,
      );

      // 逐格断言：三个维度各自独立（不是"两侧收敛"的重言式）。
      // 用 `expect.soft` ⇒ 反向控制时**所有**变红的格子一次全暴露（硬断言会停在第一格）。
      expect.soft(rs.status, `#${combo.id} skill 状态`).toBe(200);
      expect.soft(skillKey, `#${combo.id} ${combo.name} skill 落行键`).toBe(combo.expect);
      expect.soft(rm.status, `#${combo.id} memory 状态`).toBe(200);
      expect.soft(memKey, `#${combo.id} ${combo.name} memory 落行键`).toBe(combo.expect);
      expect.soft(r1.status, `#${combo.id} 主链路 turn1`).toBe(200);
      expect.soft(r2.status, `#${combo.id} 主链路 turn2`).toBe(200);
      expect.soft(mainKeys, `#${combo.id} ${combo.name} 主链路落行键`).toEqual([combo.expect]);
      // 三条链路合成一格：§3.2 的两组反向控制都会让这一格变红
      expect.soft(
        new Set([String(skillKey), String(memKey), ...mainKeys]).size,
        `#${combo.id} ${combo.name} 三条链路必须解析出同一个键`,
      ).toBe(1);
    }

    // eslint-disable-next-line no-console
    console.log("MATRIX-27\n" + observed.join("\n") + "\nMATRIX-END");
  }, 180_000);

  it("§3.3 拒绝面收窄：ccsid-only 不再 401 missing_conversation_id", async () => {
    addBridgeTelemetrySink(createBridgeFetchEventSink());
    const repo = makeFakeRepo();
    setAttributionEventRepo(repo);
    await seedOnly("c-cc-only");

    // 修复前实测（2026-09-10）：status=**401**、body=`… missing x-conversation-id (or x-session-id
    //   / x-chat-id / x-thread-id) header`、rejectReason=`missing_conversation_id`、
    //   **早退在会话解析之前**（skill-bridge 的私有 `deriveSessionId` 缺 cc 头 ⇒ null）
    //   ⇒ **从不落 `asset_fetched` 行**。
    // 修复后：正常解析（本用例断言 200 + 落行键）。
    const res = await postJson(
      proxy.port,
      "/skill-bridge/v3/skill/get",
      { skill_id: SKILL_ID },
      { ...JSON_HEADERS, "x-claude-code-session-id": "c-cc-only" },
    );
    expect(res.status).toBe(200);
    expect(rowsOf(repo, "asset_fetched")[0]?.sessionKey).toBe("c-cc-only");

    // 子情形 2：**没有**这个会话时 —— 也比修复前前进了一步：不再是"解析会话之前就
    // 早退"的 `missing_conversation_id`（**从不落行**），而是正常的 `session_not_initialized`
    // （**落一行** reject，且键已是裸 `c-cc-only`）。
    const repo2 = makeFakeRepo();
    setAttributionEventRepo(repo2);
    __resetSessionStoreForTests();
    const res2 = await postJson(
      proxy.port,
      "/skill-bridge/v3/skill/get",
      { skill_id: SKILL_ID },
      { ...JSON_HEADERS, "x-claude-code-session-id": "c-cc-only" },
    );
    expect(res2.status).toBe(401);
    expect(rowsOf(repo2, "asset_fetched")).toHaveLength(1);
    expect(
      (rowsOf(repo2, "asset_fetched")[0]?.payload as Record<string, unknown> | undefined)?.rejectReason,
    ).toBe("session_not_initialized");
  }, 60_000);
});
