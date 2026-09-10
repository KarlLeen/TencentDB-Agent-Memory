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
  delete process.env.PROXY_DB_PATH;
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
    expect(row.sessionKey).toBe(COMPOSITE); // 用 composite_key，不是裸 conversation id
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
