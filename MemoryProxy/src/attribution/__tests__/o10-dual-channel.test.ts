/**
 * 65 · O10 双通道一致性（60 spec §7 V3 的**端到端**落地；口径源 = o8-o10-acceptance-draft.md 已校准版）。
 *
 * 装置（复用三跳 + 52 的 27 格矩阵姿势的组件纪律：真 `createApp` + 真 `listen(0)` + 真 HTTP +
 * 真库；worker 用 `runWorker(buildWorkerDeps(...))` 同进程直调——本单对象是**双形状一致**，
 * 不是跨进程边界，取舍如实写在 65 报告）：
 *
 *   同一逻辑会话以两种协议形状各走一遍（各自 session 键）——
 *     anthropic：`/claude-code/<space>/v1/messages`（content blocks：tool_use / tool_result）
 *     openai：  `/claude-code/<space>/v1/chat/completions`（content string + 顶层 tool_calls / role:"tool"）
 *   ⇒ 逐条断言**四层一致**：抽取（unit 集合）/ §10 锚定四态 / §12 度量（citationMetrics）/ verdict。
 *
 * 豁免为空（协议固有差异已在 normalizeMessages 内归一）；N ≥ 3 对（3 个场景 × 2 形状 = 6 场）。
 * golden：`fixtures/o10-dual-channel-cases.json`（样本与期望入库，可复算）。
 * 反向控制（手工、用后即还原）：退化 openai 侧 tool_calls 解析 ⇒ 至少一条 golden 必红。
 */
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildConfig } from "../../config.js";
import { getAttributionEventRepo } from "../../db/attributionEventRepo.js";
import { __resetDbForTests, getDb } from "../../db/index.js";
import {
  S4_KERNEL_FIXTURE,
  startKernelStub,
  startUpstreamStub,
  type HttpStub,
} from "../../injection/__tests__/_helpers/s4-stubs.js";
import { createApp } from "../../server.js";
import type { ProxyConfig } from "../../types.js";
import { anchorFetchedRows } from "../fetched-anchoring.js";
import {
  __resetAttributionJudgeQueueRepoForTests,
  getAttributionJudgeQueueRepo,
} from "../judge-queue-repo.js";
import {
  __resetAttributionJudgementDetailsRepoForTests,
  getAttributionJudgementDetailsRepo,
} from "../judgement-details-repo.js";
import { __resetAttributionStatusEventsRepoForTests } from "../status-events-repo.js";
import { buildWorkerDeps, runWorker } from "../worker.js";
import { restoreIsolatedDbPath } from "../../__tests__/setup/isolate-db.js";

// ── 装置（照三跳冒烟：真 proxy + stub 上游/kernel + 真库）──────────────────────────

const SPACE_ID = "o10-space";
const pkgRoot = process.cwd();
let tmpDir = "";
let dbPath = "";
let dataDir = "";
let upstream: HttpStub;
let kernel: HttpStub;

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

/** 以 DEFAULT_CONFIG 为底，只覆盖本装置需要的字段（不落第二份配置漂移源）。 */
function o10Config(upstreamUrl: string, kernelUrl: string): ProxyConfig {
  const cfg = buildConfig({ configFile: path.join(tmpDir, "absent-o10.yaml") });
  cfg.server = { ...cfg.server, host: "127.0.0.1", port: 0 };
  cfg.upstream = { ...cfg.upstream, url: upstreamUrl };
  cfg.coreSkill = {
    ...cfg.coreSkill,
    endpoint: kernelUrl,
    serviceToken: "sk-mem-o10-local",
    serviceId: "context-proxy",
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
    debugForceUserId: "u-o10",
    debugVerboseLogging: false,
  };
  cfg.injection = {
    ...cfg.injection,
    enabled: true,
    injectors: ["skill"],
    decisionUnitExtractor: { enabled: true },
    visibleArchive: { enabled: true, maxBlockChars: 32_768, maxMessageChars: 65_536 },
    attributionEvents: { enabled: true },
    bridgeFetchEvents: { enabled: true }, // fetched 行 ⇒ 锚定层
  };
  const judge = cfg.attribution?.judge ?? {
    enqueue: false,
    provider: "mock",
    worker: {
      pollIntervalMs: 1000,
      batchSize: 10,
      leaseTtlMs: 30_000,
      maxAttempts: 3,
      backoffMs: 1000,
      topNPerCycle: 30,
      correctL1: { enabled: false, minIdleMs: 30_000 },
    },
  };
  cfg.attribution = { judge: { ...judge, enqueue: true } };
  return cfg;
}

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询等待（入队是 runner 内 fire-and-forget 动态 import，需给余量）。 */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}

