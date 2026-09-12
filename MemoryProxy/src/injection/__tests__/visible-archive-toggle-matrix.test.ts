/**
 * §8.5 验收装置：toggle 缺省 off + 组合矩阵零行为回归（40 spec §6c / §7 test 11）。
 *
 * 两层断言：
 *   1) 配置解析（真实 buildConfig + 临时 YAML）：visibleArchive / attributionEvents 缺省 false、
 *      显式 boolean 生效、类型错误回落缺省；maxMessageChars 只接受正整数（0/负数/非数回落默认）。
 *      langfuse.enabled 走 `??` 语义（config.ts:322）—— 本装置只断言"缺省 false / 显式 boolean true"，
 *      不把 string 断言成类型安全（口径声明，见 review C7）。
 *   2) DB 层组合矩阵（零交叉污染）：visibleArchive off（或缺省）→ 四张新表 0 行、无水位行，而
 *      attribution_events 照常写入；visibleArchive on → 四张新表按预期落行且不产生 attribution_events
 *      行，S1 写入也不产生 P0 行。langfuse toggle 与两者均无耦合（不参与 DB 写路径）。
 *
 * 诚实边界：handler 调用点守卫（mainDialog / decisionUnitExtractor，handler.ts:1144-1149）与真实
 * HTTP 冒烟不在本层断言，见 40 spec §8.3 / S4 窗口。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConfig } from "../../config.js";
import {
  __resetAttributionEventRepoForTests,
  getAttributionEventRepo,
} from "../../db/attributionEventRepo.js";
import { __resetDbForTests, getDb } from "../../db/index.js";
import { __resetVisibleTextRepoForTests, getVisibleTextRepo } from "../../db/visibleTextRepo.js";
import { archiveMessageIncrement } from "../../decision-units/message-increment-archive.js";
import type { AgentContextMetadata, ContextBlock, InjectionHook } from "../types.js";
import { VisibleBlockArchiveObserver } from "../visible-block-archive-observer.js";
import { restoreIsolatedDbPath } from "../../__tests__/setup/isolate-db.js";

const NEW_TABLES = [
  "attribution_block_text",
  "attribution_block_seen",
  "attribution_message_snap",
  "attribution_archive_watermark",
] as const;

let dir: string;
let cfgDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-toggle-"));
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-toggle-cfg-"));
  process.env.PROXY_DB_PATH = path.join(dir, "proxy.db");
  __resetVisibleTextRepoForTests();
  __resetAttributionEventRepoForTests();
  __resetDbForTests();
});

afterEach(() => {
  __resetVisibleTextRepoForTests();
  __resetAttributionEventRepoForTests();
  __resetDbForTests();
  restoreIsolatedDbPath(); // 73 · C3：delete → 恢复 setup 隔离值（防裸跑回落到默认真库）
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  if (cfgDir) fs.rmSync(cfgDir, { recursive: true, force: true });
});

function writeYaml(name: string, lines: string[]): string {
  const p = path.join(cfgDir, name);
  fs.writeFileSync(p, lines.join("\n"), "utf8");
  return p;
}

function countRows(table: string): number {
  const db = getDb();
  const row = db!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return Number(row.n);
}

// ── 1) 配置解析矩阵（真实 buildConfig）───────────────────────────────────────

describe("§8.5 配置解析矩阵（真实 buildConfig + 临时 YAML）", () => {
  it("缺省（文件不存在）→ 三个 toggle 全 false（零行为回归）", () => {
    const cfg = buildConfig({ configFile: path.join(cfgDir, "absent.yaml") });
    expect(cfg.injection?.visibleArchive?.enabled).toBe(false);
    expect(cfg.injection?.attributionEvents?.enabled).toBe(false);
    expect(cfg.langfuse.enabled).toBe(false);
    // 缺省 cap 来自 DEFAULT_CONFIG（§6c）
    expect(cfg.injection?.visibleArchive?.maxBlockChars).toBe(32_768);
    expect(cfg.injection?.visibleArchive?.maxMessageChars).toBe(65_536);
  });

  it("显式 boolean true 生效；类型错误/非正整数回落缺省（缺省 off 口径不变）", () => {
    const on = buildConfig({
      configFile: writeYaml("on.yaml", [
        "injection:",
        "  visibleArchive: { enabled: true, maxBlockChars: 1024, maxMessageChars: 4096 }",
        "  attributionEvents: { enabled: true }",
        "langfuse: { enabled: true, host: \"http://localhost:3000\" }",
      ]),
    });
    expect(on.injection?.visibleArchive?.enabled).toBe(true);
    expect(on.injection?.visibleArchive?.maxBlockChars).toBe(1024);
    expect(on.injection?.visibleArchive?.maxMessageChars).toBe(4096);
    expect(on.injection?.attributionEvents?.enabled).toBe(true);
    expect(on.langfuse.enabled).toBe(true);

    const bad = buildConfig({
      configFile: writeYaml("bad.yaml", [
        "injection:",
        "  visibleArchive: { enabled: \"yes\", maxBlockChars: 0, maxMessageChars: -5 }",
        "  attributionEvents: { enabled: 1 }",
      ]),
    });
    expect(bad.injection?.visibleArchive?.enabled).toBe(false); // 只接受 boolean
    expect(bad.injection?.attributionEvents?.enabled).toBe(false);
    expect(bad.injection?.visibleArchive?.maxBlockChars).toBe(32_768); // 非正整数 → 默认
    expect(bad.injection?.visibleArchive?.maxMessageChars).toBe(65_536);
  });
});

// ── 2) DB 层组合矩阵（零交叉污染）───────────────────────────────────────────

describe("§8.5 DB 层组合矩阵（零交叉污染）", () => {
  const SESSION = "sess-matrix";

  const MSGS = [
    { role: "system", content: "You are a proxy." },
    { role: "user", content: "hello matrix" },
  ];

  const hook: InjectionHook = {
    id: "skill-listing-injector",
    point: "system.suffix",
    priority: 200,
    description: "toggle-matrix hook",
    execute: () => [],
  };
  const meta: AgentContextMetadata = {
    protocol: "openai",
    traceId: "trace-matrix",
    keyId: "key-matrix",
    modelId: "model-matrix",
    stream: false,
    agentSource: "codebuddy",
    sessionKey: SESSION,
    turnSeq: 1,
  };
  const blocks: ContextBlock[] = [
    { type: "text", content: "MATRIX-BLOCK\n", metadata: { source: "skill.v1" } },
  ];

  /** 极简 config 结构（driveArchive 只关心 visibleArchive.enabled）。 */
  interface MatrixConfig {
    injection?: { visibleArchive?: { enabled?: boolean; maxBlockChars?: number } };
  }

  /**
   * 复刻两处装配门控驱动归档入口：
   *   - 档② archiveMessageIncrement 自带 `visibleArchive.enabled` 门控（早退）；
   *   - 档① VisibleBlockArchiveObserver 本身不带门控，装配点在 injection/index.ts:419-425
   *     （`if (config.injection?.visibleArchive?.enabled) observers.push(...)`）—— 缺省 off ⇒
   *     不构造、零新表访问。此处按同一条件复刻该装配门控。
   */
  function driveArchive(config: MatrixConfig): void {
    archiveMessageIncrement({
      config,
      protocol: "openai",
      messages: MSGS,
      sessionKey: SESSION,
    });
    if (config.injection?.visibleArchive?.enabled === true) {
      new VisibleBlockArchiveObserver({
        maxBlockChars: config.injection.visibleArchive.maxBlockChars,
      }).onHookDone(hook, "system.suffix", blocks, 1, undefined, meta);
    }
  }

  it("visibleArchive off（缺省）→ 四新表 0 行、无水位；attribution_events 照常（§7 test 11）", () => {
    const cfg = buildConfig({ configFile: path.join(cfgDir, "absent.yaml") });
    driveArchive(cfg);

    for (const t of NEW_TABLES) expect(countRows(t)).toBe(0);
    expect(getVisibleTextRepo().getWatermark(SESSION)).toBeNull();

    // S1 通道不受 P0 门控影响：attribution_events 照常写入
    getAttributionEventRepo().append({
      sessionKey: SESSION,
      eventType: "injection.hook.done",
      payload: { hookId: "skill-listing-injector" },
    });
    expect(countRows("attribution_events")).toBe(1);
  });

  it("visibleArchive off × attributionEvents on × langfuse on → 四新表 0 行（S1 独跑无回归）", () => {
    const cfg = buildConfig({
      configFile: writeYaml("s1-only.yaml", [
        "injection:",
        "  visibleArchive: { enabled: false }",
        "  attributionEvents: { enabled: true }",
        "langfuse: { enabled: true, host: \"http://localhost:3000\" }",
      ]),
    });
    driveArchive(cfg);

    for (const t of NEW_TABLES) expect(countRows(t)).toBe(0);
    getAttributionEventRepo().append({
      sessionKey: SESSION,
      eventType: "injection.hook.done",
      payload: { n: 1 },
    });
    expect(countRows("attribution_events")).toBe(1);
  });

  it("visibleArchive on × attributionEvents on × langfuse on → 各写各表，零交叉污染", () => {
    const cfg = buildConfig({
      configFile: writeYaml("all-on.yaml", [
        "injection:",
        "  visibleArchive: { enabled: true }",
        "  attributionEvents: { enabled: true }",
        "langfuse: { enabled: true, host: \"http://localhost:3000\" }",
      ]),
    });
    driveArchive(cfg);

    // 档①：1 条 text + 1 条 seen；档②：system 行不入档 → 1 条 snap；水位 1 行
    expect(countRows("attribution_block_text")).toBe(1);
    expect(countRows("attribution_block_seen")).toBe(1);
    expect(countRows("attribution_message_snap")).toBe(1);
    expect(countRows("attribution_archive_watermark")).toBe(1);
    // 归档写入不产生 S1 行
    expect(countRows("attribution_events")).toBe(0);

    // 反向：S1 写入不产生 P0 行
    getAttributionEventRepo().append({
      sessionKey: SESSION,
      eventType: "injection.hook.done",
      payload: { n: 2 },
    });
    expect(countRows("attribution_events")).toBe(1);
    expect(countRows("attribution_block_seen")).toBe(1);
    expect(countRows("attribution_message_snap")).toBe(1);
  });
});
