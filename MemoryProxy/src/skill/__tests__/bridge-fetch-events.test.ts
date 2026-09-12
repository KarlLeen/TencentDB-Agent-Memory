/**
 * S4 · bridge 遥测 SQLite sink：§4 用例 3b/4/5/6/7/8/9/10 的端到端 harness。
 *
 * 为什么必须是真 harness（而不是"既有测试复跑"）：全仓在 S4 之前**没有任何**
 * bridge 测试（F11），所以"没挂"不能当证据。本文件走**真实** handler + 真实
 * Hono Context + 真 fetcher 注入，只在最外层观察 SQLite 落行。
 *
 * 三条诚实边界（先说清，免得把弱证据读成强证据）：
 *   1. **CH 通路不可直接观测**：测试里 clickhouse 未初始化，`writeToolCallRow`
 *      是 no-op（F4），所以"CH 逐字段不变"用**构造性**证据代替观测：
 *      ① `row` 键集合 + ② `buildToolCallLogRow(row)` 列集合 + ③ CH sink 每桥
 *      恰好被调 1 次（与 sink 链无关）。三者合起来等价于"CH 通路未被触碰"。
 *   2. **用例 3b 用真 pin 读回**：`storage.backend="memory"` + 真 `KvVersionPinRepo`
 *      从同一 storage 读回 `{skillId, version}`，与提取器产出逐字段比 —— 不是
 *      人工对照。代价：只覆盖 `pinMany`/`upsertVersion` 两条真落盘路径。
 *   3. **ctx 绝不落库**由哨兵串（SENTINEL_*）+ 全行 JSON 序列化扫描证伪式断言。
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildToolCallLogRow, type ToolCallLogInput } from "../../clickhouse.js";
import { DEFAULT_CONFIG } from "../../config.js";
import {
  __resetAttributionEventRepoForTests,
  getAttributionEventRepo,
  getAttributionWriteCounters,
  setAttributionEventRepo,
  type AttributionEventRepo,
  type AttributionEventRow,
  type NewAttributionEvent,
} from "../../db/attributionEventRepo.js";
import { __resetDbForTests, getDb } from "../../db/index.js";
import {
  __resetDecisionUnitStateForTests,
  runDecisionUnitExtraction,
} from "../../decision-units/decision-unit-runner.js";
import {
  __resetBridgeTelemetrySinksForTests,
  addBridgeTelemetrySink,
  emitBridgeToolCallTelemetry,
  type BridgeCallTelemetryInput,
} from "../../memory/bridge-telemetry.js";
import { getSessionStore } from "../../session/store.js";
import type { SessionInitState } from "../../session/types.js";
import { __resetProxyStorageForTests, getProxyStorage } from "../../storage/factory.js";
import type { ProxyConfig } from "../../types.js";
import { extractFetchedAssets } from "../../attribution/bridge-fetch-assets.js";
import { createBridgeFetchEventSink } from "../../attribution/bridge-fetch-events.js";
import { KvVersionPinRepo } from "../kv-version-pin-repo.js";
import { createSkillBridgeHandler } from "../skill-bridge.js";
import { restoreIsolatedDbPath } from "../../__tests__/setup/isolate-db.js";

const CONV = "conv-s4";
/** session store 的 key = 带 agent 前缀的 composite key（F10）。 */
const COMPOSITE = `codebuddy:${CONV}`;
const SPACE = "sp-s4";
const USER = "u-s4";
const SKILL_ID = "sk-s4-0001";
const VERSION = 7;

/** ctx 的两个字段一旦出现在落库行里就说明隔离破了（见文件头边界 3）。 */
const SENTINEL_REQ = "SENTINEL-inbound-body-must-never-persist";
const SENTINEL_RESP = "SENTINEL-response-text-must-never-persist";

const JSON_HEADERS = { "content-type": "application/json" } as const;
const withConv = { ...JSON_HEADERS, "x-conversation-id": CONV } as const;

/** 请求体带哨兵，且字段顺序刻意让 skill_id 靠后（呼应 P5：截断会丢 id）。 */
const GOOD_BODY = JSON.stringify({ note: SENTINEL_REQ, skill_id: SKILL_ID });

/**
 * 哨兵 2 · 9 类 reject 的 `session_key` 形态（2026-09-10 **实测**，非推断；HEAD 与
 * 归一化后逐字相同 ⇒ 17 处 reject 行为零变化）：
 *   - 五类在"解析会话之前"早退（route/method/content-type/body/缺 header）⇒ `""`；
 *   - `session_not_initialized` 有 header 键但无会话 ⇒ 裸 `conv-never-seeded`；
 *   - 其余三类（已过会话解析、业务前置校验失败）⇒ 裸 `CONV`。
 * 三者**都**不是 composite ⇒ 它们本来就在归因域，只有 success 路径是 composite。
 */