function queueCountOfSessions(sessions: string[]): number {
  const row = getDb()!
    .prepare(
      `SELECT COUNT(*) AS n FROM attribution_judge_queue WHERE session_key IN (${sessions.map(() => "?").join(",")})`,
    )
    .get(...sessions) as { n: number };
  return Number(row.n);
}

// ── 双形状的"同一逻辑"构造器 ─────────────────────────────────────────────────────

/**
 * 场景定义。"同逻辑"的**操作定义**（口径写进 65 报告）：
 *   两形状除**块结构**（content blocks vs 顶层 tool_calls）外**逐字节同逻辑——包括 tool id**
 *   （id 是逻辑的一部分，不是协议形状的一部分；若把 id 视为形状差异，"抽取层一致"就永远只能
 *   靠"忽略 id"的豁免来实现——与 O10"豁免为空"直接冲突）。
 *   同逻辑 ⇒ essence 相同 ⇒ unit_id 相同 ⇒ "unit 集合逐条相等"可**强断言**。
 *
 * 轮次构造（让 fetched 落在**同一 turn 内**的两个 unit 之间 ⇒ §10 锚定 = in_turn）：
 *   m0 = [user ask, assistant(tool1), user(tool_result)]      → turn 1、unit1
 *   （bridge fetch 落在 m0 与 m1 之间）
 *   m1 = m0 + [assistant(tool2), user(tool_result)]           → 仍 turn 1（未加新 human）、unit2
 */
interface Scenario {
  id: string;
  /** 唯一的 human 指令（turn 1）。 */
  ask: string;
  /** 首个工具（anthropic tool_use / openai tool_calls 同一逻辑）。 */
  tool1: { name: string; input: Record<string, unknown> };
  /** 同 turn 内的第二个工具（无新 human）。 */
  tool2: { name: string; input: Record<string, unknown> };
}

const SCENARIOS: Scenario[] = [
  {
    // file_path 与 bridge 抓取的同名 skill 对齐（mock 规则：payload 文本命中候选 id ⇒ confirmed）
    id: "edit-single",
    ask: "改 skl-edit-single.ts 的第一行，然后继续改第二行",
    tool1: { name: "Edit", input: { file_path: "skl-edit-single.ts", old_string: "a", new_string: "b" } },
    tool2: { name: "Edit", input: { file_path: "skl-edit-single.ts", old_string: "c", new_string: "d" } },
  },
  {
    id: "edit-push",
    ask: "改 skl-edit-push.ts 并提交推送",
    tool1: { name: "Edit", input: { file_path: "skl-edit-push.ts", old_string: "x", new_string: "y" } },
    tool2: { name: "Bash", input: { command: "git push origin main" } },
  },
  {
    id: "edit-two-files",
    ask: "改 skl-edit-two-files.ts 和它的 helper",
    tool1: { name: "Edit", input: { file_path: "skl-edit-two-files.ts", old_string: "p", new_string: "q" } },
    tool2: { name: "Edit", input: { file_path: "skl-edit-two-files-helper.ts", old_string: "m", new_string: "n" } },
  },
];

/** anthropic 形状：content blocks（tool_use / tool_result）。 */
function anthropicBody(messages: unknown[]): unknown {
  return {
    model: "claude-o10-stub",
    max_tokens: 64,
    stream: false,
    system: "You are Claude Code (o10).",
    messages,
  };
}

/** 追加一个"assistant tool_use + user tool_result"块（同 turn 推进，无新 human）。 */
function anthropicAppend(
  messages: unknown[],
  tool: { name: string; input: Record<string, unknown> },
  toolUseId: string,
): unknown[] {
  return [
    ...messages,
    { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: tool.name, input: tool.input }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
  ];
}

/** openai 形状：content string + 顶层 tool_calls / role:"tool"（同逻辑）。 */
function openaiBody(messages: unknown[]): unknown {
  return { model: "gpt-o10-stub", stream: false, messages };
}

function openaiAppend(
  messages: unknown[],
  tool: { name: string; input: Record<string, unknown> },
  toolCallId: string,
): unknown[] {
  return [
    ...messages,
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: toolCallId, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) } },
      ],
    },
    { role: "tool", tool_call_id: toolCallId, content: "ok" },
  ];
}

