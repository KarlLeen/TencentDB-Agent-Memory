/**
 * 验收③装置 —— 转发前 injectedBody golden 字节硬比对（40-visible-text-archive.md §8.3 / B1）。
 *
 * 边界说明（诚实标注）：
 *   本装置在"合并点等价层"做字节级硬比对：不依赖真实 HTTP 往返，而是按 §3a 归因表驱动与
 *   生产代码**完全相同的捕获入口**（recordSessionContextBlock / VisibleBlockArchiveObserver /
 *   archiveMessageIncrement），把每次 main 请求"模型会收到的正文来源"按 handler 语义逐字节喂入，
 *   再经 window() 从归档侧还原，断言：
 *     1) 每条 piece 的内容字节 == 对应来源正文（逐字节，无空白/编码漂移）；
 *     2) window() 按 (turn_seq, tier, seq) 拼接的"归档还原正文"与来源归因串逐字节一致；
 *     3) excluded 清单（客户端自带 system，非本代理注入面）不在归档内 —— 反向证明无超采；
 *     4) 来源数 == piece 数（任何接缝漏档都会让还原缺字节而红，并带来源归属 diff）；
 *     5) 互斥断言（§7 test 7 / R1-B2）：同轮 user/assistant 消息不整块包含档① block
 *        （合法双轮 fixture 0 违规；drift 夹具判 whole 并带归属分类）。
 *   缺 seam / 新直拼 body 路径的未来回归由本装置的"缺失来源即红"性质暴露。
 *   完整 HTTP 冒烟（真实 proxy + 上游捕获）在 S4/S5 真实冒烟窗口执行，见 40 spec §8.3。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetDbForTests } from "../../db/index.js";
import { __resetVisibleTextRepoForTests, getVisibleTextRepo, readWatermark, windowVisibleText } from "../../db/visibleTextRepo.js";
import {
  archiveMessageIncrement,
  classifySameTurnWholeContainment,
} from "../../decision-units/message-increment-archive.js";
import type { AgentContextMetadata, ContextBlock, InjectionHook } from "../types.js";
import { recordSessionContextBlock, VisibleBlockArchiveObserver } from "../visible-block-archive-observer.js";

let dir: string;

function withTempDb(): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-golden-"));
  process.env.PROXY_DB_PATH = path.join(dir, "proxy.db");
  __resetVisibleTextRepoForTests();
  __resetDbForTests();
}

beforeEach(() => {
  withTempDb();
});

afterEach(() => {
  __resetVisibleTextRepoForTests();
  __resetDbForTests();
  delete process.env.PROXY_DB_PATH;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

type Msg = { role: string; content: unknown };

/** 确定性会话 fixture（§3a：system=excluded；注入=档①；消息流=档②）。 */
const EXCLUDED_SYSTEM = "You are a memory proxy.";
const SESSION = "sess-golden";
const CFG = { injection: { visibleArchive: { enabled: true } } };

const REQ1: Msg[] = [
  { role: "system", content: EXCLUDED_SYSTEM },
  { role: "user", content: "help me remember this repo layout" },
];
const REQ2: Msg[] = [
  { role: "system", content: EXCLUDED_SYSTEM },
  { role: "user", content: "help me remember this repo layout" },
  { role: "assistant", content: "i will help with that" },
  { role: "user", content: "add: src/db is the persistence layer" },
];

// 来源正文（每次 main 请求 handler 实际会拼进 body 的字节）
const CTX_BYTES = "SESSION_CONTEXT:task=memory-proxy-demo\n"; // 接缝 B（body.system 追加项）
const HOOK_BYTES = "<skills>\n  <name>qa</name>\n</skills>\n"; // 接缝 A（skill-listing 渲染块，每轮重注入）
const HOOK_SOURCE = "skill.v1";