const REJECT_SESSION_KEY: Record<string, string> = {
  unknown_path: "",
  subpath_forbidden: "",
  method_not_allowed: "",
  content_type_invalid: "",
  missing_conversation_id: "",
  session_not_initialized: "conv-never-seeded",
  write_ops_disabled: CONV,
  body_not_object: CONV,
  invalid_json_body: CONV,
};

/** `ToolCallLogInput` 的键集合 —— S4 之前/之后必须完全相同（F14）。 */
const ROW_KEYS = [
  "timestamp",
  "sessionKey",
  "turnSeq",
  "spaceId",
  "userId",
  "teamId",
  "agentId",
  "agentSource",
  "kind",
  "bridgeSource",
  "initiatedTool",
  "executedEndpoint",
  "requestBody",
  "upstreamStatus",
  "elapsedMs",
  "rejectReason",
];

/** `buildToolCallLogRow` 产出的 CH 列集合（camel→snake，逐列取值、不 spread）。 */
const CH_COLUMNS = [
  "timestamp",
  "session_key",
  "turn_seq",
  "space_id",
  "user_id",
  "team_id",
  "agent_id",
  "agent_source",
  "kind",
  "bridge_source",
  "initiated_tool",
  "executed_endpoint",
  "request_body",
  "request_body_hash",
  "upstream_status",
  "elapsed_ms",
  "reject_reason",
  "source_tag",
  "host",
];

function makeFakeRepo(): AttributionEventRepo & { rows: NewAttributionEvent[] } {
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
    listBySessionWithRowid() {
      return [];
    },
    distinctSessionKeys() {
      return [];
    },
  };
}

function makeConfig(over: {
  fetchEvents: boolean;
  storage?: boolean;
  allowLlmWrite?: boolean;
}): ProxyConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.injection.bridgeFetchEvents = { enabled: over.fetchEvents };
  cfg.injection.attributionEvents = { enabled: false };
  cfg.coreSkill.endpoint = "http://core.test";
  cfg.coreSkill.serviceToken = "tok-s4";
  cfg.coreSkill.serviceId = SPACE;
  cfg.skillRuntime.allowLlmWrite = over.allowLlmWrite ?? false;
  if (over.storage) {
    cfg.storage.enabled = true;
    cfg.storage.backend = "memory";
  }
  return cfg;
}

function upstreamOk(): Response {
  return new Response(
    JSON.stringify({
      code: 0,
      data: { skill_id: SKILL_ID, version: VERSION, note: SENTINEL_RESP },
    }),
    { status: 200, headers: { ...JSON_HEADERS } },
  );
}

function makeApp(config: ProxyConfig): Hono {
  const app = new Hono();
  const handler = createSkillBridgeHandler(config, {
    fetcher: (async () => upstreamOk()) as unknown as typeof fetch,
  });
  // 通配到所有路径，让 unknown_path 这类"没进路由规则"的请求也能到 handler。
  app.all("*", (c) => handler(c));
  return app;
}

async function seedSession(): Promise<void> {
  await getSessionStore().set(COMPOSITE, {
    status: "initialized",
    sessionInfo: {
      session_id: CONV,
      user_id: USER,
      team_id: "t-s4",
      agent_id: "ag-s4",
      space_id: SPACE,
      user_key: "uk-s4",
    },
  } as unknown as SessionInitState);
}

function baseInput(over: Partial<BridgeCallTelemetryInput> = {}): BridgeCallTelemetryInput {
  return {
    sessionKey: COMPOSITE,
    spaceId: SPACE,
    userId: USER,
    teamId: "t-s4",
    agentId: "ag-s4",
    agentSource: "codebuddy",
    bridgeSource: "skill-bridge",
    executedEndpoint: "get",
    requestBody: "{}",
    upstreamStatus: 200,
    elapsedMs: 1,
    ...over,
  };
}

beforeEach(() => {
  __resetBridgeTelemetrySinksForTests();
  __resetAttributionEventRepoForTests();
  setAttributionEventRepo(makeFakeRepo());
  __resetProxyStorageForTests();
});

afterEach(() => {
  __resetBridgeTelemetrySinksForTests();
  __resetAttributionEventRepoForTests();
  __resetProxyStorageForTests();
  restoreIsolatedDbPath(); // 73 · C3：delete → 恢复 setup 隔离值（防裸跑回落到默认真库）
  __resetDbForTests();
});