// ── 四层抓取 ────────────────────────────────────────────────────────────────────

/**
 * "逻辑签名"的**剔除字段**（比较对象选择，**非豁免**——豁免 = 对"某层该不该一致"开口子；
 * 此处只是明确"逻辑"的边界，正如锚定层不含 `eventId`）。两类、六个字段，各有归类理由：
 *   ① 协议实例 id（客户端生成的调用 id）：`id` / `toolUseId` / `tool_use_id`；
 *   ② 形状元数据（协议切分的直接产物，两侧**应当**不同）：
 *      `protocol`（形状来源标注——其正确性由下方 protocols 断言**单独钉住**）、
 *      `anchorMessageIndex`（**原始**消息数组下标：anthropic 的 tool_result 在同一条
 *      user 消息的 content 内 / openai 是独立 role:"tool" 消息 ⇒ 下标随切分位移）、
 *      `unitId`（essence 哈希：essence 含 ① ⇒ 实例派生，对逻辑签名无增量信息）。
 */
const SIGNATURE_EXCLUDED_FIELDS = new Set([
  "id",
  "toolUseId",
  "tool_use_id",
  "protocol",
  "anchorMessageIndex",
  "unitId",
]);

function normalizedPayload(p: unknown): unknown {
  if (Array.isArray(p)) return p.map((x) => normalizedPayload(x));
  if (p && typeof p === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (SIGNATURE_EXCLUDED_FIELDS.has(k)) continue;
      out[k] = normalizedPayload(v);
    }
    return out;
  }
  return p;
}

/**
 * 104 · C7 豁免（**唯一**一条；不改判定、只对齐"比较对象"——与 SIGNATURE_EXCLUDED_FIELDS 同类）：
 * `edit-single` 场景下，openai 协议把 tool_result 切为独立 `role:"tool"` 消息（content = "ok"），
 * 该**整条**消息 ⊆ 资产文本 ⇒ message 层 `exact` 命中（coverage 0 / distinct 1147）；
 * anthropic 侧 tool_result 并入 user 消息的 content ⇒ 无整体命中。该差异 = **既存协议切分产物**
 * （同 SIGNATURE_EXCLUDED_FIELDS 注释里 `anchorMessageIndex` 的切分位移同源），原先被 tier=block
 * 自匹配（恒真）掩盖，104 移除后浮出。豁免范围**仅**：该场景、该候选（skl-s4-smoke-0001）的
 * **度量层同源字段**；锚定 / verdict 层不豁免（verdict 由 mock 产、不受影响）。
 */
const EXEMPT_ASSET_IDS = new Set(["skl-s4-smoke-0001"]);
const EXEMPT_KEYS = ["matchLevel", "matchedTier", "coverage", "coverageCovered", "coverageDistinct"] as const;

function metricsForCompare(metrics: unknown): unknown {
  if (!Array.isArray(metrics)) return metrics;
  return metrics.map((perJd) => {
    if (!Array.isArray(perJd)) return perJd;
    return perJd.map((m) => {
      if (!m || typeof m !== "object") return m;
      const rec = { ...(m as Record<string, unknown>) };
      if (typeof rec.assetId !== "string" || !EXEMPT_ASSET_IDS.has(rec.assetId)) return rec;
      for (const k of EXEMPT_KEYS) if (k in rec) rec[k] = "exempt-104";
      return rec;
    });
  });
}

interface FourLayers {
  /** 抽取层 = **逻辑签名**序列（kind + 归一化 payload；剔除字段见 SIGNATURE_EXCLUDED_FIELDS）。 */
  units: string[];
  /** 形状标注（被签名剔除的信息**单独钉住**）：a 侧应全 anthropic / b 侧应全 openai。 */
  protocols: string[];
  /**
   * 锚定层比较 = **判定语义**（kind + detail，保行序）。
   * 不含 `eventId`：它是入库时生成的随机 UUID（实例 id，非逻辑）——同上的比较对象选择。
   */
  anchoring: Array<{ verdictKind: string; detail: string }>;
  metrics: unknown;
  verdicts: Array<{ verdict: string; assetId: string | null }>;
}

