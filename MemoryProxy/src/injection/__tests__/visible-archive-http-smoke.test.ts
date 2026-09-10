/**
 * S4a —— 真链路最小闭环冒烟：真 listen → 真请求 → 上游捕获 rawBody → 与归档重建串硬比对。
 *
 * 与 golden 装置（visible-archive-golden.test.ts）的分工（s4-smoke-design.md §1）：
 *   golden 在"合并点等价层"直接调生产捕获入口，验的是"**如实捕获**"；
 *   本装置起真 proxy、发真 HTTP、把请求真的转发到上游 stub，验的是"**上报面 vs 归档面**"
 *   —— 前者覆盖不到的那一层（接缝 B 在 handler 里被重建/改写/漏调）。
 *
 * 每个用例都同时断言两类证据（§5.3 纪律 2 + §4.2 要点 3）：
 *   正向证据（证明链路真的跑到了）：
 *     P1 `[injection-debug] entering injection pipeline` 行存在（pipeline 真的进来了）
 *     P2 `[injection-debug] initResult ... hasSessionInfo=true hasAgentDetail=true`
 *        （kernel detail 真的拿到了 —— 否则块为空、用例会"完美一致"地假绿）
 *     P3 档① 真的落了 session-context 行，且 content_utf8 非空、含 `<session_context>`
 *     P4 上游 rawBody 里确实含 `<session_context>`
 *   精确断言（§8.3 A 准则）：上游 body 的 system 文本逐字节 == excluded + `\n\n` + 归档块。
 *   辅助投影（§3a D 准则）：stripGlue(上游) == stripGlue(重建)。
 *   无超采（C 准则）：excluded 不入档。
 *
 * 诚实边界（设计侧钉子 2，2026-09-10）：
 *   - **A1/A2/A3 的 `injectors=["knowledge"]` + `knowledge.enabled=false` 只证明两件事**：
 *       ① 注入 gate 确实打开（`injectors.length > 0` 成立、pipeline 真的被进入）；
 *       ② **接缝 B（session-context）逐字节正确**（归档块 === 上游实际注入块）。
 *     它**不证明**真实渲染块能被正确归档 / 注入 —— 注册表为空 ⇒ 本窗口一个渲染块都不产。
 *     **「S4a 全绿」不等于接缝 A 已验**；渲染块的归档 + 注入是 S4b 的活，不要顺带当成已完成。
 *   - 本窗口**不**覆盖接缝 A（渲染块档① hook）的完整归档 —— 那需要真实 injector 产出块。
 *   - 上游 stub 只作捕获，不参与判定；判定全在归档侧（§5.2 纪律 1）。
 */
import fs from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { serve } from "@hono/node-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildConfig } from "../../config.js";
import { __resetDbForTests } from "../../db/index.js";
import {
  __resetVisibleTextRepoForTests,
  getVisibleTextRepo,
  readWatermark,
  type VisibleTextRepo,
} from "../../db/visibleTextRepo.js";
import { __resetSessionContextWarnState } from "../../session/context-injector.js";
import { __resetSessionStoreForTests } from "../../session/store.js";
import { createApp } from "../../server.js";
import type { ProxyConfig } from "../../types.js";
import { __resetInjectionPipelineForTests } from "../index.js";
import {
  SEAM_GLUE,
  rebuildInjectedBodyFromArchive,
  restoredVisibleText,
  stripGlue,
} from "./_helpers/attribution-window.js";
import { KNOWN_DRIFT, KNOWN_DRIFT_LOG_PREFIX } from "./_helpers/known-drift.js";
import {
  S4_KERNEL_FIXTURE,
  startKernelStub,
  startUpstreamStub,
  type HttpStub,
} from "./_helpers/s4-stubs.js";

// ── fixtures ────────────────────────────────────────────────────────────────────

const SPACE_ID = "sp-s4";
const ANTHROPIC_SYSTEM = "You are Claude Code (S4 excluded).";
const OPENAI_SYSTEM = "You are CodeBuddy (S4 excluded).";
const USER_TEXT = "hi from s4";

const SESSION_HEADERS = (session: string): Record<string, string> => ({
  "x-claude-code-session-id": session,
  // 可选：让 kernelUserKey 走"客户端优先"分支（auth 关闭时不参与鉴权，仅影响 header）。
  authorization: "Bearer sk-mem-s4-local",
});

const ANTHROPIC_BODY = (system: unknown) => ({
  model: "claude-s4-stub",
  max_tokens: 64,
  stream: false,
  system,
  messages: [{ role: "user", content: USER_TEXT }],
});

const OPENAI_BODY = () => ({
  model: "gpt-s4-stub",
  stream: false,
  messages: [
    { role: "system", content: OPENAI_SYSTEM },
    { role: "user", content: USER_TEXT },
  ],
});