function metaOf(sessionKey: string, turnSeq: number): AgentContextMetadata {
  return {
    protocol: "openai",
    traceId: "trace-golden",
    keyId: "key-golden",
    modelId: "model-golden",
    stream: false,
    agentSource: "codebuddy",
    sessionKey,
    turnSeq,
  };
}

function skillHook(): InjectionHook {
  return {
    id: "skill-listing-injector",
    point: "system.suffix",
    priority: 200,
    description: "golden skill listing",
    execute: () => [],
  };
}

/** 按 handler 语义重放两轮 main 请求（注入前档② → 注入中档① → 拼接 read）。 */
function runHarness(): void {
  const observer = new VisibleBlockArchiveObserver();

  // ── 轮 1（main）：档②消息增量 → session-init 合成块（seam B，turnSeq=countHumanTurns=1）
  archiveMessageIncrement({ config: CFG, protocol: "openai", messages: REQ1, sessionKey: SESSION });
  recordSessionContextBlock({ sessionKey: SESSION, turnSeq: 1, content: CTX_BYTES });

  // ── 轮 2（main）：档②消息增量 → skill-listing hook.done 块（seam A，meta.turnSeq=2）
  archiveMessageIncrement({ config: CFG, protocol: "openai", messages: REQ2, sessionKey: SESSION });
  const hookBlock: ContextBlock = { type: "text", content: HOOK_BYTES, metadata: { source: HOOK_SOURCE } };
  observer.onHookDone(skillHook(), "system.suffix", [hookBlock], 1, undefined, metaOf(SESSION, 2));
}

describe("验收③装置：injectedBody golden 字节硬比对（合并点等价层）", () => {
  it("window() 还原正文与来源归因串逐字节一致；excluded 不入档", () => {
    runHarness();

    const watermark = readWatermark(getVisibleTextRepo(), SESSION);
    expect(watermark).toEqual({ epoch: 0, lastSeen: REQ2.length }); // 两轮各推进一次

    const win = windowVisibleText(getVisibleTextRepo(), SESSION);
    const { pieces } = win;
    // piece 数与来源数一致：2 轮 × (1 block seam + N 新消息) —— 任何接缝漏档都会在此红掉
    expect(pieces.map((p) => `${p.tier}:${p.turnSeq}:${p.seq}`)).toEqual([
      "block:1:0", //   ctx（轮1 合成块）
      "message:1:1", // user q1（轮1）
      "message:1:2", // assistant a1（轮2 新尾，turn_seq=1 落在轮1）
      "block:2:0", //   skill hook（轮2）
      "message:2:3", // user q2（轮2）
    ]);

    // piece "可见正文"（档① = content_utf8 原字节；档② = content_json 反序列化后的文本）
    const textOf = (p: (typeof pieces)[number]): string =>
      p.tier === "block" ? p.content : String(JSON.parse(p.content));

    // 1) 每条 piece 内容逐字节等于其来源
    expect(textOf(pieces[0]!)).toBe(CTX_BYTES);
    expect(pieces[0]!.source).toBe("session.context");
    expect(textOf(pieces[1]!)).toBe("help me remember this repo layout");
    expect(pieces[1]!.role).toBe("user");
    expect(textOf(pieces[2]!)).toBe("i will help with that");
    expect(textOf(pieces[3]!)).toBe(HOOK_BYTES);
    expect(pieces[3]!.source).toBe(HOOK_SOURCE);
    expect(textOf(pieces[4]!)).toBe("add: src/db is the persistence layer");

    // 2) 拼接还原正文 == 来源归因串（逐字节：长度 + 内容双断言）
    const expectedBytes =
      CTX_BYTES + "help me remember this repo layout" + "i will help with that" + HOOK_BYTES +
      "add: src/db is the persistence layer";
    const restored = pieces.map(textOf).join("");
    expect(restored.length).toBe(expectedBytes.length);
    expect(Buffer.byteLength(restored, "utf8")).toBe(Buffer.byteLength(expectedBytes, "utf8"));
    expect(restored).toBe(expectedBytes);

    // 3) excluded（客户端自带 system）不在归档内 —— 无超采
    for (const p of pieces) {
      expect(p.content.includes(EXCLUDED_SYSTEM)).toBe(false);
    }
    expect(restored.includes(EXCLUDED_SYSTEM)).toBe(false);
  });

  it("装置对漏档敏感：跳过 seam B 则还原缺 ctx 字节并带归属定位信息", () => {
    // 故意只跑 seam A + 消息（轮1 的 session-context 未捕获）→ 漏 1 条来源
    const observer = new VisibleBlockArchiveObserver();
    archiveMessageIncrement({ config: CFG, protocol: "openai", messages: REQ1, sessionKey: SESSION });
    archiveMessageIncrement({ config: CFG, protocol: "openai", messages: REQ2, sessionKey: SESSION });
    observer.onHookDone(
      skillHook(),
      "system.suffix",
      [{ type: "text", content: HOOK_BYTES, metadata: { source: HOOK_SOURCE } }],
      1,
      undefined,
      metaOf(SESSION, 2),
    );

    const pieces = windowVisibleText(getVisibleTextRepo(), SESSION).pieces;
    // 漏了 ctx 块 → 只剩 4 条；窗口仍可读，但还原串字节数少于"应有可见正文"
    expect(pieces.map((p) => `${p.tier}:${p.turnSeq}:${p.seq}`)).toEqual([
      "message:1:1",
      "message:1:2",
      "block:2:0",
      "message:2:3",
    ]);
    const textOf = (p: (typeof pieces)[number]): string =>
      p.tier === "block" ? p.content : String(JSON.parse(p.content));
    const restored = pieces.map(textOf).join("");
    expect(restored.includes(CTX_BYTES)).toBe(false); // B1 场景：漏 system/session-context 不再静默
  });
});