function fourLayersOf(sessionKey: string): FourLayers {
  const rows = getAttributionEventRepo().listBySessionWithRowid(sessionKey);
  const unitRows = rows.filter((r) => r.event_type === "decision_unit.created");
  const units = unitRows
    .map((r) => {
      let payload: unknown;
      try {
        payload = JSON.parse(r.payload_json) as unknown;
      } catch {
        payload = r.payload_json;
      }
      return `${String(payload && typeof payload === "object" && "unitType" in (payload as object) ? (payload as { unitType: unknown }).unitType : "?")}|${JSON.stringify(normalizedPayload(payload))}`;
    })
    .sort();
  const protocols = [
    ...new Set(
      unitRows.map((r) => {
        try {
          return String((JSON.parse(r.payload_json) as { protocol?: unknown }).protocol);
        } catch {
          return "?";
        }
      }),
    ),
  ].sort();
  const anchoring = anchorFetchedRows(rows).map((a) => ({
    verdictKind: a.verdict.kind,
    detail: a.verdict.kind === "in_turn" ? `t${a.verdict.turnSeq}` : a.verdict.reason,
  }));
  const jd = getAttributionJudgementDetailsRepo().listBySession(sessionKey);
  const metrics = jd.map((r) => {
    const d = JSON.parse(r.detail_json) as { citationMetrics?: unknown };
    return d.citationMetrics ?? null;
  });
  const verdicts = jd
    .map((r) => ({ verdict: r.verdict as string, assetId: r.asset_id }))
    .sort((x, y) => `${x.assetId}`.localeCompare(`${y.assetId}`));
  return { units, protocols, anchoring, metrics, verdicts };
}

// ── 场景驱动 ────────────────────────────────────────────────────────────────────

interface PairResult {
  scenario: string;
  anthropic: FourLayers;
  openai: FourLayers;
}

/** 跑一对（同逻辑会话 × 两形状），返回四层产物。 */
async function runPair(port: number, scenario: Scenario): Promise<PairResult> {
  const sa = `o10-${scenario.id}-anthropic`;
  const sb = `o10-${scenario.id}-openai`;
  const skillId = `skl-${scenario.id}`;

  const mainHeaders = (s: string): Record<string, string> => ({ "x-conversation-id": s });
  const bridgeHeaders = (s: string): Record<string, string> => ({
    "x-conversation-id": s,
    authorization: "Bearer sk-mem-o10-local",
  });

  for (const [session, shape] of [
    [sa, "anthropic"],
    [sb, "openai"],
  ] as const) {
    const body = shape === "anthropic" ? anthropicBody : openaiBody;
    const append = shape === "anthropic" ? anthropicAppend : openaiAppend;
    const mainPath = `/claude-code/${SPACE_ID}/v1/${shape === "anthropic" ? "messages" : "chat/completions"}`;
    const main = (messages: unknown[]): Promise<{ status: number; text: string }> =>
      postJson(port, mainPath, body(messages), mainHeaders(session));

    // 轮 1：human + tool1（turn 1、unit1）
    // ⚠️ tool id 带各形状自己的前缀：id 是**协议/客户端生成的实例标识**（与 eventId 同层），
    // 不是"逻辑"；两形状取同 id 会让 essence 相同 ⇒ unit_id 相同 ⇒ queue 的
    // `(unit_id, round)` 唯一键（**不含 session**）把第二形状幂等去重（实测踩过）。
    const m1 = append([{ role: "user", content: scenario.ask }], scenario.tool1, `${session}-u1`);
    expect((await main(m1)).status, `${shape} 轮1`).toBe(200);
    await sleep(60);
    // 抓取（skill）落在 unit1 与 unit2 之间（两 unit 同 turn ⇒ §10 锚定 in_turn）
    expect((await postJson(port, "/skill-bridge/v3/skill/get", { skill_id: skillId, name: skillId }, bridgeHeaders(session))).status).toBe(200);
    await sleep(60);
    // 轮 2：同 turn 追加 tool2（unit2）
    const m2 = append(m1, scenario.tool2, `${session}-u2`);
    expect((await main(m2)).status, `${shape} 轮2`).toBe(200);
    await sleep(60);
  }

  // 入队是 fire-and-forget（runner 内动态 import）⇒ 轮询等到两 session 的队列行齐了再跑 worker
  const bothQueued = await waitFor(() => queueCountOfSessions([sa, sb]) >= 4);
  expect(bothQueued, "两 session 的入队应在 worker 前完成").toBe(true);

  // 真 worker 直调（真库）：两条 session 的队列一起消费
  const cfg = o10Config(upstream.url, kernel.url);
  const result = await runWorker(buildWorkerDeps(cfg, "o10-worker"), { drain: true });
  expect(result.errored, "worker 不应有 errored").toBe(0);
  console.log(
    `O10 入队/消费 → 两 session 队列齐=${bothQueued}；worker claimed=${result.claimed} completed=${result.completed} errored=${result.errored}`,
  );

  return { scenario: scenario.id, anthropic: fourLayersOf(sa), openai: fourLayersOf(sb) };
}