// ── 环境 / 装配 ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let upstream: HttpStub;
let kernel: HttpStub;
/** injectors 非空（gate 打开，但该 injector 不注册 → 不产块，只验接缝 B）。 */
let proxyA: StartedProxy;
/** injectors 为空（gate 静默关闭 → R3 负例 pin）。 */
let proxyB: StartedProxy;
/**
 * S4b：`injectors=["skill"]` → **真的产渲染块**（接缝 A：`<skill_tools>` + 以
 * `## Skills (mandatory)` 开头的 listing 块 —— **不是** `<available_skills>`，那只是
 * 文档/注释里的旧叫法，块里没有这个标签，见 :623-635 自证）。
 * 与 proxyA 同一份 config 构造函数，只差 injectors —— 避免"第二个配置漂移源"。
 */
let proxyS: StartedProxy;

interface StartedProxy {
  port: number;
  close(): Promise<void>;
}

async function startProxy(config: ProxyConfig): Promise<StartedProxy> {
  const app = createApp(config);
  // 真 loopback 端口：listen(0) 由内核分配，不写死 8096。
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
 * 直接构造 config 对象（不落 yaml 文件）：以真实 buildConfig 的 DEFAULT_CONFIG 为底，
 * 只覆盖 S4a 需要的字段 —— 这样既避免了"第二个配置漂移源"，也保证 ProxyConfig 形状完整。
 */
function s4Config(upstreamUrl: string, kernelUrl: string, injectors: string[]): ProxyConfig {
  const cfg = buildConfig({ configFile: path.join(tmpDir, "absent-s4.yaml") });

  cfg.server = { ...cfg.server, host: "127.0.0.1", port: 0 };
  cfg.upstream = { ...cfg.upstream, url: upstreamUrl };
  cfg.coreSkill = {
    ...cfg.coreSkill,
    endpoint: kernelUrl,
    serviceToken: "sk-mem-s4-local",
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
    debugForceUserId: "u-s4",
    debugVerboseLogging: false,
  };
  cfg.injection = {
    ...cfg.injection,
    enabled: true,
    injectors,
    // 档② 的**调用点**守卫（handler.ts:1114-1149 / anthropicHandler.ts:995-1028）读的是
    // decisionUnitExtractor.enabled —— 不打开它，档② 一次都不会写。
    decisionUnitExtractor: { enabled: true },
    visibleArchive: { enabled: true, maxBlockChars: 32_768, maxMessageChars: 65_536 },
    attributionEvents: { enabled: false },
  };
  return cfg;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-s4-smoke-"));
  process.env.PROXY_DB_PATH = path.join(tmpDir, "proxy.db");
  process.env.PROXY_DATA_DIR = path.join(tmpDir, "proxy-state");

  upstream = await startUpstreamStub();
  kernel = await startKernelStub();

  __resetVisibleTextRepoForTests();
  __resetDbForTests();
  __resetSessionStoreForTests();
  __resetInjectionPipelineForTests();
  __resetSessionContextWarnState();

  proxyA = await startProxy(s4Config(upstream.url, kernel.url, ["knowledge"]));
  proxyB = await startProxy(s4Config(upstream.url, kernel.url, []));
  proxyS = await startProxy(s4Config(upstream.url, kernel.url, ["skill"]));

  // 双保险（§5.4）：必须真的落在 SQLite，而不是 silent 降级到 NullVisibleTextRepo。
  expect(
    getVisibleTextRepo().constructor.name,
    "VisibleTextRepo 未落到 Sqlite（PROXY_DB_PATH / better-sqlite3 不可用）→ 档案永远为空，用例会假绿",
  ).toBe("SqliteVisibleTextRepo");
});

afterAll(async () => {
  await proxyA?.close();
  await proxyB?.close();
  await proxyS?.close();
  await upstream?.close();
  await kernel?.close();
  __resetVisibleTextRepoForTests();
  __resetDbForTests();
  __resetSessionStoreForTests();
  delete process.env.PROXY_DB_PATH;
  delete process.env.PROXY_DATA_DIR;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  upstream.requests.length = 0;
  kernel.requests.length = 0;
  __resetSessionContextWarnState();
});

// ── 小工具 ──────────────────────────────────────────────────────────────────────

interface LogCapture {
  lines: string[];
  stop(): void;
}

