/**
 * 基座 三跳冒烟（design §4.7 总开关 + §9 ⑦ / checklist §6 步 1–6）。
 *
 * 三跳 = ①真 proxy 收请求并归档 → ②决策单元落库并入队 → ③**真 worker 进程**消费出落点。
 *
 * 与既有装置的分工：
 *   - goldens（visible-archive-golden / render-golden）验"合并点等价层"；
 *   - S4a/S4b 冒烟验"上报面 vs 归档面"（接缝 A/B）；
 *   - **本装置只验基座的跨进程闭环**：入队（proxy 侧）↔ 消费（worker 侧）是否真的咬合
 *     —— 这一层两块 golden 都覆盖不到（它们都不跑 worker）。
 *
 * 诚实边界：
 *   - proxy 用 `createApp` + 真 loopback listen（与 S4a 同口径，仓内既有"真链路"惯例）；
 *     **worker 是真子进程**（`node --import tsx/esm src/attribution/worker.ts --once`），
 *     跨进程边界（同一 SQLite 文件、两个进程）就是本装置要验的东西。
 *   - judge 是 `mock`（本期唯一实现）：本装置验的是**落点形状与幂等**，
 *     不验任何"归因正确性"（基座只出度量，判定属 50 spec）。
 */
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildConfig } from "../../config.js";
import { getAttributionEventRepo } from "../../db/attributionEventRepo.js";
import { __resetDbForTests } from "../../db/index.js";
import { __resetVisibleTextRepoForTests, getVisibleTextRepo } from "../../db/visibleTextRepo.js";
import { __resetDecisionUnitStateForTests } from "../../decision-units/decision-unit-runner.js";
import { __resetInjectionPipelineForTests } from "../../injection/index.js";
import {
  S4_KERNEL_FIXTURE,
  startKernelStub,
  startUpstreamStub,
  type HttpStub,
} from "../../injection/__tests__/_helpers/s4-stubs.js";
import { __resetSessionContextWarnState } from "../../session/context-injector.js";
import { __resetSessionStoreForTests } from "../../session/store.js";
import { createApp } from "../../server.js";
import type { ProxyConfig } from "../../types.js";
import {
  __resetAttributionJudgeQueueRepoForTests,
  getAttributionJudgeQueueRepo,
} from "../judge-queue-repo.js";
import {
  __resetAttributionJudgementDetailsRepoForTests,
  getAttributionJudgementDetailsRepo,
} from "../judgement-details-repo.js";
import {
  __resetAttributionStatusEventsRepoForTests,
  getAttributionStatusEventsRepo,
} from "../status-events-repo.js";
import { ATTRIBUTION_JUDGE_PROMPT_V1, sha256Hex } from "../prompts/judge-prompt.js";

// ── fixtures ────────────────────────────────────────────────────────────────────

const SPACE_ID = "sp-base-3hop";
const POS_SESSION = "base-3hop-pos";
const NEG_SESSION = "base-3hop-neg";

const SESSION_HEADERS = (session: string): Record<string, string> => ({
  "x-claude-code-session-id": session,
  authorization: "Bearer sk-mem-base-local",
});

/**
 * 一条 restraint 消息序列：uText → aTool(Edit) → uResult ⇒ **恰好密封 1 个单元**。
 * 口径与 `enqueue-wiring.test.ts` 的 RESTRAINT_MESSAGES 逐字一致（不造第二份装置口径）。
 */
const RESTRAINT_MESSAGES: unknown[] = [
  { role: "user", content: "给 a.ts 加个函数" },
  { role: "assistant", content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "a.ts" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] },
];

const ANTHROPIC_BODY = (): unknown => ({
  model: "claude-base-3hop-stub",
  max_tokens: 64,
  stream: false,
  system: "You are Claude Code (base-3hop).",
  messages: RESTRAINT_MESSAGES,
});

// ── 环境 / 装配 ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;
let dataDir: string;
let workerConfigPath: string;
let upstream: HttpStub;
let kernel: HttpStub;
/** enqueue=true：靶单元必须入队。 */
let proxyPos: StartedProxy;
/** enqueue=false：入队侧零访问（C2 负例 pin）。 */
let proxyNeg: StartedProxy;

interface StartedProxy {
  port: number;
  close(): Promise<void>;
}

const pkgRoot = process.cwd();

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
 * 以真实 `buildConfig` 的 DEFAULT_CONFIG 为底，只覆盖本冒烟需要的字段
 * （不落第二份配置漂移源；形状与 S4a 的 s4Config 同源，差别只在 injectors/attribution）。
 */