describe("用例 5 · 落行形状（get 成功）", () => {
  it("get ⇒ 恰好 1 行、asset_id=skill_id、payload 逐字段、ctx 不落库", async () => {
    const repo = makeFakeRepo();
    setAttributionEventRepo(repo);
    const config = makeConfig({ fetchEvents: true });
    addBridgeTelemetrySink(createBridgeFetchEventSink());
    await seedSession();
    const app = makeApp(config);

    const res = await app.request("/skill-bridge/v3/skill/get", {
      method: "POST",
      headers: { ...withConv },
      body: GOOD_BODY,
    });

    expect(res.status).toBe(200);
    expect(repo.rows).toHaveLength(1);
    const row = repo.rows[0];

    // 列语义
    expect(row.eventType).toBe("asset_fetched");
    expect(row.assetId).toBe(SKILL_ID); // 验收①：asset_id = skill_id
    expect(row.assetType).toBe("skill");
    expect(row.spaceId).toBe(SPACE);
    expect(row.userId).toBe(USER);
    expect(row.agentSource).toBe("codebuddy");
    // ⚠️ 语义变更声明（2026-09-10，§7.1 归一化）：本行原为 `COMPOSITE`
    // （`codebuddy:conv-s4`）。归一化后 S4 **落 `attribution_events` 的 session_key**
    // 改用裸归因键（与 decision_unit.created 同域）；**CH 埋点键仍是 composite**
    // —— 见用例 11 哨兵 3（若这里与 CH 行一起变了，说明改错了地方）。
    expect(row.sessionKey).toBe(CONV); // 裸归因键，不是 composite
    // 不伪造轮次/单元
    expect(row.turnSeq).toBeNull();
    expect(row.msgSeq).toBeNull();
    expect(row.unitId).toBeNull();

    // payload 形状（§3.1）
    const payload = row.payload as Record<string, unknown>;
    expect(payload.v).toBe(1);
    expect(payload.channel).toBe("fetched"); // 验收①
    expect(payload.bridgeSource).toBe("skill-bridge");
    expect(payload.sub).toBe("get");
    expect(payload.executedEndpoint).toBe("get");
    expect(payload.upstreamStatus).toBe(200);
    expect(payload.rejectReason).toBeNull();
    expect(payload.assetSource).toBe("response");
    expect(payload.version).toBe(VERSION);
    expect(payload.multiAsset).toBe(false);
    expect(payload.elapsedMs).toBeTypeOf("number");

    // 边界 3：ctx 原文（含哨兵）绝不落库
    const serialized = JSON.stringify(repo.rows);
    expect(serialized).not.toContain(SENTINEL_REQ);
    expect(serialized).not.toContain(SENTINEL_RESP);
    expect(serialized).not.toContain(SKILL_ID + SENTINEL_REQ);
  });

  it("memory-bridge 照落行但 asset_id 为 NULL（P2）", () => {
    const repo = makeFakeRepo();
    setAttributionEventRepo(repo);
    addBridgeTelemetrySink(createBridgeFetchEventSink());

    emitBridgeToolCallTelemetry(
      baseInput({
        bridgeSource: "memory-bridge",
        executedEndpoint: "atomic/search",
        inboundBody: { skill_id: SKILL_ID, note: SENTINEL_REQ },
        responseText: JSON.stringify({ code: 0, data: { items: [] } }),
      }),
    );

    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0].assetId).toBeNull();
    expect(repo.rows[0].assetType).toBeNull();
    const payload = repo.rows[0].payload as Record<string, unknown>;
    expect(payload.bridgeSource).toBe("memory-bridge");
    expect(payload.channel).toBe("fetched");
    expect(payload.assetSource).toBeNull();
    expect(payload.multiAsset).toBe(false);
  });

  it("get 但响应无 skill_id ⇒ 回退请求侧并记实 assetSource='request'", () => {
    const repo = makeFakeRepo();
    setAttributionEventRepo(repo);
    addBridgeTelemetrySink(createBridgeFetchEventSink());

    emitBridgeToolCallTelemetry(
      baseInput({
        inboundBody: { skill_id: SKILL_ID },
        responseText: JSON.stringify({ code: 0, data: { version: VERSION } }),
      }),
    );

    const payload = repo.rows[0].payload as Record<string, unknown>;
    expect(repo.rows[0].assetId).toBe(SKILL_ID);
    expect(payload.assetSource).toBe("request");
    expect(payload).not.toHaveProperty("version");
  });

  it("响应缺失（fetch 失败 upstreamStatus=0）⇒ 仍落 1 行、只走请求侧", () => {
    const repo = makeFakeRepo();
    setAttributionEventRepo(repo);
    addBridgeTelemetrySink(createBridgeFetchEventSink());

    emitBridgeToolCallTelemetry(
      baseInput({ upstreamStatus: 0, inboundBody: { skill_id: SKILL_ID } }),
    );

    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0].assetId).toBe(SKILL_ID);
    const payload = repo.rows[0].payload as Record<string, unknown>;
    expect(payload.upstreamStatus).toBe(0);
    expect(payload.assetSource).toBe("request");
  });
});