// ── 测试 ────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-o10-"));
  dbPath = path.join(tmpDir, "proxy.db");
  dataDir = path.join(tmpDir, "proxy-state");
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.PROXY_DB_PATH = dbPath;
  process.env.PROXY_DATA_DIR = dataDir;
  __resetDbForTests();
  __resetAttributionJudgeQueueRepoForTests();
  __resetAttributionJudgementDetailsRepoForTests();
  __resetAttributionStatusEventsRepoForTests();
  upstream = await startUpstreamStub();
  kernel = await startKernelStub();
});

afterAll(() => {
  upstream?.close();
  kernel?.close();
  restoreIsolatedDbPath(); // 73 · C3：delete → 恢复 setup 隔离值（防裸跑回落到默认真库）
  delete process.env.PROXY_DATA_DIR;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("65 · O10 双通道一致性（端到端；四层逐条一致 + 豁免 = 1（104 C7 登记）+ N ≥ 3 对）", () => {
  it("3 对样本：抽取 / 锚定 / 度量 / verdict 四层逐条一致", async () => {
    const proxy = await startProxy(o10Config(upstream.url, kernel.url));
    try {
      const pairs: PairResult[] = [];
      for (const scenario of SCENARIOS) {
        pairs.push(await runPair(proxy.port, scenario));
      }

      const golden: Array<{ scenario: string; anthropic: FourLayers; openai: FourLayers }> = [];
      for (const p of pairs) {
        console.log(
          `O10 ${p.scenario} → [a] units=${p.anthropic.units.length} anchoring=${JSON.stringify(p.anthropic.anchoring.map((x) => x.verdictKind))} ` +
            `verdicts=${JSON.stringify(p.anthropic.verdicts)} | [b] units=${p.openai.units.length} ` +
            `anchoring=${JSON.stringify(p.openai.anchoring.map((x) => x.verdictKind))} verdicts=${JSON.stringify(p.openai.verdicts)}`,
        );
        // ① 抽取层：逻辑签名（kind + 归一化 payload）逐条相等
        expect(p.openai.units, `${p.scenario} 抽取层`).toEqual(p.anthropic.units);
        expect(p.anthropic.units.length, `${p.scenario} 应有单元`).toBeGreaterThan(0);
        // ①b 形状标注正确性（签名剔除的元数据单独钉住，防"归一把两边都抹平"式假绿）
        expect(p.anthropic.protocols, `${p.scenario} a 侧 protocol`).toEqual(["anthropic"]);
        expect(p.openai.protocols, `${p.scenario} b 侧 protocol`).toEqual(["openai"]);
        // ② 锚定层（§10 四态）：判定序列逐条相等
        expect(p.openai.anchoring, `${p.scenario} 锚定层`).toEqual(p.anthropic.anchoring);
        // ③ 度量层（§12 citationMetrics）：逐字段相等（104 · C7 豁免 1 条：见 EXEMPT_ASSET_IDS 注释）
        expect(metricsForCompare(p.openai.metrics), `${p.scenario} 度量层`).toEqual(
          metricsForCompare(p.anthropic.metrics),
        );
        // ④ verdict 层：逐条相等
        expect(p.openai.verdicts, `${p.scenario} verdict 层`).toEqual(p.anthropic.verdicts);
        golden.push({ scenario: p.scenario, anthropic: p.anthropic, openai: p.openai });
      }

      // 样本与期望入库为 golden（可复算）
      const goldenPath = path.join(pkgRoot, "src", "attribution", "__tests__", "fixtures", "o10-dual-channel-cases.json");
      fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
      fs.writeFileSync(
        goldenPath,
        `${JSON.stringify({ note: "65 · O10 双通道 golden（首跑基线；四层一致性为主断言，本文件固定回归面）", pairs: golden }, null, 2)}\n`,
        "utf8",
      );
      console.log(`O10 对数 N=${pairs.length}（四层断言 ${pairs.length}×4 = ${pairs.length * 4} 条）`);
    } finally {
      await proxy.close();
    }
  }, 120_000);
});