function baseConfig(upstreamUrl: string, kernelUrl: string, injectors: string[], enqueue: boolean): ProxyConfig {
  const cfg = buildConfig({ configFile: path.join(tmpDir, "absent-base-3hop.yaml") });

  cfg.server = { ...cfg.server, host: "127.0.0.1", port: 0 };
  cfg.upstream = { ...cfg.upstream, url: upstreamUrl };
  cfg.coreSkill = {
    ...cfg.coreSkill,
    endpoint: kernelUrl,
    serviceToken: "sk-mem-base-local",
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
    debugForceUserId: "u-base-3hop",
    debugVerboseLogging: false,
  };
  cfg.injection = {
    ...cfg.injection,
    enabled: true,
    injectors,
    // 档② 的调用点守卫读的就是 decisionUnitExtractor.enabled（不打开则档② 一次都不写）。
    decisionUnitExtractor: { enabled: true },
    visibleArchive: { enabled: true, maxBlockChars: 32_768, maxMessageChars: 65_536 },
    // S2 事件打开 ⇒ 单元 payload 里才有 visibleAssets（C3"含 visibleAssets"的因）。
    attributionEvents: { enabled: true },
  };
  const judge = cfg.attribution?.judge ?? {
    enqueue: false,
    provider: "mock",
    worker: { pollIntervalMs: 1000, batchSize: 10, leaseTtlMs: 30_000, maxAttempts: 3, backoffMs: 1000 },
  };
  cfg.attribution = { judge: { ...judge, enqueue } };
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

/** 入队是 handler 内同步完成的；给出余量只为规避调度抖动。 */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}

function queueRows(status: "pending" | "processing" | "done" | "failed", sessionKey: string) {
  return getAttributionJudgeQueueRepo()
    .listByStatus(status)
    .filter((r) => r.session_key === sessionKey);
}