describe("用例 6 · append-only 不去重（被 pin 住的反例）", () => {
  it("同会话再 get 同一 skill ⇒ 累计 2 行（绝不折叠）", async () => {
    const repo = makeFakeRepo();
    setAttributionEventRepo(repo);
    const config = makeConfig({ fetchEvents: true });
    addBridgeTelemetrySink(createBridgeFetchEventSink());
    await seedSession();
    const app = makeApp(config);

    for (let i = 0; i < 2; i += 1) {
      const res = await app.request("/skill-bridge/v3/skill/get", {
        method: "POST",
        headers: { ...withConv },
        body: GOOD_BODY,
      });
      expect(res.status).toBe(200);
    }

    expect(repo.rows).toHaveLength(2); // 验收②
    expect(repo.rows.map((r) => r.assetId)).toEqual([SKILL_ID, SKILL_ID]);
  });

  it("appends 计数与落行数一致（append-only 的观测面）", () => {
    const repo = makeFakeRepo();
    setAttributionEventRepo(repo);
    addBridgeTelemetrySink(createBridgeFetchEventSink());
    const before = getAttributionWriteCounters().appended;
    emitBridgeToolCallTelemetry(baseInput({ inboundBody: { skill_id: SKILL_ID } }));
    emitBridgeToolCallTelemetry(baseInput({ inboundBody: { skill_id: SKILL_ID } }));
    expect(repo.rows).toHaveLength(2);
    // 假 repo 不走真实计数器，故只断言"没有被去重成 1 行"这个反例本身。
    expect(getAttributionWriteCounters().appended).toBe(before);
  });
});

describe("用例 10 · 结构证据：CH row 与 CH 列都不含 ctx", () => {
  it("② row 键集合与 CH 列集合与 S4 前逐字段相同", () => {
    const captured: ToolCallLogInput[] = [];
    addBridgeTelemetrySink((row) => {
      captured.push(row);
    });

    emitBridgeToolCallTelemetry(
      baseInput({
        inboundBody: { skill_id: SKILL_ID, note: SENTINEL_REQ },
        responseText: JSON.stringify({ code: 0, data: { skill_id: SKILL_ID } }),
      }),
    );

    expect(captured).toHaveLength(1);
    expect(Object.keys(captured[0]).sort()).toEqual([...ROW_KEYS].sort());
    expect(Object.keys(buildToolCallLogRow(captured[0])).sort()).toEqual([...CH_COLUMNS].sort());
    // row 上不存在 ctx 字段（否则说明有人把原文挂进了 CH 契约对象）
    expect(captured[0]).not.toHaveProperty("inboundBody");
    expect(captured[0]).not.toHaveProperty("responseText");
  });

  it("① ctx 只在 sink 内出现；未传 ctx 的调用点得到逐键等价 {} 的 ctx", () => {
    const ctxs: Array<Record<string, unknown>> = [];
    addBridgeTelemetrySink((_row, ctx) => {
      ctxs.push(ctx as unknown as Record<string, unknown>);
    });

    // 4 个 emit 成功路径里的"有响应"形态
    emitBridgeToolCallTelemetry(
      baseInput({ inboundBody: { skill_id: SKILL_ID }, responseText: "{}" }),
    );
    // 17 处 reject 形态（emitBridgeRejectTelemetry 不透传）
    emitBridgeToolCallTelemetry(baseInput());

    expect(Object.keys(ctxs[0]).sort()).toEqual(["inboundBody", "responseText"]);
    expect(ctxs[1]).toEqual({});
  });

  it("③ CH sink 每桥恰好 1 次，且与 sink 链无关（叠加不替换）", () => {
    const ch: ToolCallLogInput[] = [];
    const chSink = (row: ToolCallLogInput) => {
      ch.push(row);
    };

    // 链为空（toggle off 语义）
    emitBridgeToolCallTelemetry(baseInput(), chSink);
    expect(ch).toHaveLength(1);

    // 链上有 sink —— CH 仍恰好再 1 次
    addBridgeTelemetrySink(() => {});
    emitBridgeToolCallTelemetry(baseInput(), chSink);
    expect(ch).toHaveLength(2);
  });
});