describe("互斥断言（40 spec §7 test 7 / R1-B2 收窄）—— 同轮捕获无假红，drift 分类可红", () => {
  it("真实双轮 main fixture：同轮 user/assistant 消息不整块包含注入块 → 0 违规", () => {
    runHarness();
    const repo = getVisibleTextRepo();
    const wm = readWatermark(repo, SESSION);
    expect(wm?.epoch).toBe(0);
    const blocks = repo.listBlockSeen(SESSION);
    const msgs = repo.listMessageSnaps(SESSION, { epoch: wm!.epoch });
    expect(classifySameTurnWholeContainment(blocks, msgs)).toEqual([]);
  });

  it("drift 装置：注入块文本以 user 消息形态进入档②同轮 → 判 whole 违规并带归属分类", () => {
    const D = "sess-drift";
    const observer = new VisibleBlockArchiveObserver();
    // runner 被挪到注入后（真漂移签名）：本回合消息流出现"注入块转 user 消息"，且同轮档① 落同一 block
    archiveMessageIncrement({
      config: CFG,
      protocol: "openai",
      messages: [
        { role: "system", content: EXCLUDED_SYSTEM },
        { role: "user", content: "what skills exist?" },
        { role: "user", content: HOOK_BYTES }, // 注入块全文以 user 消息形态混入
      ],
      sessionKey: D,
    });
    observer.onHookDone(
      skillHook(),
      "system.suffix",
      [{ type: "text", content: HOOK_BYTES, metadata: { source: HOOK_SOURCE } }],
      1,
      undefined,
      metaOf(D, 2), // 该 hook 块在第 2 人类轮注入
    );

    const repo = getVisibleTextRepo();
    const wm = readWatermark(repo, D);
    const blocks = repo.listBlockSeen(D);
    const msgs = repo.listMessageSnaps(D, { epoch: wm!.epoch });
    const hits = classifySameTurnWholeContainment(blocks, msgs);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      blockHook: "skill-listing-injector",
      source: HOOK_SOURCE,
      msgIndex: 2, // messages[2]（HOOK 文本所在消息）
      role: "user",
      kind: "whole",
    });
  });
});