interface WorkerRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** 真 worker 子进程（`--once`）：跨进程边界的唯一入口。configPath 缺省 = mock 配置。 */
function runWorkerOnce(configPath?: string): WorkerRun {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", path.join(pkgRoot, "src/attribution/worker.ts"), "--once", "--config", configPath ?? workerConfigPath],
    {
      cwd: pkgRoot,
      env: { ...process.env, PROXY_DB_PATH: dbPath, PROXY_DATA_DIR: dataDir },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  return { status: res.status, signal: res.signal, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * 读引用式日志（C9 取证）。FileLogger 行格式 = `[ISO][LEVEL] attribution_judge {json}`
 * （file-logger.ts:141-155，键已排序）⇒ 从第一个 `{` 起切。
 * 子进程退出前会 flush（worker 的 shutdown），所以 `spawnSync` 返回后即可读。
 */
function readJudgeLogRecords(): Array<Record<string, unknown>> {
  const file = path.join(dataDir, "attribution-judge.log");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l.slice(l.indexOf("{"))) as Record<string, unknown>);
}

beforeAll(async () => {
  expect(fs.existsSync(path.join(pkgRoot, "package.json")), `cwd 不是包根：${pkgRoot}`).toBe(true);

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-base-3hop-"));
  dbPath = path.join(tmpDir, "proxy.db");
  dataDir = path.join(tmpDir, "proxy-state");
  process.env.PROXY_DB_PATH = dbPath;
  process.env.PROXY_DATA_DIR = dataDir;

  // worker 子进程只关心 judge 实现（proxy 侧 enqueue 与之无关）。
  workerConfigPath = path.join(tmpDir, "worker.yaml");
  fs.writeFileSync(workerConfigPath, "attribution:\n  judge:\n    provider: mock\n", "utf8");

  upstream = await startUpstreamStub();
  kernel = await startKernelStub();

  __resetVisibleTextRepoForTests();
  __resetDbForTests();
  __resetSessionStoreForTests();
  __resetInjectionPipelineForTests();
  __resetSessionContextWarnState();
  __resetDecisionUnitStateForTests();
  __resetAttributionJudgeQueueRepoForTests();
  __resetAttributionJudgementDetailsRepoForTests();
  __resetAttributionStatusEventsRepoForTests();

  // injectors=["skill"] + kernel stub ⇒ 真的产渲染块（S4b 已证），从而有 visibleAssets。
  proxyPos = await startProxy(baseConfig(upstream.url, kernel.url, ["skill"], true));
  proxyNeg = await startProxy(baseConfig(upstream.url, kernel.url, ["skill"], false));

  expect(
    getVisibleTextRepo().constructor.name,
    "落到了 Null 实现 ⇒ 归档静默降级，本冒烟无意义",
  ).toContain("Sqlite");

  const pos = await postJson(
    proxyPos.port,
    `/claude-code/${SPACE_ID}/v1/messages`,
    ANTHROPIC_BODY(),
    SESSION_HEADERS(POS_SESSION),
  );
  expect(pos.status, `正向请求未打通：${pos.text.slice(0, 200)}`).toBe(200);
  expect(await waitFor(() => queueRows("pending", POS_SESSION).length > 0), "靶单元未入队").toBe(true);

  const neg = await postJson(
    proxyNeg.port,
    `/claude-code/${SPACE_ID}/v1/messages`,
    ANTHROPIC_BODY(),
    SESSION_HEADERS(NEG_SESSION),
  );
  expect(neg.status).toBe(200);
  await sleep(200);
}, 180_000);

afterAll(async () => {
  await proxyPos?.close();
  await proxyNeg?.close();
  await upstream?.close();
  await kernel?.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

// ── 用例 ────────────────────────────────────────────────────────────────────────

describe("基座三跳冒烟（真 proxy 链路 + 真 worker 子进程）", () => {
  it("跳①+跳②：真请求 ⇒ 档① 归档 ≥1、靶单元入队 ≥1 且 payload 含 visibleAssets", () => {
    // 跳①：档① 真的落了可读正文（不是空块）。
    const blocks = getVisibleTextRepo().listBlockSeen(POS_SESSION);
    expect(blocks.length, "档① 一行都没有 ⇒ 归档面没跑").toBeGreaterThanOrEqual(1);
    expect(blocks.some((b) => b.content_utf8.length > 0), "档① 有行但正文全空").toBe(true);

    // 跳②：靶单元入队。
    const pending = queueRows("pending", POS_SESSION);
    expect(pending.length, "靶单元未入队").toBeGreaterThanOrEqual(1);

    // payload 形状：{kind, payload}，payload.visibleAssets 非空（S2 快照真的带过来了）。
    // S2 正向控制：注入面真的跑过 —— 否则"没有 visibleAssets"无法与"注入面根本没跑"区分。
    const hookDone = getAttributionEventRepo().listBySession(POS_SESSION, {
      eventType: "injection.hook.done",
      limit: 5000,
    });
    expect(hookDone.length, "S2 一条 injection.hook.done 都没有 ⇒ 注入面没跑").toBeGreaterThanOrEqual(1);

    // payload 形状 {kind, payload}：
    //  · kind ∈ 三种单元种类（pin"入队的是单元快照，不是别的产物"）；
    //  · visibleAssets 是 A2 的**可选**字段：runner 只对 `restraint` 合并它，且读不到就**省略**
    //    （decision-unit-runner.ts:163-167 / :116）。本 fixture 锚点是 Edit ⇒ code_change
    //    ⇒ 合法省略，所以这里断言的是**不变量**而不是"必然存在"：
    //      restraint             ⇒ visibleAssets 必须是非空数组；
    //      其他种类 / 字段在场   ⇒ 必须是**非空**数组（读不到就该省略，空数组即违反 A2）。
    //    纯 restraint 侧的证在 `decision-unit-runner.test.ts` 的 A2 用例（不在此重复）。
    const parsed = JSON.parse(pending[0]!.payload_json) as { kind?: unknown; payload?: { visibleAssets?: unknown } };
    expect(["code_change", "key_tool_call", "restraint"], "payload.kind 不是已知单元种类").toContain(parsed.kind);
    expect(parsed.payload, "payload.payload 缺失 ⇒ 入队的不是单元快照").toBeTypeOf("object");
    const visible = parsed.payload?.visibleAssets;
    if (parsed.kind === "restraint" || visible !== undefined) {
      expect(Array.isArray(visible), "visibleAssets 在场却不是数组").toBe(true);
      expect((visible as unknown[]).length, "visibleAssets 是空数组 ⇒ 违反 A2（读不到应省略）").toBeGreaterThan(0);
    }
  });

  it("跳③：真 worker --once ⇒ details 恰好 1 行，judge_impl/prompt_sha256 对得上，队列转 done", () => {
    const before = getAttributionJudgementDetailsRepo().listBySession(POS_SESSION);
    expect(before.length, "worker 之前不该有落点").toBe(0);
    const logsBefore = readJudgeLogRecords();

    const run = runWorkerOnce();
    if (run.status !== 0) {
      throw new Error(`worker --once 退出码 ${run.status}（signal=${run.signal}）\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`);
    }

    const rows = getAttributionJudgementDetailsRepo().listBySession(POS_SESSION);
    expect(rows.length, "details 不是恰好 1 行").toBe(1);
    const row = rows[0]!;
    expect(row.judge_impl).toBe("mock:v1");
    expect(row.prompt_sha256).toBe(sha256Hex(ATTRIBUTION_JUDGE_PROMPT_V1.text));
    // unit_id 必须就是被消费的那条队列行（跨进程认领对得上）。
    const done = queueRows("done", POS_SESSION);
    expect(done.length).toBeGreaterThanOrEqual(1);
    expect(done.some((q) => q.unit_id === row.unit_id)).toBe(true);
    expect(queueRows("pending", POS_SESSION).length, "队列未清空").toBe(0);

    // C9 引用式日志：本次消费恰好 +1 行，且字段最小集齐（只记 id/引用，不记自由文本）。
    const logsAfter = readJudgeLogRecords();
    expect(logsAfter.length, "一次消费应恰好 +1 行引用日志").toBe(logsBefore.length + 1);
    const last = logsAfter[logsAfter.length - 1]!;
    for (const key of [
      "log_id",
      "generation_id",
      "layer",
      "status",
      "prompt_ref",
      "input_refs",
      "output_refs",
      "latency_ms",
    ]) {
      expect(Object.keys(last), `引用日志缺字段 ${key}`).toContain(key);
    }
    expect(last.layer).toBe("attribution_judge");
    expect(last.status).toBe("ok");
    // generation_id ↔ output_refs 对齐（产出即判定明细，judge-log.ts:90-96）。
    expect(last.generation_id).toBe(row.judgement_id);
  });

  it("跳③ 幂等：再跑一次 --once ⇒ 零新增（确定性主键去重，不是重复消费）", () => {
    const before = getAttributionJudgementDetailsRepo().listBySession(POS_SESSION);
    expect(before.length).toBe(1);
    const logsBefore = readJudgeLogRecords();

    const run = runWorkerOnce();
    if (run.status !== 0) {
      throw new Error(`worker --once(2) 退出码 ${run.status}\n--- stderr ---\n${run.stderr}`);
    }

    expect(getAttributionJudgementDetailsRepo().listBySession(POS_SESSION).length).toBe(1);

    // 第二次 --once 连**认领**都发生不了（该行已 done）⇒ 明细零新增、引用日志零新增。
    // 这是"再跑不增行"的**最强**形态：不是"插进去又被去重"，而是**根本没被再消费**。
    // （主键级幂等的正例在 judgement-details-repo.test.ts:41-52 / R2 用例 :66-72；
    //   租约重放路径的 `status="idempotent"` 在 worker.test.ts:174-183。）
    const logsAfter = readJudgeLogRecords();
    expect(logsAfter.length, "done 行不该被再认领 ⇒ 不该有新的消费日志").toBe(logsBefore.length);
  });

  it("C2 负例：enqueue=false ⇒ 入队侧零访问（该会话零入队、零落点，但请求与归档照常）", () => {
    for (const status of ["pending", "processing", "done", "failed"] as const) {
      expect(queueRows(status, NEG_SESSION).length, `enqueue=false 却出现 ${status} 入队`).toBe(0);
    }
    expect(getAttributionJudgementDetailsRepo().listBySession(NEG_SESSION).length).toBe(0);
    // 正向对照：负例会话真的走完了链路（否则"零入队"是假绿）。
    expect(
      getVisibleTextRepo().listBlockSeen(NEG_SESSION).length,
      "负例会话没有归档 ⇒ 请求根本没走通，零入队无意义",
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("56 · T7 证据供给 e2e（真 proxy + 真 worker 子进程 + 真库）", () => {
  it("fetched 资产经 §10 锚定进入 JudgeInput.candidates（观测点 = detail_json.candidateCount / mock verdict）", async () => {
    const T7 = "base-3hop-t7";
    // 本用例需要 fetched 落行 ⇒ 自带开 bridgeFetchEvents 的 proxy（beforeAll 的 proxyPos 缺省关，
    // 不为一个用例改共享装置）。
    const t7Config = baseConfig(upstream.url, kernel.url, ["skill"], true);
    t7Config.injection.bridgeFetchEvents = { enabled: true };
    const proxyT7 = await startProxy(t7Config);
    try {
    const headers = SESSION_HEADERS(T7);
    const bridgeHeaders = { "x-conversation-id": T7, authorization: "Bearer sk-mem-base-local" };
    const body = (messages: unknown[]): unknown => ({
      model: "claude-base-3hop-stub",
      max_tokens: 64,
      stream: false,
      system: "You are Claude Code (base-3hop).",
      messages,
    });
    const H = (text: string): unknown => ({ role: "user", content: text });
    const EDIT = (id: string, file: string): unknown => ({
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Edit", input: { file_path: file } }],
    });
    const RES = (id: string): unknown => ({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
    });
    const main = (messages: unknown[]) =>
      postJson(proxyT7.port, `/claude-code/${SPACE_ID}/v1/messages`, body(messages), headers);
    const fetchSkill = (skillId: string) =>
      postJson(proxyT7.port, "/skill-bridge/v3/skill/get", { skill_id: skillId, name: skillId }, bridgeHeaders);

    // 会话形状：F0 头窗（门控排除）→ u1(turn1) → F1 轮内（进）→ u2(turn1)
    const m0: unknown[] = [H("改 skl-t7-0001.ts")];
    expect((await main(m0)).status).toBe(200);
    await sleep(150);
    expect((await fetchSkill("skl-t7-0000")).status, "F0 抓取未 200").toBe(200);
    await sleep(150);
    const m1: unknown[] = [...m0, EDIT("e1", "skl-t7-0001.ts"), RES("e1")];
    expect((await main(m1)).status).toBe(200);
    await sleep(150);
    expect((await fetchSkill("skl-t7-0001")).status, "F1 抓取未 200").toBe(200);
    await sleep(150);
    const m2: unknown[] = [...m1, EDIT("e2", "b.ts"), RES("e2")];
    expect((await main(m2)).status).toBe(200);
    expect(await waitFor(() => queueRows("pending", T7).length >= 2), "T7 单元未入队").toBe(true);

    const run = runWorkerOnce();
    if (run.status !== 0) {
      throw new Error(`T7 worker --once 退出码 ${run.status}\n--- stderr ---\n${run.stderr}`);
    }

    const rows = getAttributionJudgementDetailsRepo().listBySession(T7);
    expect(rows.length, "u1 + u2 两条判定").toBe(2);
    const u1Row = rows.find((r) => r.verdict === "confirmed");
    expect(u1Row, "u1（payload 文本含 skl-t7-0001 ⇒ mock 命中 confirmed）缺失").toBeDefined();
    expect(u1Row!.asset_id).toBe("skl-t7-0001");
    expect(u1Row!.evidence_source_type, "fetched 路标注落库（硬编码删除的生产侧证据）").toBe("fetched");

    const detail = JSON.parse(u1Row!.detail_json) as {
      candidateCount: number;
      evidenceSupply?: {
        stats: {
          fetchedRows: number;
          fetchedIn: number;
          fetchedExcludedHead: number;
          injectedInHookDone: number;
          injectedInVisibleAssets: number;
        };
        fetchedTurnSeq: number | null;
      };
    };
    const stats = detail.evidenceSupply?.stats;
    const sessionRows = getAttributionEventRepo().listBySession(T7, { limit: 5000 }).length;
    console.log(
      `T7 观测点 → candidateCount=${detail.candidateCount} fetchedIn=${stats?.fetchedIn} hookDoneIn=${stats?.injectedInHookDone} ` +
        `headExcluded=${stats?.fetchedExcludedHead} fetchedTurnSeq=${detail.evidenceSupply?.fetchedTurnSeq} ` +
        `（分母：会话行数=${sessionRows} / fetched=${stats?.fetchedRows} / details=${rows.length}）`,
    );
    // 两路真链路供给：fetched 路 = 仅 F1（F0 被头窗门控排除）；injected 路 = injectors=["skill"]
    // 在 turn1 注入的资产经 hook.done 分支按轮对齐进候选（u1 是 code_change、无 visibleAssets 分支）。
    expect(stats?.fetchedRows).toBe(2); // F0 + F1
    expect(stats?.fetchedIn).toBe(1);
    expect(stats?.fetchedExcludedHead).toBe(1);
    expect(stats?.injectedInHookDone).toBe(1);
    expect(stats?.injectedInVisibleAssets).toBe(0);
    expect(
      detail.candidateCount,
      "candidateCount = fetchedIn(1) + hookDoneIn(1)（双源不同 assetId，无合并）",
    ).toBe((stats?.fetchedIn ?? 0) + (stats?.injectedInHookDone ?? 0));
    expect(detail.evidenceSupply?.fetchedTurnSeq).toBe(1);
    } finally {
      await proxyT7.close();
    }
  }, 60_000);
});

describe("57 · T6 三道机械锚点 e2e（真 proxy + 真 worker 子进程 + 真库）", () => {
  it("judgement detail_json.citationMetrics 存在、形状正确、无布尔（fetched 无文本 ⇒ null；injected 命中 ⇒ 级别+block 层）", async () => {
    const T6 = "base-3hop-t6";
    const t6Config = baseConfig(upstream.url, kernel.url, ["skill"], true);
    t6Config.injection.bridgeFetchEvents = { enabled: true };
    const proxyT6 = await startProxy(t6Config);
    try {
      const headers = SESSION_HEADERS(T6);
      const bridgeHeaders = { "x-conversation-id": T6, authorization: "Bearer sk-mem-base-local" };
      const body = (messages: unknown[]): unknown => ({
        model: "claude-base-3hop-stub",
        max_tokens: 64,
        stream: false,
        system: "You are Claude Code (base-3hop).",
        messages,
      });
      const H = (text: string): unknown => ({ role: "user", content: text });
      const EDIT = (id: string, file: string): unknown => ({
        role: "assistant",
        content: [{ type: "tool_use", id, name: "Edit", input: { file_path: file } }],
      });
      const RES = (id: string): unknown => ({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
      });
      const main = (messages: unknown[]) =>
        postJson(proxyT6.port, `/claude-code/${SPACE_ID}/v1/messages`, body(messages), headers);
      const fetchSkill = (skillId: string) =>
        postJson(proxyT6.port, "/skill-bridge/v3/skill/get", { skill_id: skillId, name: skillId }, bridgeHeaders);

      // 会话形状同 T7：F0 头窗 → u1(turn1) → F1 轮内 → u2(turn1)
      const m0: unknown[] = [H("改 skl-t6-0001.ts")];
      expect((await main(m0)).status).toBe(200);
      await sleep(150);
      expect((await fetchSkill("skl-t6-0000")).status).toBe(200);
      await sleep(150);
      const m1: unknown[] = [...m0, EDIT("e1", "skl-t6-0001.ts"), RES("e1")];
      expect((await main(m1)).status).toBe(200);
      await sleep(150);
      expect((await fetchSkill("skl-t6-0001")).status).toBe(200);
      await sleep(150);
      // ⚠️ u2 的文件名必须与同文件其它用例错开：queue 幂等键 (unit_id, round) 是**内容哈希、
      // 跨会话**——T7 的 u2 也是 Edit("b.ts") ⇒ 同 unitId ⇒ T6 的 u2 会被入队去重吞掉（实测：
      // decision_unit.created=2 而 pending=1）。
      const m2: unknown[] = [...m1, EDIT("e2", "c-t6.ts"), RES("e2")];
      expect((await main(m2)).status).toBe(200);
      const enqueued = await waitFor(() => queueRows("pending", T6).length >= 2);
      if (!enqueued) {
        const evts = getAttributionEventRepo().listBySession(T6, { limit: 5000 });
        const typeCount = new Map<string, number>();
        for (const e of evts) typeCount.set(e.event_type, (typeCount.get(e.event_type) ?? 0) + 1);
        console.log(
          `[T6-diag] events=${evts.length} types=${JSON.stringify([...typeCount])} ` +
            `queue(pending=${queueRows("pending", T6).length},done=${queueRows("done", T6).length},` +
            `failed=${queueRows("failed", T6).length})`,
        );
      }
      expect(enqueued, "T6 单元未入队").toBe(true);

      const run = runWorkerOnce();
      if (run.status !== 0) {
        throw new Error(`T6 worker --once 退出码 ${run.status}\n--- stderr ---\n${run.stderr}`);
      }

      const rows = getAttributionJudgementDetailsRepo().listBySession(T6);
      expect(rows.length).toBe(2);
      const u1Row = rows.find((r) => r.verdict === "confirmed");
      expect(u1Row, "u1 judgement 缺失").toBeDefined();

      interface Metrics {
        assetId: string;
        matchLevel: string | null;
        matchedTier: string | null;
        coverage: number | "unknown";
        coverageDistinct: number;
        coverageCovered: number;
        exclusionCount: number;
        ngramTableSha256: string;
      }
      const detail = JSON.parse(u1Row!.detail_json) as {
        shortlist: { k: number; total: number; overflowCount: number; overflowAssetIds: string[] };
        citationMetrics?: Metrics[];
      };
      expect(detail.shortlist, "shortlist 溢出可观测键").toEqual({
        k: 16,
        total: 2,
        overflowCount: 0,
        overflowAssetIds: [],
      });
      const metrics = detail.citationMetrics;
      expect(metrics, "citationMetrics 缺失（生产 buildWorkerDeps 总装 citationSource）").toBeDefined();
      expect(metrics!.length, "度量只对前 K（2 候选）").toBe(2);

      const fetchedM = metrics!.find((m) => m.assetId === "skl-t6-0001");
      expect(fetchedM, "fetched 候选的度量缺失").toBeDefined();
      expect(fetchedM!.matchLevel, "fetched 资产未注入 ⇒ 档①无其文本 ⇒ null（不猜）").toBe(null);
      expect(fetchedM!.coverage).toBe("unknown");

      const injectedM = metrics!.find((m) => m.assetId !== "skl-t6-0001");
      expect(injectedM, "injected 候选的度量缺失").toBeDefined();
      expect(
        ["exact", "whitespace", "punctuation"],
        "injected 资产原文在窗口 ⇒ 归一化命中（三级之一）",
      ).toContain(injectedM!.matchLevel);
      expect(injectedM!.matchedTier, "注入原文在 block 层").toBe("block");
      expect(typeof injectedM!.ngramTableSha256).toBe("string");

      console.log(
        `T6 观测点 → shortlist=${JSON.stringify(detail.shortlist)} fetchedM=${fetchedM!.matchLevel}/${fetchedM!.coverage} ` +
          `injectedM=${injectedM!.matchLevel}(${injectedM!.matchedTier}) coverage=${injectedM!.coverage} sha=${injectedM!.ngramTableSha256.slice(0, 12)}…`,
      );

      // 零布尔（递归检查两份度量 + shortlist）
      const assertNoBoolean = (v: unknown, p = "root"): void => {
        if (typeof v === "boolean") throw new Error(`布尔出现在 ${p}`);
        if (Array.isArray(v)) v.forEach((x, i) => assertNoBoolean(x, `${p}[${i}]`));
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) assertNoBoolean(x, `${p}.${k}`);
      };
      assertNoBoolean(metrics);
      assertNoBoolean(detail.shortlist);
    } finally {
      await proxyT6.close();
    }
  }, 60_000);
});

describe("58 · T5 mechanical:v1 e2e（真 proxy + 真 worker 子进程（provider=mechanical）+ 真库）", () => {
  it("judgement 的 verdict 由度量规则产出（与手算一致）+ detail_json.citationMetrics 仍在（度量与裁决同源）", async () => {
    const T5 = "base-3hop-t5";
    const t5Config = baseConfig(upstream.url, kernel.url, ["skill"], true);
    t5Config.injection.bridgeFetchEvents = { enabled: true };
    const proxyT5 = await startProxy(t5Config);
    // mechanical 的 worker 配置（provider=mechanical；缺省关闭 ⇒ 必须显式）
    const mechWorkerConfigPath = path.join(tmpDir, "worker-mech.yaml");
    fs.writeFileSync(mechWorkerConfigPath, "attribution:\n  judge:\n    provider: mechanical\n", "utf8");
    try {
      const headers = SESSION_HEADERS(T5);
      const bridgeHeaders = { "x-conversation-id": T5, authorization: "Bearer sk-mem-base-local" };
      const body = (messages: unknown[]): unknown => ({
        model: "claude-base-3hop-stub",
        max_tokens: 64,
        stream: false,
        system: "You are Claude Code (base-3hop).",
        messages,
      });
      const H = (text: string): unknown => ({ role: "user", content: text });
      const EDIT = (id: string, file: string): unknown => ({
        role: "assistant",
        content: [{ type: "tool_use", id, name: "Edit", input: { file_path: file } }],
      });
      const RES = (id: string): unknown => ({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
      });
      const main = (messages: unknown[]) =>
        postJson(proxyT5.port, `/claude-code/${SPACE_ID}/v1/messages`, body(messages), headers);
      const fetchSkill = (skillId: string) =>
        postJson(proxyT5.port, "/skill-bridge/v3/skill/get", { skill_id: skillId, name: skillId }, bridgeHeaders);

      // 会话形状同 T7：F0 头窗 → u1(turn1) → F1 轮内 → u2(turn1)
      const m0: unknown[] = [H("改 skl-t5-f1.ts")];
      expect((await main(m0)).status).toBe(200);
      await sleep(150);
      expect((await fetchSkill("skl-t5-f0")).status).toBe(200);
      await sleep(150);
      const m1: unknown[] = [...m0, EDIT("e1", "skl-t5-f1.ts"), RES("e1")];
      expect((await main(m1)).status).toBe(200);
      await sleep(150);
      expect((await fetchSkill("skl-t5-f1")).status).toBe(200);
      await sleep(150);
      const m2: unknown[] = [...m1, EDIT("e2", "c-t5.ts"), RES("e2")];
      expect((await main(m2)).status).toBe(200);
      expect(await waitFor(() => queueRows("pending", T5).length >= 2), "T5 单元未入队").toBe(true);

      const run = runWorkerOnce(mechWorkerConfigPath);
      if (run.status !== 0) {
        throw new Error(`T5 worker --once 退出码 ${run.status}\n--- stderr ---\n${run.stderr}`);
      }

      const rows = getAttributionJudgementDetailsRepo().listBySession(T5);
      expect(rows.length).toBe(2);
      const u1Row = rows.find((r) => r.verdict === "confirmed");
      expect(u1Row, "u1 应有一条 confirmed（注入资产 exact 命中 + 排他 0）").toBeDefined();
      // 手算一致：fetched skl-t5-f1 无档①文本 ⇒ null ⇒ unconfirmed 候选；
      //           注入资产有档① ⇒ exact 命中 + coverage 高 + 排他 0 ⇒ confirmed 候选 ⇒ 最强归因
      expect(u1Row!.asset_id, "mechanical 应归因到注入资产（不是 mock 的 assetId 文本命中）").toBe(
        "skl-s4-smoke-0001",
      );
      expect(u1Row!.judge_impl).toBe("mechanical:v1");

      const detail = JSON.parse(u1Row!.detail_json) as {
        citationMetrics?: Array<{ assetId: string; matchLevel: string | null; coverage: number | "unknown" }>;
      };
      const metrics = detail.citationMetrics;
      expect(metrics, "citationMetrics 必须仍在（度量与裁决同源，不许两份）").toBeDefined();
      const fetchedM = metrics!.find((m) => m.assetId === "skl-t5-f1");
      const injectedM = metrics!.find((m) => m.assetId === "skl-s4-smoke-0001");
      console.log(
        `T5 观测点 → verdict=${u1Row!.verdict}@${u1Row!.asset_id} impl=${u1Row!.judge_impl} ` +
          `fetchedM=${fetchedM?.matchLevel}/${fetchedM?.coverage} injectedM=${injectedM?.matchLevel}/${injectedM?.coverage}`,
      );
      expect(fetchedM?.matchLevel).toBe(null); // 无档①文本（不猜）
      expect(injectedM?.matchLevel).toBe("exact"); // 注入原文命中 ⇒ confirmed 候选
    } finally {
      await proxyT5.close();
    }
  }, 60_000);
});

describe("59 · T6 asset_used e2e（真 proxy + 真 worker 子进程（mechanical）+ 真库）", () => {
  it("confirmed ⇒ status 行落库、judgement_id 回指可对上（turn/msg NULL）", async () => {
    const T9 = "base-3hop-t9";
    const t9Config = baseConfig(upstream.url, kernel.url, ["skill"], true);
    t9Config.injection.bridgeFetchEvents = { enabled: true };
    const proxyT9 = await startProxy(t9Config);
    const mechWorkerConfigPath = path.join(tmpDir, "worker-mech-t6.yaml");
    fs.writeFileSync(mechWorkerConfigPath, "attribution:\n  judge:\n    provider: mechanical\n", "utf8");
    try {
      const headers = SESSION_HEADERS(T9);
      const bridgeHeaders = { "x-conversation-id": T9, authorization: "Bearer sk-mem-base-local" };
      const body = (messages: unknown[]): unknown => ({
        model: "claude-base-3hop-stub",
        max_tokens: 64,
        stream: false,
        system: "You are Claude Code (base-3hop).",
        messages,
      });
      const H = (text: string): unknown => ({ role: "user", content: text });
      const EDIT = (id: string, file: string): unknown => ({
        role: "assistant",
        content: [{ type: "tool_use", id, name: "Edit", input: { file_path: file } }],
      });
      const RES = (id: string): unknown => ({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
      });
      const main = (messages: unknown[]) =>
        postJson(proxyT9.port, `/claude-code/${SPACE_ID}/v1/messages`, body(messages), headers);
      const fetchSkill = (skillId: string) =>
        postJson(proxyT9.port, "/skill-bridge/v3/skill/get", { skill_id: skillId, name: skillId }, bridgeHeaders);

      const m0: unknown[] = [H("改 skl-t9-f1.ts")];
      expect((await main(m0)).status).toBe(200);
      await sleep(150);
      expect((await fetchSkill("skl-t9-f0")).status).toBe(200);
      await sleep(150);
      const m1: unknown[] = [...m0, EDIT("e1", "skl-t9-f1.ts"), RES("e1")];
      expect((await main(m1)).status).toBe(200);
      await sleep(150);
      expect((await fetchSkill("skl-t9-f1")).status).toBe(200);
      await sleep(150);
      const m2: unknown[] = [...m1, EDIT("e2", "c-t9.ts"), RES("e2")];
      expect((await main(m2)).status).toBe(200);
      expect(await waitFor(() => queueRows("pending", T9).length >= 2), "T9 单元未入队").toBe(true);

      const run = runWorkerOnce(mechWorkerConfigPath);
      if (run.status !== 0) {
        throw new Error(`T9 worker --once 退出码 ${run.status}\n--- stderr ---\n${run.stderr}`);
      }

      const jdRows = getAttributionJudgementDetailsRepo().listBySession(T9);
      expect(jdRows.length).toBe(2);
      const u1Jd = jdRows.find((r) => r.verdict === "confirmed");
      expect(u1Jd, "u1 judgement 应 confirmed（mechanical @ 注入资产）").toBeDefined();

      const statusRows = getAttributionStatusEventsRepo().listByUnit(u1Jd!.unit_id);
      expect(statusRows.length, "confirmed ⇒ 恰好 1 条 asset_used").toBe(1);
      const s = statusRows[0]!;
      const payload = JSON.parse(s.payload_json) as Record<string, unknown>;
      console.log(
        `T9 观测点 → status_id=${s.status_id} event=${s.event_type} asset=${s.asset_id} ` +
          `turn=${s.turn_seq} msg=${s.msg_seq} payload.judgement_id=${payload.judgement_id} ` +
          `（judgement.judgement_id=${u1Jd!.judgement_id}；u1/u2 各 1 行 ⇒ 本会话 status 行数=2）`,
      );
      expect(s.event_type).toBe("asset_used");
      expect(s.asset_id).toBe("skl-s4-smoke-0001");
      expect(s.turn_seq).toBe(null);
      expect(s.msg_seq).toBe(null);
      expect(payload.judgement_id, "回指可对上").toBe(u1Jd!.judgement_id);
      expect(payload.judge_impl).toBe("mechanical:v1");
      expect(payload.verdict).toBe("confirmed");
      // u2 同样是 confirmed（mechanical 的注入资产命中与单元文本无关：注入块恒在窗口）⇒
      // 按**本会话单元维度**断各 1 行；库为跨用例共享，不断全库 count。
      for (const jd of jdRows) {
        expect(
          getAttributionStatusEventsRepo().listByUnit(jd.unit_id).length,
          `unit=${jd.unit_id} 的 status 行数`,
        ).toBe(1);
      }
    } finally {
      await proxyT9.close();
    }
  }, 60_000);
});