function startLogCapture(): LogCapture {
  const lines: string[] = [];
  const verbose = process.env.S4_VERBOSE === "1";
  const capture = (args: unknown[]) => {
    const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    lines.push(line);
    if (verbose) process.stdout.write(`${line}\n`);
  };
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => capture(a));
  // **warn 也必须抓**（S4b 起手新增）：S4b 的两条关键"因"都是 console.warn ——
  //   ① 锚点 fallback `[injection] anchor slot "skills" unresolved … fallback to point`；
  //   ② 静默降级 `[skill-injector] … degrading to empty <available_skills>`。
  // 只抓 console.log 会让这两条断言**永远为假**：既抓不到"在"，也抓不到"不在"（后者更危险，
  // 会变成"没测到也绿"）。这是 S4a 遗留的一个盲点。
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => capture(a));
  return {
    lines,
    stop: () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
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

/** 等 best-effort 归档落盘（档② 在 handler 内同步写；给 0 也应可见，此处只留余量）。 */
const settle = () => new Promise<void>((r) => setTimeout(r, 150));

/**
 * P1（anthropic）：pipeline 真的进来了（命中 §4.2 要点 3 的"空 injectors 假绿"陷阱）。
 *
 * 只有 anthropicHandler 打这条日志（anthropicHandler.ts:1238）；openai 侧**没有**对称日志，
 * 故 openai 走 expectOpenaiInjectionGateOpen 的组合证据。
 */
function expectPipelineEntered(log: LogCapture, session: string): void {
  expect(
    log.lines.some((l) => l.includes("[injection-debug] entering injection pipeline") && l.includes(session)),
    `pipeline 未进入（session=${session}）→ 注入面根本没跑，后续任何"两边一致"都无意义`,
  ).toBe(true);
}

/**
 * P1（openai 变体）：注入面真的打开。
 *
 * 为什么不是 `entering injection pipeline`：handler.ts 的 openai 路径**不存在**这条日志
 * （源码事实，非口味问题）。因此用组合证据：
 *   - 首行 injectors 非空      → gate 的 `injectors.length > 0` 满足；
 *   - 首行 injectedSkipped=false → 请求不是 auxiliary / 无 conversationId；
 *   - 首行 kind=main            → 主对话（非 sidequery 等旁路分支）；
 *   - initResult 行 bypassed=false → session-init 没走 bypass（bypass 会把注入整个关掉）；
 *   - 最强证据由 A3 的"归档块 === 上游实际注入块"逐字节断言兜底。
 */
function expectOpenaiInjectionGateOpen(log: LogCapture, session: string): void {
  const first = log.lines.find(
    (l) => l.includes("[injection-debug] conversationId=") && l.includes(`sessionKey=${session}`),
  );
  expect(first, `缺少首行 [injection-debug]（sessionKey=${session}）`).toBeTruthy();
  expect(first!).toContain('injectors=["knowledge"]');
  expect(first!).toContain("injectedSkipped=false");
  expect(first!).toContain("kind=main");

  const init = log.lines.find((l) => l.includes("[injection-debug] initResult") && l.includes(`session=${session}`));
  expect(init, `缺少 initResult 行（session=${session}）`).toBeTruthy();
  expect(init!).toContain("justRegistered=true");
  // bypassed（设计侧钉子 3，2026-09-10）：handler.ts:934 无条件打印 `bypassed=${initResult.bypassed}`，
  // openai 侧该字段未设 ⇒ 字面就是 `bypassed=undefined`。这里只钉"没被判成 bypass"。
  // **不要**改成断 `bypassed=undefined` —— 那会把"上游该字段未设"这个实现细节焊进测试。
  expect(init!).not.toContain("bypassed=true");
}

/**
 * P2：kernel detail 真的拿到了（防 kernel stub 包错一层导致的静默空块假绿）。
 *
 * ⚠️ 本窗口最该被沿用的手法（设计侧钉子 1，2026-09-10）：**把"静默假绿"变成"硬红"**。
 * 字段缺失 / 块为空时，"归档 === 上游"**照样**成立（两边一起少同样的东西），
 * 单靠等值断言永远抓不到；必须另钉一条"上游真的给了东西"的正向断言。
 *
 * **S4b 必须照此加码**：断渲染块时**不要**只断"块存在 / `block_seen` 行数 +1"，
 * 要断**块内具体 asset id 出现在上游字节里**（`expect(req.rawBody).toContain(<asset id>)`）——
 * 否则 S4b 的 skill stub 少给一个字段，又会"完美一致"地假绿。
 *
 * 第三轮勘正（2026-09-10）两处前提，免得这条断言被架在错端点/错字段上：
 *   - 端点走 **`/v3/skill/listing`**（`listListing`），**不是** `/v3/skill/search` —— 详见 s4-stubs。
 *   - 该 asset id 必须先写进 stub 返回的 **`listing` 字符串**才可能出现在上游字节里：
 *     proxy 对 skill listing 只做 `wrapAvailableSkillsBlock` 原样包裹，
 *     `hits[].skill_id` 只进 `metadata.assets`，**不进正文**。
 */
function expectDetailResolved(log: LogCapture, session: string): void {
  const line = log.lines.find((l) => l.includes("[injection-debug] initResult") && l.includes(`session=${session}`));
  expect(line, `缺少 initResult 行（session=${session}）`).toBeTruthy();
  expect(line!).toContain("hasSessionInfo=true");
  expect(line!).toContain("hasAgentDetail=true");
}

/** P3：档① 真的落了 session-context 行且非空，返回该块字节。 */
function expectSessionContextArchived(repo: VisibleTextRepo, session: string): string {
  const rows = repo.listBlockSeen(session).filter((r) => r.source === "session.context");
  expect(rows.length, `session=${session} 无 session.context 档① 行 → 接缝 B 漏档`).toBeGreaterThanOrEqual(1);
  const content = rows[0]!.content_utf8;
  expect(content.length).toBeGreaterThan(0);
  expect(content).toContain("<session_context>");
  return content;
}

// ── S4b 专用断言（§5.7.1 配方：先钉"因"，再由"因"定"果"）────────────────────────

/**
 * **形状的"因"**（§5.7.1 配方第 1 步）：`{slot:"skills"}` 锚点是否解析失败。
 *
 * `pipeline.ts:374-382` —— 锚点未命中才会打这行，然后落到 `applyByPoint` **push 新块**
 * （⇒ 形状变 array）；命中则 `:362-371` 把 system **重建成单块**（⇒ 仍是 string）。
 *
 * 必须先断它、再断形状：只断形状等于把"果"焊死，一旦 prompt 换成带
 * `# Session-specific guidance` 的真 CC prompt，形状会**静默翻转**（§5.7.1 配方第 4 点）。
 */
function skillAnchorUnresolvedLines(log: LogCapture): string[] {
  return log.lines.filter((l) => l.includes('anchor slot "skills" unresolved'));
}

/**
 * **接缝 A 的正向证据**（钉子 1 同源）：injector 自带的 result 行证明 listing 真的非空。
 *
 * `skill-injector.ts:274-277` 无条件打印 `mode=… hits=… listingLen=…`。
 * 三个数字缺一都可能"完美一致"地假绿：`listing` 为空时整块**静默消失**（`:286`
 * 的 `!listing` 早退），归档与上游会一起少同一个块、等值断言照样通过。
 *
 * 诚实边界（**逐条实测得出**）：
 *   - `mode=full` 是**我们的 stub 回给 proxy 的值**（透传证据），不是 core 路由证据；
 *   - `listingLen>0` 只证明 **listing 非空**，**不证明块被渲染**：`"(none)"` 哨兵是在
 *     `:286`（本行日志**之后**）才丢的 —— 变异测试实测：把 listing 换成 `"(none)"` 时
 *     本函数**照样通过**，抓住它的是上游字节/块数断言。
 * ⇒ 本函数是"早早退"的探测器，**不能单独当"块进来了"的证据**；真正确凿的是它 +
 *   `expect(req.rawBody).toContain(assetId)` + 形状/块数断言，三者缺一不可。
 */
function expectSkillListingInjected(log: LogCapture): void {
  const line = log.lines.find((l) => l.includes("[skill-injector]") && l.includes("result mode="));
  expect(line, "缺少 `[skill-injector] … result mode=` 行 → 渲染块没真的产出（禁止只断形状）").toBeTruthy();
  expect(line!).toContain("mode=full");
  expect(line!).toMatch(/hits=1\b/);
  const m = /listingLen=(\d+)/.exec(line!);
  expect(m, `result 行缺 listingLen（原行：${line}）`).toBeTruthy();
  expect(Number(m![1]), "listingLen=0 → listing 为空，块会被静默丢弃").toBeGreaterThan(0);
}

/** 三件套之三：没有走任何静默降级路径。 */
function expectNoSkillDegradation(log: LogCapture): void {
  const degraded = log.lines.filter((l) => l.includes("degrading to empty"));
  expect(
    degraded,
    `出现静默降级 warn → 块不是"真的产出来"的，而是空降级：\n${degraded.join("\n")}`,
  ).toHaveLength(0);
  const skipped = log.lines.filter((l) => l.includes("missing session identity"));
  expect(skipped, `缺 session identity 被 skip：\n${skipped.join("\n")}`).toHaveLength(0);
}

// ── A1：anthropic，string system ────────────────────────────────────────────────

describe("S4a · 接缝 B 真链路（真 HTTP → 上游捕获）", () => {
  it("A1 anthropic string system：上游 body.system 逐字节 == excluded + \\n\\n + 归档 session-context 块", async () => {
    const SESSION = "s4-a1-anthropic-string";
    const log = startLogCapture();
    try {
      const { status } = await postJson(
        proxyA.port,
        `/claude-code/${SPACE_ID}/v1/messages`,
        ANTHROPIC_BODY(ANTHROPIC_SYSTEM),
        SESSION_HEADERS(SESSION),
      );
      await settle();
      expect(status).toBe(200);

      const req = upstream.lastRequest();
      expect(req, "上游 stub 未收到请求 → 转发链路没打通").toBeTruthy();
      // 上游真实路径由 joinUrl(base, matchWhitelistEndpoint(path)) 决定 = `/messages`
      // （base 为纯 origin 时不会补 `/v1`）。
      expect(req!.path).toContain("/messages");
      const parsed = JSON.parse(req!.rawBody) as { system: unknown };

      // 正向证据
      // 边界（设计侧钉子 2）：本用例只证明「gate 开 + 接缝 B 逐字节正确」。
      // 注册表为空 ⇒ 零渲染块，故不涉及、也不能证明接缝 A（渲染块归档 / 注入）—— 那是 S4b。
      expectPipelineEntered(log, SESSION);
      expectDetailResolved(log, SESSION);
      const repo = getVisibleTextRepo();
      const archived = expectSessionContextArchived(repo, SESSION);
      expect(req!.rawBody).toContain("<session_context>");

      // 主断言：string system 保持 string，且 = excluded + 胶水 + 归档块
      expect(typeof parsed.system).toBe("string");
      expect(parsed.system).toBe(ANTHROPIC_SYSTEM + SEAM_GLUE + archived);

      // 共因重建 + 辅助投影（与 golden 同一份 helper）
      const rebuilt = rebuildInjectedBodyFromArchive(repo, SESSION, {
        excluded: ANTHROPIC_SYSTEM,
        protocol: "anthropic",
      });
      expect(parsed.system).toBe(rebuilt.anthropicSystem);
      expect(stripGlue(parsed.system as string)).toBe(stripGlue(rebuilt.anthropicSystem!));

      // 无超采：客户端自带 system 不入档
      for (const p of rebuilt.pieces) {
        expect(p.content.includes(ANTHROPIC_SYSTEM)).toBe(false);
      }

      // 档② 真的跑了
      const wm = readWatermark(repo, SESSION);
      expect(wm.epoch).toBe(0);
      expect(wm.lastSeen).toBeGreaterThanOrEqual(1);
      const msgText = restoredVisibleText(rebuilt.pieces.filter((p) => p.tier === "message"));
      expect(msgText).toContain(USER_TEXT);
    } finally {
      log.stop();
    }
  });

  // ── A2：anthropic，array system + cache_control ────────────────────────────────

  it("A2 anthropic array system（尾块带 cache_control）：原块逐字节保留，新块 plain text 且无 cache_control", async () => {
    const SESSION = "s4-a2-anthropic-array";
    const system = [
      { type: "text", text: "part-1" },
      { type: "text", text: "part-2", cache_control: { type: "ephemeral" } },
    ];
    const log = startLogCapture();
    try {
      const { status } = await postJson(
        proxyA.port,
        `/claude-code/${SPACE_ID}/v1/messages`,
        ANTHROPIC_BODY(system),
        SESSION_HEADERS(SESSION),
      );
      await settle();
      expect(status).toBe(200);

      const req = upstream.lastRequest();
      expect(req).toBeTruthy();
      const parsed = JSON.parse(req!.rawBody) as {
        system: Array<{ type?: string; text?: string; cache_control?: unknown }>;
      };

      expectPipelineEntered(log, SESSION);
      expectDetailResolved(log, SESSION);
      const archived = expectSessionContextArchived(getVisibleTextRepo(), SESSION);

      // array 形态：多 text block → adapter 序列化回 block 数组（原 N 块 + 1）
      // 限定（第四轮追记，纯注释）：本例的块**独立**来自「客户端 array 基座 + handler 层 append」
      // 这一条路（`context-injector.ts:278-287`），**不经过** pipeline 锚点路径 ⇒ adapter 规则如实生效。
      // pipeline 锚点路径会把多块**重建成单块**（仍是 string）：形状的判据是**锚点是否解析**、不是块数
      // （见 design §5.7.1）；别把本例外推到"接缝 A 渲染块"场景。
      expect(Array.isArray(parsed.system)).toBe(true);
      expect(parsed.system).toHaveLength(3);

      // 原块未动（含 cache_control）
      expect(parsed.system[0]).toEqual({ type: "text", text: "part-1" });
      expect(parsed.system[1]!.type).toBe("text");
      expect(parsed.system[1]!.text).toBe("part-2");
      expect(parsed.system[1]!.cache_control).toEqual({ type: "ephemeral" });

      // 新块 = 归档块全文，plain text，且未带 cache_control
      expect(parsed.system[2]!.type).toBe("text");
      expect(parsed.system[2]!.text).toBe(archived);
      expect(parsed.system[2]!.cache_control).toBeUndefined();
    } finally {
      log.stop();
    }
  });

  // ── A3：openai，string system（R1 正面断言）────────────────────────────────────

  it("A3 openai string system：归档重建块 === 实际注入块（R1 正面断言，逐字节）", async () => {
    const SESSION = "s4-a3-openai-string";
    const log = startLogCapture();
    try {
      const { status } = await postJson(
        proxyA.port,
        `/codebuddy/${SPACE_ID}/v1/chat/completions`,
        OPENAI_BODY(),
        SESSION_HEADERS(SESSION),
      );
      await settle();
      expect(status).toBe(200);

      const req = upstream.lastRequest();
      expect(req).toBeTruthy();
      expect(req!.path).toContain("/chat/completions");
      const parsed = JSON.parse(req!.rawBody) as {
        messages: Array<{ role?: string; content?: unknown }>;
      };

      expectOpenaiInjectionGateOpen(log, SESSION);
      expectDetailResolved(log, SESSION);
      const archived = expectSessionContextArchived(getVisibleTextRepo(), SESSION);
      expect(req!.rawBody).toContain("<session_context>");

      const sys = parsed.messages[0]!;
      expect(sys.role).toBe("system");
      expect(typeof sys.content).toBe("string");

      // 主断言：openai 侧注入后的 system content = excluded + 胶水 + 注入块
      expect(sys.content).toBe(OPENAI_SYSTEM + SEAM_GLUE + archived);

      // R1 正面断言：把"实际被注入进 body 的块"从上游字节里剥出来，与归档块逐字节比对。
      // （openai 侧归档块是 handler 用 buildSessionContextBlockWithToggles 重建的，
      //   注入块是 session-init 侧 injectSessionContextWithToggles 产出的 —— 二者必须相等。
      //   若未来漂移，这里先红；届时按 §5.1 登记进 KNOWN_DRIFT 并翻转成 it.fails。）
      const injectedBlock = (sys.content as string).slice((OPENAI_SYSTEM + SEAM_GLUE).length);
      expect(injectedBlock).toBe(archived);

      // 用户消息原样透传
      expect(parsed.messages[1]!.role).toBe("user");
      expect(parsed.messages[1]!.content).toBe(USER_TEXT);
    } finally {
      log.stop();
    }
  });

  // ── A4：负例 / R3 pin ─────────────────────────────────────────────────────────

  it("A4 负例（R3 pin）：injectors=[] → pipeline 被静默跳过，渲染块档① 零行", async () => {
    const SESSION = "s4-a4-empty-injectors";
    const log = startLogCapture();
    try {
      const { status } = await postJson(
        proxyB.port,
        `/claude-code/${SPACE_ID}/v1/messages`,
        ANTHROPIC_BODY(ANTHROPIC_SYSTEM),
        SESSION_HEADERS(SESSION),
      );
      await settle();
      expect(status).toBe(200);

      const req = upstream.lastRequest();
      expect(req).toBeTruthy();

      const firstLine = log.lines.find(
        (l) => l.includes("[injection-debug]") && l.includes(`sessionKey=${SESSION}`) && l.includes("injectedSkipped="),
      );
      expect(firstLine, "缺少首行 [injection-debug]（sessionKey 未透出）").toBeTruthy();
      expect(firstLine!).toContain("injectors=[]");

      // pin 的核心：gate 关掉 → pipeline 一次都没进
      expect(
        log.lines.some((l) => l.includes("entering injection pipeline") && l.includes(SESSION)),
        "injectors=[] 时 pipeline 仍被执行 → gate 语义变了，请同步更新本用例",
      ).toBe(false);

      // 修正设计 §4.1 的负例期望（详见文档文末处理记录）：接缝 B 与 injectors **无关**，
      // 因此负例下上游仍含 <session_context>、档① 仍有 session-context 行。
      // 真正被打掉的只有"渲染块档①"——用 source != session.context 的行数来钉死。
      const repo = getVisibleTextRepo();
      const renderedRows = repo.listBlockSeen(SESSION).filter((r) => r.source !== "session.context");
      expect(renderedRows, "injectors=[] 却出现了渲染块档① 行").toHaveLength(0);
      expect(expectSessionContextArchived(repo, SESSION)).toContain("<session_context>");
    } finally {
      log.stop();
    }
  });
});

// ── S4b：接缝 A（渲染块真的产出来 + 锚点分支决定 body.system 形状）──────────────

/**
 * 真 CC system prompt 的最小骨架（含 `# Session-specific guidance`）。
 *
 * 这个 heading 是 `ClaudeCodeProfile` 的 `skills` slot 映射目标
 * （`agents/claude-code/index.ts:41`）—— 它的**在/不在**就是形状的"因"（§5.7.1）。
 */
const CC_SYSTEM_WITH_SKILLS_HEADING = [
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "",
  "# Harness",
  "Tool usage, code-writing and action-safety rules.",
  "",
  "# Session-specific guidance",
  "Skill invocation lives here (see /skill-name).",
  "",
  "# Memory",
  "Persistent file-based memory.",
  "",
  "# Environment",
  "cwd=/repo, platform=darwin",
].join("\n");

/**
 * `<available_skills>` **不是**渲染块的字面标记（首跑实测，2026-09-10）。
 *
 * `wrapAvailableSkillsBlock` 只把 core 的 listing 原样夹在 `SKILL_LISTING_HEADER` 与 footer
 * 之间，**没有任何 `<available_skills>` 标签**（`skill-injector.ts:93-105`；那个名字只是
 * 文档/注释里对"这个块"的叫法）。该字面串实际只出现在 `<skill_tools>` 块的**散文**里
 * （skill_view 的 use 说明写了 "skill_name 用 <available_skills> 里 …"）。
 *
 * ⇒ 拿它当"available 块存在"的证据会**误绿**：只要 `<skill_tools>` 块在，它就成立，
 * 哪怕 skill listing 整块从来没进来过。真正可靠的块首标记是 `## Skills (mandatory)`
 * （= `SKILL_LISTING_HEADER` 第一行，`skill-injector.ts:62`）。
 */
const AVAILABLE_SKILLS_BLOCK_MARKER = "## Skills (mandatory)";

describe("S4b · 接缝 A 真链路（skill 渲染块；形状由锚点分支决定，不按块数硬编）", () => {
  it("B1 朴素 prompt（锚点未命中）：先有 unresolved 行，shape 才落 array（3 块）", async () => {
    const SESSION = "s4-b1-skill-anchor-miss";
    const log = startLogCapture();
    try {
      const { status } = await postJson(
        proxyS.port,
        `/claude-code/${SPACE_ID}/v1/messages`,
        ANTHROPIC_BODY(ANTHROPIC_SYSTEM),
        SESSION_HEADERS(SESSION),
      );
      await settle();
      expect(status).toBe(200);

      const req = upstream.lastRequest();
      expect(req, "上游 stub 未收到请求 → 转发链路没打通").toBeTruthy();
      const parsed = JSON.parse(req!.rawBody) as { system: unknown };
      const archived = expectSessionContextArchived(getVisibleTextRepo(), SESSION);

      // ── 先钉"因"：朴素 prompt 无 `# Session-specific guidance` ⇒ 锚点未命中 ──
      expect(
        skillAnchorUnresolvedLines(log).length,
        '朴素 prompt 却**没有** anchor slot "skills" unresolved 行 → 形状的前提不成立，'
          + "后面的 array 断言即使绿也说明不了任何事",
      ).toBeGreaterThanOrEqual(1);

      // ── 正向证据三件套（缺一都可能被"完美一致"骗过）──
      expectPipelineEntered(log, SESSION);
      expectDetailResolved(log, SESSION);
      expectSkillListingInjected(log);
      expect(req!.rawBody).toContain(S4_KERNEL_FIXTURE.skillId);
      expect(req!.rawBody).toContain(AVAILABLE_SKILLS_BLOCK_MARKER);
      expectNoSkillDegradation(log);

      // ── 再断"果"：applyByPoint push 新块 ⇒ array ──
      expect(Array.isArray(parsed.system)).toBe(true);
      const blocks = parsed.system as Array<{ type?: string; text?: string }>;
      expect(blocks).toHaveLength(3);
      // [0] = 客户端 string + handler 层胶水（session-context）—— 客户端自带 system 不入档
      expect(blocks[0]!.text).toBe(ANTHROPIC_SYSTEM + SEAM_GLUE + archived);
      // [1]/[2] = 两个渲染块，priority 决定 tools 在前（skill-tools-injector.ts:198）
      expect(blocks[1]!.text).toContain("<skill_tools>");
      expect(blocks[2]!.text).toContain(AVAILABLE_SKILLS_BLOCK_MARKER);
      expect(blocks[2]!.text).toContain(S4_KERNEL_FIXTURE.skillId);
    } finally {
      log.stop();
    }
  });

  it("B2 真 CC prompt（锚点命中）：无 unresolved 行，同一装置 shape 落 string（插在 heading 之前）", async () => {
    const SESSION = "s4-b2-skill-anchor-hit";
    const log = startLogCapture();
    try {
      const { status } = await postJson(
        proxyS.port,
        `/claude-code/${SPACE_ID}/v1/messages`,
        ANTHROPIC_BODY(CC_SYSTEM_WITH_SKILLS_HEADING),
        SESSION_HEADERS(SESSION),
      );
      await settle();
      expect(status).toBe(200);

      const req = upstream.lastRequest();
      expect(req).toBeTruthy();
      const parsed = JSON.parse(req!.rawBody) as { system: unknown };
      expectSessionContextArchived(getVisibleTextRepo(), SESSION);

      // ── "因"的另一侧：锚点命中 ⇒ **没有** unresolved 行 ──
      expect(
        skillAnchorUnresolvedLines(log),
        "真 CC prompt 仍打 unresolved 行 → 与 §5.7.1 的分支表不符，先回去核 profile 映射",
      ).toHaveLength(0);

      expectPipelineEntered(log, SESSION);
      expectDetailResolved(log, SESSION);
      expectSkillListingInjected(log);
      expect(req!.rawBody).toContain(S4_KERNEL_FIXTURE.skillId);
      expectNoSkillDegradation(log);

      // ── "果"：锚点命中 ⇒ pipeline 重建成单块 ⇒ adapter 回落 string ──
      expect(typeof parsed.system).toBe("string");
      const s = parsed.system as string;
      expect(s).toContain(S4_KERNEL_FIXTURE.skillId);
      expect(s).toContain(AVAILABLE_SKILLS_BLOCK_MARKER);
      // 无损重建：原始段落必须还在
      expect(s).toContain("# Harness");
      expect(s).toContain("# Memory");
      expect(s).toContain("# Environment");
      expect(s).toContain("<session_context>");
      // 两个渲染块插在 skills heading **之前**（relation: "before"），且 tools 在 available 之前。
      // 实测顺序（2026-09-10）：tools(120) → available(2415) → heading(3996) → Memory → Environment → session_context
      const iHeading = s.indexOf("# Session-specific guidance");
      const iTools = s.indexOf("<skill_tools>");
      const iAvailable = s.indexOf(AVAILABLE_SKILLS_BLOCK_MARKER);
      expect(iHeading).toBeGreaterThanOrEqual(0);
      expect(iTools, "渲染块没落在 skills heading 之前").toBeLessThan(iHeading);
      expect(iAvailable, "渲染块没落在 skills heading 之前").toBeLessThan(iHeading);
      expect(iTools, "priority 未生效：<skill_tools> 应排在 available 块之前").toBeLessThan(iAvailable);
    } finally {
      log.stop();
    }
  });
});

// ── 捕获器护栏（泄漏式；自足、不依赖用例顺序、不依赖"字面可见性"）──────────────────

/**
 * 为什么按"**泄漏**"写、而不是按"**可见性**"写（设计侧裁决，2026-09-10）：
 *
 * 本轮坑的机理是**捕获器吞信号**，不是断言写错；而捕获面比预想大 —— 生产侧
 * `console.warn` 有 **139 处 / 34 文件**。若某次 `finally` 缺失、或后续新增用例忘记
 * `stop()`，本文件**余下所有 warn 会静默消失**，且**没有任何断言会红**（同一类事故，
 * 更难发现）。⇒ 护栏要钉的是"**捕获必须收口**"，不是"warn 看得见"。
 *
 * "看得见"不能当主判据：vitest 自身也写 stderr，且本文件里 `[identity]` / `[REQ…]`
 * 那些行并非 `console.*` 通道（是 logger 直写）⇒ 捕获期间照旧可见，拿它判绿红会骗人。
 */
describe("S4b · 捕获器护栏（泄漏式，不依赖用例顺序）", () => {
  it("startLogCapture().stop() 后：数组不再增长、console.log/warn 均已还原", () => {
    const log = startLogCapture();
    log.stop();
    const before = log.lines.length;

    // eslint-disable-next-line no-console
    console.log("guard");
    // eslint-disable-next-line no-console
    console.warn("guard-warn");
    expect(
      log.lines.length,
      "stop() 后数组仍在增长 → 有捕获器没停（缺 finally / 忘记 stop），"
        + "后续用例的日志与 warn 会静默消失且无人报错",
    ).toBe(before);

    expect(
      vi.isMockFunction(console.log),
      "console.log 仍是 mock → 未还原，后续用例日志静默消失",
    ).toBe(false);
    expect(
      vi.isMockFunction(console.warn),
      "console.warn 仍是 mock → 未还原，后续用例的降级/未命中 warn 静默消失",
    ).toBe(false);
  });
});

// ── known-drift 双向 tripwire（登记表生成用例，不手写）────────────────────────────

describe("known-drift tripwire（双向；登记表为空时仍有两条表级断言）", () => {
  // root 必须在 describe 作用域解析并**硬校验**（2026-09-10，design §9.2）：
  //   - 生成器（下面的 for 循环）就在 describe body 里跑，写在 it 体内它拿不到；
  //   - 校验要**抛在 it.fails 之外** —— 抛在里面会被当成"期望失败"，基础设施坏了反而变绿。
  const candidates = [process.cwd(), path.resolve(process.cwd(), "MemoryProxy")];
  const root = candidates.find((c) => fs.existsSync(path.join(c, "package.json")));
  if (!root) {
    throw new Error(
      `known-drift tripwire：找不到包根（candidates = ${candidates.join(", ")}）`,
    );
  }

  it("联动断言：登记表引用的 doc 必须存在且含该 id（防静默删用例 / 删登记表）", () => {
    for (const d of KNOWN_DRIFT) {
      const abs = path.join(root, d.doc);
      expect(fs.existsSync(abs), `known-drift ${d.id} 的 doc 不存在：${d.doc}（root=${root}）`).toBe(true);
      expect(fs.readFileSync(abs, "utf8")).toContain(d.id);
    }
  });

  // 反向自证（2026-09-10，design §10 推荐 1）：把"登记项不许空转"从"人工变异证明过一次"
  // 升级成**常驻不变量**。判据 = "check 必须依赖 root"：真判据都要读 root 下的文件 ⇒ 喂它
  // 一个**存在但为空**的目录时读不到文件、必抛；写成 `() => {}`、恒过、或忽略 root 去读真实
  // 仓库的登记项都不抛 ⇒ 这条立刻红（这正是上一轮 §9.5 变异 1b 只能靠人工演示的那件事）。
  // 用 mkdtemp 的**空目录**而非不存在的路径：连"只断言目录/文件存在"的伪判据也一并挡掉。
  it("反向自证：每条登记项的 check 必须依赖 root（伪造 root 下必须失败）", () => {
    const bogusRoot = fs.mkdtempSync(path.join(os.tmpdir(), "known-drift-bogus-"));
    try {
      for (const d of KNOWN_DRIFT) {
        expect(
          () => d.check(bogusRoot),
          `known-drift ${d.id} 的 check 在伪造 root 下居然通过 ⇒ 该登记项是空转`
            + "（不读 root / 忽略 root / 恒过）。真判据必须读 root 下的真实文件",
        ).toThrow();
      }
    } finally {
      fs.rmSync(bogusRoot, { recursive: true, force: true });
    }
  });

  for (const d of KNOWN_DRIFT) {
    // eslint-disable-next-line no-console
    console.warn(`${KNOWN_DRIFT_LOG_PREFIX} ${d.id} (${d.ticket}) — ${d.summarize()}`);
    // it.fails 是**期望失败**：漂移存续 → 绿；有人修好 → expected to fail but passed →
    // 套件立即红，逼把该条从 KNOWN_DRIFT 删除并翻转成正面断言（销案）。
    it.fails(`[KNOWN-DRIFT:${d.id}] ${d.summarize()}`, () => {
      // 断言由登记表自带（`check`），**不再**用恒假占位 —— 恒假在 it.fails 下是永恒绿 ⇒ 空转。
      // 这里若变红（"expected to fail but passed"）⇒ 漂移已修好，销案：删登记项 + 把 check
      // 原样搬成一条正面 `it`（见 s4-smoke-design.md §9.4）。
      d.check(root);
    });
  }
});