describe("用例 4 · sink 链隔离（各自 try/catch）", () => {
  it("CH sink 抛 ⇒ 链上 sink 仍被调用，且 emit 不 throw", () => {
    const seen: ToolCallLogInput[] = [];
    addBridgeTelemetrySink((row) => {
      seen.push(row);
    });

    expect(() =>
      emitBridgeToolCallTelemetry(baseInput(), () => {
        throw new Error("ch down");
      }),
    ).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("链上 sink 抛 ⇒ CH 照常，且不影响链上其它 sink，emit 不 throw", () => {
    const ch: ToolCallLogInput[] = [];
    const after: ToolCallLogInput[] = [];
    addBridgeTelemetrySink(() => {
      throw new Error("sqlite down");
    });
    addBridgeTelemetrySink((row) => {
      after.push(row);
    });

    expect(() =>
      emitBridgeToolCallTelemetry(baseInput(), (row) => {
        ch.push(row);
      }),
    ).not.toThrow();
    expect(ch).toHaveLength(1);
    expect(after).toHaveLength(1); // 前一个 sink 抛不影响后一个
  });

  it("CH 与链上 sink 都抛 ⇒ emit 不 throw（业务永不被埋点拖垮）", () => {
    addBridgeTelemetrySink(() => {
      throw new Error("sqlite down");
    });
    expect(() =>
      emitBridgeToolCallTelemetry(baseInput(), () => {
        throw new Error("ch down");
      }),
    ).not.toThrow();
  });

  it("顺序契约：默认 CH sink 先于链上 sink", () => {
    const order: string[] = [];
    addBridgeTelemetrySink(() => {
      order.push("chain");
    });
    emitBridgeToolCallTelemetry(baseInput(), () => {
      order.push("ch");
    });
    expect(order).toEqual(["ch", "chain"]);
  });
});

describe("用例 7 · toggle off ⇒ 0 新行，CH 通路不变", () => {
  it("未注册 sink（缺省关闭）⇒ handler 照常 200、0 新行", async () => {
    const repo = makeFakeRepo();
    setAttributionEventRepo(repo);
    const config = makeConfig({ fetchEvents: false });
    await seedSession();
    const app = makeApp(config);

    const res = await app.request("/skill-bridge/v3/skill/get", {
      method: "POST",
      headers: { ...withConv },
      body: GOOD_BODY,
    });

    expect(res.status).toBe(200);
    expect(repo.rows).toHaveLength(0); // 验收④
    expect(getAttributionWriteCounters().appended).toBe(0);
  });

  it("开关读的是 config.injection.bridgeFetchEvents.enabled（默认 false）", () => {
    expect(DEFAULT_CONFIG.injection.bridgeFetchEvents?.enabled).toBe(false);
    expect(makeConfig({ fetchEvents: true }).injection.bridgeFetchEvents?.enabled).toBe(true);
  });
});

describe("用例 8 · 9 类 reject 早退全自动覆盖", () => {
  const cases: Array<{
    reason: string;
    expectedStatus: number;
    // Hono 的 `app.request()` 返回 `Response | Promise<Response>`，两个都收。
    send: (app: Hono) => Response | Promise<Response>;
  }> = [
    {
      reason: "unknown_path",
      expectedStatus: 404,
      send: (app) =>
        app.request("/skill-bridge/v3/skill", {
          method: "POST",
          headers: { ...withConv },
          body: GOOD_BODY,
        }),
    },
    {
      reason: "subpath_forbidden",
      expectedStatus: 403,
      send: (app) =>
        app.request("/skill-bridge/v3/skill/_internal/gc", {
          method: "POST",
          headers: { ...withConv },
          body: GOOD_BODY,
        }),
    },
    {
      reason: "method_not_allowed",
      expectedStatus: 405,
      send: (app) => app.request("/skill-bridge/v3/skill/get", { method: "GET" }),
    },
    {
      reason: "content_type_invalid",
      expectedStatus: 415,
      send: (app) =>
        app.request("/skill-bridge/v3/skill/get", {
          method: "POST",
          headers: { "content-type": "text/plain", "x-conversation-id": CONV },
          body: GOOD_BODY,
        }),
    },
    {
      reason: "missing_conversation_id",
      expectedStatus: 401,
      send: (app) =>
        app.request("/skill-bridge/v3/skill/get", {
          method: "POST",
          headers: { ...JSON_HEADERS },
          body: GOOD_BODY,
        }),
    },
    {
      reason: "session_not_initialized",
      expectedStatus: 401,
      send: (app) =>
        app.request("/skill-bridge/v3/skill/get", {
          method: "POST",
          headers: { ...JSON_HEADERS, "x-conversation-id": "conv-never-seeded" },
          body: GOOD_BODY,
        }),
    },
    {
      reason: "write_ops_disabled",
      expectedStatus: 403,
      send: (app) =>
        app.request("/skill-bridge/v3/skill/update", {
          method: "POST",
          headers: { ...withConv },
          body: GOOD_BODY,
        }),
    },
    {
      reason: "body_not_object",
      expectedStatus: 400,
      send: (app) =>
        app.request("/skill-bridge/v3/skill/get", {
          method: "POST",
          headers: { ...withConv },
          body: JSON.stringify([1, 2, 3]),
        }),
    },
    {
      reason: "invalid_json_body",
      expectedStatus: 400,
      send: (app) =>
        app.request("/skill-bridge/v3/skill/get", {
          method: "POST",
          headers: { ...withConv },
          body: "{oops",
        }),
    },
  ];

  it.each(cases)("$reason ⇒ 1 行事实行 + asset_id NULL", async ({ reason, expectedStatus, send }) => {
    const repo = makeFakeRepo();
    setAttributionEventRepo(repo);
    const config = makeConfig({ fetchEvents: true });
    addBridgeTelemetrySink(createBridgeFetchEventSink());
    await seedSession();
    const app = makeApp(config);

    const res = await send(app);
    expect(res.status).toBe(expectedStatus);

    expect(repo.rows).toHaveLength(1); // 验收③
    const row = repo.rows[0];
    // 哨兵 2 · reject 形态零变化（实测钉死；9 类都**不经过** attributionSessionKey
    // ⇒ 形状只有 `""` / 裸键三种，与改动前逐字相同）
    expect(row.sessionKey).toBe(REJECT_SESSION_KEY[reason]);
    expect(row.eventType).toBe("asset_fetched");
    expect(row.assetId).toBeNull();
    expect(row.assetType).toBeNull();
    const payload = row.payload as Record<string, unknown>;
    expect(payload.rejectReason).toBe(reason);
    expect(payload.assetSource).toBeNull();
    expect(payload.channel).toBe("fetched");
    expect(payload.upstreamStatus).toBe(expectedStatus);
  });
});

describe("用例 9 · 落库目标不可用 ⇒ 业务不受影响", () => {
  it("DB 不可用（走真实 Null 实现）⇒ handler 仍 200、0 行、sink 不抛回业务", async () => {
    // 把 PROXY_DB_PATH 指向一个**目录** ⇒ getDb() 返回 null ⇒ getAttributionEventRepo()
    // 走生产代码里真实的 NullAttributionEventRepo 分支（不是测试假实现）。
    process.env.PROXY_DB_PATH = "/tmp";
    __resetDbForTests();
    __resetAttributionEventRepoForTests();
    expect(getDb()).toBeNull();

    const config = makeConfig({ fetchEvents: true });
    addBridgeTelemetrySink(createBridgeFetchEventSink());
    await seedSession();
    const app = makeApp(config);

    const res = await app.request("/skill-bridge/v3/skill/get", {
      method: "POST",
      headers: { ...withConv },
      body: GOOD_BODY,
    });

    expect(res.status).toBe(200);
    expect(getAttributionWriteCounters().appended).toBe(0);
    expect(getAttributionEventRepo().listBySession(CONV)).toEqual([]);
  });
});

describe("用例 3b · 提取器产出与真 pin 落库逐字段一致", () => {
  it("get ⇒ 真 KvVersionPinRepo 读回的 {skillId, version} 与提取器一致", async () => {
    const repo = makeFakeRepo();
    setAttributionEventRepo(repo);
    const config = makeConfig({ fetchEvents: true, storage: true });
    addBridgeTelemetrySink(createBridgeFetchEventSink());
    await seedSession();
    const app = makeApp(config);

    const res = await app.request("/skill-bridge/v3/skill/get", {
      method: "POST",
      headers: { ...withConv },
      body: GOOD_BODY,
    });
    expect(res.status).toBe(200);

    // 真 pin：tryLazyPin 写进 memory storage，再用同一 storage 读回（P4 未改 tryLazyPin）
    const pinRepo = new KvVersionPinRepo(getProxyStorage(config.storage));
    const pinned = await pinRepo.getVersion(SPACE, USER, "codebuddy", CONV, SKILL_ID);

    // 提取器在同一份响应上必须得到同一对 {skillId, version}
    const assets = extractFetchedAssets({
      bridgeSource: "skill-bridge",
      sub: "get",
      inboundBody: { note: SENTINEL_REQ, skill_id: SKILL_ID },
      responseText: JSON.stringify({ code: 0, data: { skill_id: SKILL_ID, version: VERSION } }),
      upstreamStatus: 200,
    });

    expect(pinned).toBe(VERSION); // 真落盘确实发生了（否则 3b 是空断言）
    expect(assets).toHaveLength(1);
    expect(assets[0].assetId).toBe(SKILL_ID);
    expect(assets[0].version).toBe(pinned);
  });

  it("update（WRITE_LOCK_OPS）⇒ upsertVersion 落盘与提取器一致", async () => {
    const repo = makeFakeRepo();
    setAttributionEventRepo(repo);
    const config = makeConfig({ fetchEvents: true, storage: true, allowLlmWrite: true });
    addBridgeTelemetrySink(createBridgeFetchEventSink());
    await seedSession();
    const app = makeApp(config);

    const res = await app.request("/skill-bridge/v3/skill/update", {
      method: "POST",
      headers: { ...withConv },
      body: GOOD_BODY,
    });
    expect(res.status).toBe(200);

    const pinRepo = new KvVersionPinRepo(getProxyStorage(config.storage));
    const pinned = await pinRepo.getVersion(SPACE, USER, "codebuddy", CONV, SKILL_ID);
    const assets = extractFetchedAssets({
      bridgeSource: "skill-bridge",
      sub: "update",
      inboundBody: { note: SENTINEL_REQ, skill_id: SKILL_ID },
      responseText: JSON.stringify({ code: 0, data: { skill_id: SKILL_ID, version: VERSION } }),
      upstreamStatus: 200,
    });

    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0].assetId).toBe(SKILL_ID);
    expect(assets[0].assetId).toBe(SKILL_ID);
    expect(assets[0].version).toBe(pinned);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 用例 11 · §7.1 归一化哨兵（2026-09-10）
//
// 目的：把"fetched 行与 decision_unit.created 行落在同一个 session_key"从
// "看着对"变成"改错了就红"。每条哨兵都带**反向控制**，防止断言恒真。
//
// ⚠️ 证据强度的诚实边界（2026-09-10 补，别把本文件读强了）：
//   本文件的**哨兵 1 是"管道级"**——主链路那一侧的 `sessionKey` 由 `driveMainTurns`
//   **手工喂**字符串（直接调 `runDecisionUnitExtraction`，不经 anthropicHandler）。
//   它证明"两侧口径约定一致"，**证伪不了"主链路退回 composite"**这一类回归
//   （已实测：把 anthropicHandler 的 sessionKey 改成 composite，本文件 31 条**全绿**）。
//   端到端证据在 **`bridge-fetch-events-e2e.test.ts`**（真 createApp + 真 HTTP +
//   生产装配的 sink；同一变异下它会红）。改本文件的人请勿把哨兵 1 的绿当成
//   "主链路已验证对齐"。
// ─────────────────────────────────────────────────────────────────────────────

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

/** 走**真** S3 落 decision_unit.created；sessionKey 复刻主链路的裸值口径。 */
function driveMainTurns(sessionKey: string, agentSource: string): void {
  const shared = {
    config: { injection: { decisionUnitExtractor: { enabled: true } } },
    protocol: "anthropic" as const,
    mainDialog: true,
    hasConversation: true,
    sessionKey,
    spaceId: SPACE,
    userId: USER,
    agentSource,
  };
  runDecisionUnitExtraction({ ...shared, messages: MAIN_TURN_1 });
  runDecisionUnitExtraction({ ...shared, messages: MAIN_TURN_2 });
}

type FakeAttributionRepo = ReturnType<typeof makeFakeRepo>;

/** 按 eventType 取 fake repo 里已落的行（注意：fake 行是 camelCase，不是 DB 行的 snake_case）。 */
function rowsOf(repo: FakeAttributionRepo, eventType: string) {
  return repo.rows.filter((r) => r.eventType === eventType);
}

describe("用例 11 · §7.1 归一化哨兵", () => {
  it("哨兵 1 · 真实抓取与决策单元落在同一个 session_key（并证明断言非恒真）", async () => {
    const repo = makeFakeRepo();
    setAttributionEventRepo(repo);
    __resetDecisionUnitStateForTests();
    addBridgeTelemetrySink(createBridgeFetchEventSink());
    await seedSession();
    const app = makeApp(makeConfig({ fetchEvents: true }));

    // ① 真实抓取（真 handler ⇒ 调用点用 resolveConversationId(c)）
    const res = await app.request("/skill-bridge/v3/skill/get", {
      method: "POST",
      headers: { ...withConv },
      body: GOOD_BODY,
    });
    expect(res.status).toBe(200);
    // ② 真实决策单元落行（同一逻辑会话 + 主链路口径）
    driveMainTurns(CONV, "codebuddy");

    const fetched = new Set(rowsOf(repo, "asset_fetched").map((r) => r.sessionKey));
    const units = new Set(rowsOf(repo, "decision_unit.created").map((r) => r.sessionKey));

    expect(fetched.size).toBe(1);
    expect(units.size).toBe(1); // 归一化的价值：两边各恰好一个（同一）键
    expect([...fetched]).toEqual([...units]); // ← 核心断言（S5 锚定的前提）
    expect([...fetched]).toEqual([CONV]);

    // ③ 反向控制：注入"归一化前"的形态（composite + 不带 attributionSessionKey）
    const oldStyle: string[] = [];
    addBridgeTelemetrySink((row) => {
      oldStyle.push(row.sessionKey);
    });
    emitBridgeToolCallTelemetry(baseInput());
    expect(oldStyle).toEqual([COMPOSITE]);
    expect(new Set(oldStyle)).not.toEqual(units); // ← 旧形态确实 join 不上
  });

  it("哨兵 3 · 归一化只动归因行：CH 行的 session_key 仍是 composite（F14）", async () => {
    const repo = makeFakeRepo();
    setAttributionEventRepo(repo);
    const chRows: ToolCallLogInput[] = [];
    // 观测 emit 传给**所有** sink 的同一个 row 对象 = CH 契约输入
    addBridgeTelemetrySink((row) => {
      chRows.push(row);
    });
    addBridgeTelemetrySink(createBridgeFetchEventSink());
    await seedSession();
    const app = makeApp(makeConfig({ fetchEvents: true }));

    const res = await app.request("/skill-bridge/v3/skill/get", {
      method: "POST",
      headers: { ...withConv },
      body: GOOD_BODY,
    });
    expect(res.status).toBe(200);

    expect(chRows).toHaveLength(1);
    expect(chRows[0].sessionKey).toBe(COMPOSITE); // ← 埋点域契约不变
    expect(buildToolCallLogRow(chRows[0]).session_key).toBe(COMPOSITE);
    expect(rowsOf(repo, "asset_fetched")[0].sessionKey).toBe(CONV); // ← 归因域已归一化
  });

  it("哨兵 4 · ctx 白名单：未传即不出现；传了原样透传（不加工）", () => {
    const ctxs: Array<Record<string, unknown>> = [];
    addBridgeTelemetrySink((_row, ctx) => {
      ctxs.push(ctx as unknown as Record<string, unknown>);
    });

    emitBridgeToolCallTelemetry(baseInput()); // 未传 ⇒ ctx 逐键等价 {}
    emitBridgeToolCallTelemetry(
      baseInput({ inboundBody: { skill_id: SKILL_ID }, attributionSessionKey: CONV }),
    );
    emitBridgeToolCallTelemetry(baseInput({ attributionSessionKey: COMPOSITE }));

    expect(ctxs[0]).toEqual({});
    expect(Object.keys(ctxs[1]).sort()).toEqual(["attributionSessionKey", "inboundBody"]);
    expect(ctxs[2].attributionSessionKey).toBe(COMPOSITE); // 逐字透传（sink 语义中性）
  });

  it("哨兵 5 · 正常路径 agent_source 恒等；跨路径恢复时分裂（证明非恒真）", async () => {
    /**
     * 守卫本体（**唯一一份**）：两侧 `agent_source` 必须相等。
     * ①②两组数据都跑**这一个函数** —— 若有人把守卫改坏（改成恒真），② 的
     * `toThrow` 会失败 ⇒ 守卫自身也具备反向控制（不是"另写一条 not.toBe"那种
     * 抓不到守卫退化 的假控制）。
     */
    const sameAgentSource = (a: NewAttributionEvent, b: NewAttributionEvent): void => {
      expect(a.agentSource).toBe(b.agentSource);
    };

    // ① 正常路径：会话由 codebuddy 建、请求也走 codebuddy
    const repo = makeFakeRepo();
    setAttributionEventRepo(repo);
    __resetDecisionUnitStateForTests();
    addBridgeTelemetrySink(createBridgeFetchEventSink());
    await seedSession();
    const app = makeApp(makeConfig({ fetchEvents: true }));
    await app.request("/skill-bridge/v3/skill/get", {
      method: "POST",
      headers: { ...withConv },
      body: GOOD_BODY,
    });
    driveMainTurns(CONV, "codebuddy");

    const f = rowsOf(repo, "asset_fetched")[0];
    const u = rowsOf(repo, "decision_unit.created")[0];
    expect(f.agentSource).toBe("codebuddy");
    expect(u.agentSource).toBe("codebuddy");
    expect(f.agentSource).toBe(u.agentSource); // ← 恒等

    // ② 反向控制：跨路径恢复 —— 会话由 /claude-code/... 建（L1 key 前缀 claude-code），
    //    当前请求走 skill bridge。用独立 conv id，避开同文件内 seedSession() 残留的键。
    const CONV_X = "conv-x-restore";
    const repoX = makeFakeRepo();
    setAttributionEventRepo(repoX);
    __resetDecisionUnitStateForTests();
    __resetBridgeTelemetrySinksForTests();
    addBridgeTelemetrySink(createBridgeFetchEventSink());
    await getSessionStore().set(`claude-code:${CONV_X}`, {
      status: "initialized",
      sessionInfo: {
        session_id: CONV_X,
        user_id: USER,
        team_id: "t-s4",
        agent_id: "ag-s4",
        space_id: SPACE,
        user_key: "uk-s4",
      },
    } as unknown as SessionInitState);
    const appX = makeApp(makeConfig({ fetchEvents: true }));
    await appX.request("/skill-bridge/v3/skill/get", {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-conversation-id": CONV_X },
      body: GOOD_BODY,
    });
    driveMainTurns(CONV_X, "codebuddy"); // 主链路按**请求路径**取 agent_source

    const fx = rowsOf(repoX, "asset_fetched")[0];
    const ux = rowsOf(repoX, "decision_unit.created")[0];
    expect(fx.agentSource).toBe("claude-code"); // ← 来自会话身份
    expect(ux.agentSource).toBe("codebuddy"); // ← 来自请求路径
    expect(fx.agentSource).not.toBe(ux.agentSource); // ← 恒等不是恒真
  });
});
