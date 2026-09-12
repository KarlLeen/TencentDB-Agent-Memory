/**
 * 档① VisibleBlockArchiveObserver 单测（40-visible-text-archive.md §3/§7 test 1/2/3/4/10）。
 *
 * 覆盖：
 *   - 纯函数：sha256Of / textStats / truncateToChars / sourceOfBlock / assetIdsJsonOf
 *   - archiveTextBlock 共用归档路径（接缝 A/B 共用入口）：round-trip、跨轮/跨会话 content_hash
 *     去重（source 不进唯一键）、非 text / 空内容跳过、无 sessionKey 放弃
 *   - recordSessionContextBlock（接缝 B 合成块：hook=session-context / point=system.prepend /
 *     source=session.context，内容与合入正文逐字节相同）
 *   - VisibleBlockArchiveObserver.onHookDone（缺 meta 静默放弃；块级错误不阻断）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetDbForTests, getDb } from "../../db/index.js";
import {
  __resetVisibleTextRepoForTests,
  getVisibleArchiveWriteCounters,
  getVisibleTextRepo,
} from "../../db/visibleTextRepo.js";
import type { AgentContextMetadata, ContextBlock, InjectionHook } from "../types.js";
import { restoreIsolatedDbPath } from "../../__tests__/setup/isolate-db.js";
import {
  SESSION_CONTEXT_HOOK,
  SESSION_CONTEXT_POINT,
  SESSION_CONTEXT_SOURCE,
  assetIdsJsonOf,
  archiveTextBlock,
  recordSessionContextBlock,
  sha256Of,
  sourceOfBlock,
  textStats,
  truncateToChars,
  VisibleBlockArchiveObserver,
} from "../visible-block-archive-observer.js";

let dir: string;

function withTempDb(): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-vba-"));
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
  restoreIsolatedDbPath(); // 73 · C3：delete → 恢复 setup 隔离值（防裸跑回落到默认真库）
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/** 直接查 text/seen 两表，验证 repo 之上的归档语义。 */
function tableRows(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  const db = getDb();
  return (db!.prepare(sql).all(...params) ?? []) as Array<Record<string, unknown>>;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

describe("档① pure helpers", () => {
  it("sha256Of：utf8 十六进制去重键", () => {
    expect(sha256Of("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Of("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("textStats：chars=JS 长度、bytes=utf8 字节数（原长，截断前）", () => {
    expect(textStats("中文ab")).toEqual({ chars: 4, bytes: 8 });
    expect(textStats("plain")).toEqual({ chars: 5, bytes: 5 });
  });

  it("truncateToChars：超 cap 取前段 + truncated 标记", () => {
    expect(truncateToChars("hello world", 5)).toEqual({ head: "hello", truncated: true });
    expect(truncateToChars("hi", 5)).toEqual({ head: "hi", truncated: false });
    // UTF-16 code unit 切片（与存盘口径一致），多字节字符按 code unit 数计
    expect(truncateToChars("中文字符串", 2)).toEqual({ head: "中文", truncated: true });
  });

  it("sourceOfBlock：metadata.source 非空 string 用之，否则回退 hook.id", () => {
    const block = (metadata?: Record<string, unknown>): ContextBlock =>
      ({ type: "text", content: "c", metadata }) as ContextBlock;
    expect(sourceOfBlock(block({ source: "asset.src" }), "hook-a")).toBe("asset.src");
    expect(sourceOfBlock(block({ source: "" }), "hook-a")).toBe("hook-a");
    expect(sourceOfBlock(block({}), "hook-a")).toBe("hook-a");
    expect(sourceOfBlock(block({ source: 42 }), "hook-a")).toBe("hook-a");
    expect(sourceOfBlock(block(undefined), "hook-a")).toBe("hook-a");
  });

  it("assetIdsJsonOf：collectAssets identity 摘要（无 spans / 无 name/version）", () => {
    const blocks: ContextBlock[] = [
      {
        type: "text",
        content: "x",
        metadata: {
          assets: [{ assetId: "wiki-1", assetType: "llm_wiki", name: "ignored", version: 3 }],
        },
      },
      {
        type: "text",
        content: "y",
        metadata: {
          assets: [{ assetId: "wiki-1", assetType: "llm_wiki" }, { assetId: "bad", assetType: "" }],
        },
      },
    ];
    expect(assetIdsJsonOf(blocks)).toBe('[{"assetId":"wiki-1","assetType":"llm_wiki"}]');
    expect(assetIdsJsonOf([{ type: "text", content: "no-assets" }])).toBeNull();
  });
});

// ── archiveTextBlock（接缝 A/B 共用路径）──────────────────────────────────────

describe("archiveTextBlock（档① 共用归档路径）", () => {
  it("text block round-trip：text 行 + seen 行，字段精确", () => {
    const content = "hello archive";
    archiveTextBlock({
      sessionKey: "sess-1",
      turnSeq: 3,
      block: { type: "text", content, metadata: { source: "asset.src" } },
      hookId: "hook-a",
      point: "system.suffix",
      blockIdx: 0,
    });

    const textRows = tableRows(
      "SELECT content_id, source, content_hash, content_utf8, chars, bytes, truncated FROM attribution_block_text",
    );
    expect(textRows).toHaveLength(1);
    expect(textRows[0]!.source).toBe("asset.src");
    expect(textRows[0]!.content_hash).toBe(sha256Of(content));
    expect(textRows[0]!.content_utf8).toBe(content);
    expect(textRows[0]!.chars).toBe(content.length);
    expect(textRows[0]!.bytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(textRows[0]!.truncated).toBe(0);

    const seenRows = tableRows(
      "SELECT session_key, turn_seq, hook_id, point, content_id, block_idx, asset_ids FROM attribution_block_seen",
    );
    expect(seenRows).toHaveLength(1);
    expect(seenRows[0]!.session_key).toBe("sess-1");
    expect(seenRows[0]!.turn_seq).toBe(3);
    expect(seenRows[0]!.hook_id).toBe("hook-a");
    expect(seenRows[0]!.point).toBe("system.suffix");
    expect(seenRows[0]!.content_id).toBe(textRows[0]!.content_id);
    expect(seenRows[0]!.block_idx).toBe(0);
    expect(seenRows[0]!.asset_ids).toBeNull();
  });

  it("content_hash 全局去重：同内容跨会话/跨 source 共享 text 行，seen 每处一条（§7 test 2）", () => {
    const content = "same block text";
    archiveTextBlock({
      sessionKey: "sess-a",
      turnSeq: 1,
      block: { type: "text", content, metadata: { source: "s-a" } },
      hookId: "hook-a",
      point: "system.suffix",
      blockIdx: 0,
    });
    archiveTextBlock({
      sessionKey: "sess-b",
      turnSeq: 1,
      block: { type: "text", content, metadata: { source: "s-b" } },
      hookId: "hook-b",
      point: "system.suffix",
      blockIdx: 0,
    });

    const textRows = tableRows("SELECT content_id, source FROM attribution_block_text");
    expect(textRows).toHaveLength(1); // source 不进唯一键：第二条共享首插行
    const seenRows = tableRows("SELECT session_key, hook_id FROM attribution_block_seen ORDER BY seen_id");
    expect(seenRows).toHaveLength(2);
    expect(seenRows.map((r) => r.session_key)).toEqual(["sess-a", "sess-b"]);
    const counters = getVisibleArchiveWriteCounters();
    expect(counters.blockTextInserted).toBe(1);
    expect(counters.blockTextDedupe).toBe(1);
    expect(counters.blockSeen).toBe(2);
    expect(counters.failures).toBe(0);
  });

  it("超 cap：truncated=1、chars=原长、content_utf8=前段（§7 test 3）", () => {
    const content = "0123456789ABCDEF";
    archiveTextBlock({
      sessionKey: "sess-1",
      turnSeq: 1,
      block: { type: "text", content, metadata: { source: "s" } },
      hookId: "hook-a",
      point: "system.suffix",
      blockIdx: 0,
      maxBlockChars: 8,
    });
    const row = tableRows("SELECT content_utf8, chars, truncated FROM attribution_block_text")[0]!;
    expect(row.content_utf8).toBe("01234567");
    expect(row.chars).toBe(content.length);
    expect(row.truncated).toBe(1);
  });

  it("跳过非 text / 空内容 / 缺 sessionKey（§7 test 4 子集）", () => {
    archiveTextBlock({
      sessionKey: "sess-1",
      turnSeq: 1,
      block: { type: "tool_use", content: "tool", metadata: { tool_name: "f" } },
      hookId: "hook-a",
      point: "system.suffix",
      blockIdx: 0,
    });
    archiveTextBlock({
      sessionKey: "sess-1",
      turnSeq: 1,
      block: { type: "text", content: "" },
      hookId: "hook-a",
      point: "system.suffix",
      blockIdx: 1,
    });
    archiveTextBlock({
      sessionKey: "",
      turnSeq: 1,
      block: { type: "text", content: "no session" },
      hookId: "hook-a",
      point: "system.suffix",
      blockIdx: 2,
    });
    expect(tableRows("SELECT * FROM attribution_block_text")).toHaveLength(0);
    expect(tableRows("SELECT * FROM attribution_block_seen")).toHaveLength(0);
  });
});

// ── recordSessionContextBlock（接缝 B 合成块，B1）────────────────────────────

describe("recordSessionContextBlock（接缝 B / §7 test 10）", () => {
  it("固定 hook/point/source，内容与合入正文逐字节相同", () => {
    const systemAppend = "SESSION_CONTEXT:task=memory-proxy-demo\n";
    recordSessionContextBlock({ sessionKey: "sess-sc", turnSeq: 1, content: systemAppend });

    const seenRows = tableRows("SELECT hook_id, point, block_idx FROM attribution_block_seen");
    expect(seenRows).toHaveLength(1);
    expect(seenRows[0]!.hook_id).toBe(SESSION_CONTEXT_HOOK);
    expect(seenRows[0]!.point).toBe(SESSION_CONTEXT_POINT);
    expect(seenRows[0]!.block_idx).toBe(0);

    const textRows = tableRows("SELECT source, content_utf8, content_hash FROM attribution_block_text");
    expect(textRows[0]!.source).toBe(SESSION_CONTEXT_SOURCE);
    expect(textRows[0]!.content_utf8).toBe(systemAppend); // 逐字节
    expect(textRows[0]!.content_hash).toBe(sha256Of(systemAppend));
  });

  it("空 content / 缺 sessionKey 不落行", () => {
    recordSessionContextBlock({ sessionKey: "s", turnSeq: 1, content: "" });
    recordSessionContextBlock({ sessionKey: "", turnSeq: 1, content: "x" });
    expect(tableRows("SELECT * FROM attribution_block_seen")).toHaveLength(0);
  });
});

// ── VisibleBlockArchiveObserver.onHookDone（接缝 A）───────────────────────────

describe("VisibleBlockArchiveObserver（onHookDone，接缝 A）", () => {
  function meta(over: Partial<AgentContextMetadata> = {}): AgentContextMetadata {
    return {
      protocol: "anthropic",
      traceId: "trace-1",
      keyId: "key-1",
      modelId: "model-1",
      stream: false,
      agentSource: "codebuddy",
      ...over,
    };
  }

  const hook: InjectionHook = {
    id: "hook-t",
    point: "system.suffix",
    priority: 100,
    description: "test hook",
    execute: () => [],
  };

  it("每个 text block 一条 seen，block_idx 取全量列表下标；空/非 text 跳过", () => {
    const blocks: ContextBlock[] = [
      { type: "text", content: "alpha", metadata: { source: "b.src" } },
      { type: "custom", content: "skip-me" },
      { type: "text", content: "" },
      { type: "text", content: "omega" },
    ];
    const observer = new VisibleBlockArchiveObserver();
    observer.onHookDone(hook, "system.suffix", blocks, 1, undefined, meta({ sessionKey: "sess-ob", turnSeq: 2 }));

    const seenRows = tableRows(
      "SELECT turn_seq, hook_id, point, block_idx FROM attribution_block_seen ORDER BY seen_id",
    );
    expect(seenRows).toHaveLength(2);
    expect(seenRows[0]).toMatchObject({ turn_seq: 2, hook_id: "hook-t", point: "system.suffix", block_idx: 0 });
    expect(seenRows[1]).toMatchObject({ turn_seq: 2, hook_id: "hook-t", point: "system.suffix", block_idx: 3 });

    const textRows = tableRows("SELECT content_utf8, source FROM attribution_block_text ORDER BY content_id");
    expect(textRows).toHaveLength(2);
    expect(textRows[0]).toMatchObject({ content_utf8: "alpha", source: "b.src" });
    expect(textRows[1]).toMatchObject({ content_utf8: "omega", source: "hook-t" }); // 无 metadata.source → hook.id
  });

  it("缺 sessionKey / turnSeq 静默放弃（不落行、不 throw）", () => {
    const blocks: ContextBlock[] = [{ type: "text", content: "x" }];
    const observer = new VisibleBlockArchiveObserver();
    observer.onHookDone(hook, "system.suffix", blocks, 1, undefined, meta()); // 无 sessionKey/turnSeq
    observer.onHookDone(hook, "system.suffix", blocks, 1, undefined, meta({ sessionKey: "s", turnSeq: undefined }));
    expect(tableRows("SELECT * FROM attribution_block_seen")).toHaveLength(0);
    expect(getVisibleArchiveWriteCounters().failures).toBe(0);
  });

  it("DB 不可用时静默降级（Null repo / 零新表访问语义，§7 test 4 / test 11 子集）", () => {
    __resetVisibleTextRepoForTests();
    __resetDbForTests();
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "not a dir");
    process.env.PROXY_DB_PATH = path.join(blocker, "proxy.db");

    const observer = new VisibleBlockArchiveObserver();
    const warn = console.warn; // 保留真实实现：降级仅一条初始化 warn，不 throw
    expect(() => {
      observer.onHookDone(
        hook,
        "system.suffix",
        [{ type: "text", content: "x" }],
        1,
        undefined,
        meta({ sessionKey: "s", turnSeq: 1 }),
      );
    }).not.toThrow();
    expect(typeof warn).toBe("function");
    // Null repo：read 空、写 no-op，counters 无新增失败噪音可忽略
  });
});

// ── 单测侧观测：全程无真实失败（写计数器聚合）─────────────────────────────────

describe("write counters 纪律", () => {
  it("正常路径 failures 恒 0，去重计数只增不误报", () => {
    const c1 = getVisibleArchiveWriteCounters();
    expect(c1.failures).toBe(0);
    archiveTextBlock({
      sessionKey: "sess-x",
      turnSeq: 1,
      block: { type: "text", content: "dup-content" },
      hookId: "hook-x",
      point: "system.suffix",
      blockIdx: 0,
    });
    const c2 = getVisibleArchiveWriteCounters();
    expect(c2.blockSeen).toBe(c1.blockSeen + 1);
    expect(c2.failures).toBe(c1.failures);
  });
});

// ── §8.1 验收：静态注入块首轮落 text+seen、次轮 0 新 text / 1 新 seen ─────────────

describe("§8.1 验收：静态注入块两轮重注入的写入纪律（接缝 A）", () => {
  const SESSION = "sess-seam-a";
  const CONTENT = "<skills>\n  <name>qa</name>\n</skills>\n"; // 每轮重渲染的静态块

  const hook: InjectionHook = {
    id: "skill-listing-injector",
    point: "system.suffix",
    priority: 200,
    description: "static skill listing",
    execute: () => [],
  };

  function meta(turnSeq: number): AgentContextMetadata {
    return {
      protocol: "openai",
      traceId: "trace-seam-a",
      keyId: "key-seam-a",
      modelId: "model-seam-a",
      stream: false,
      agentSource: "codebuddy",
      sessionKey: SESSION,
      turnSeq,
    };
  }

  function block(): ContextBlock {
    return { type: "text", content: CONTENT, metadata: { source: "skill.v1" } };
  }

  it("次轮同内容重注入：text 行恒定 1 条、seen 每轮 +1（对照 §7 test 2 的跨会话形态）", () => {
    const observer = new VisibleBlockArchiveObserver();

    // 轮 1：落 text + seen
    observer.onHookDone(hook, "system.suffix", [block()], 1, undefined, meta(1));
    expect(tableRows("SELECT * FROM attribution_block_text")).toHaveLength(1);
    expect(tableRows("SELECT * FROM attribution_block_seen")).toHaveLength(1);

    // 轮 2：同内容重渲染 → 0 新 text、1 新 seen
    observer.onHookDone(hook, "system.suffix", [block()], 1, undefined, meta(2));
    const textRows = tableRows("SELECT content_id FROM attribution_block_text");
    const seenRows = tableRows("SELECT content_id, turn_seq FROM attribution_block_seen ORDER BY seen_id");
    expect(textRows).toHaveLength(1); // 静态注入每轮重渲染，content_hash 全局去重不膨胀
    expect(seenRows).toHaveLength(2); // occurrence 每轮一条
    expect(seenRows.map((r) => r.turn_seq)).toEqual([1, 2]);
    // 两条 occurrence 共享同一 text 行
    expect(seenRows[0]!.content_id).toBe(textRows[0]!.content_id);
    expect(seenRows[1]!.content_id).toBe(textRows[0]!.content_id);

    expect(getVisibleArchiveWriteCounters()).toMatchObject({
      blockTextInserted: 1,
      blockTextDedupe: 1,
      blockSeen: 2,
      failures: 0,
    });
  });
});
