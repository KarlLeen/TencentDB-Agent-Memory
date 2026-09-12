/**
 * visibleTextRepo 持久化 + 拼接 read 语义单测（40-visible-text-archive.md §5/§6，B4/B5）。
 *
 * 覆盖：
 *   - 四表 bootstrap（additive DDL，IF NOT EXISTS 幂等，SCHEMA_VERSION 仍 1）
 *   - 档① upsertBlockText 去重 + insertBlockSeen JOIN list 回读
 *   - 档② insertMessageSnap (session,epoch,index) 唯一冲突静默跳 + 水位 round-trip
 *   - windowVisibleText：默认当前水位 epoch、排序 (turn_seq, tier, seq)、turn 区间过滤、
 *     epoch 覆盖只滤档②消息（档①无 epoch 维度，诚实注记）、dedupeByContentHash 开/关折叠、
 *     空会话
 *   - archiveVisibleText：跨 epoch 归档超集（compaction 后原始 + 改写版本并存）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetDbForTests, getDb } from "../index.js";
import type { NewBlockSeen, NewBlockText, NewMessageSnap } from "../visibleTextRepo.js";
import { restoreIsolatedDbPath } from "../../__tests__/setup/isolate-db.js";
import {
  __resetVisibleTextRepoForTests,
  archiveVisibleText,
  getVisibleArchiveWriteCounters,
  getVisibleTextRepo,
  readWatermark,
  windowVisibleText,
} from "../visibleTextRepo.js";

let dir: string;

function withTempDb(): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-vtr-"));
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

/** 通过 repo 层写一条档① block（text + seen），返回 text row。 */
function seedBlock(
  sessionKey: string,
  turnSeq: number,
  content: string,
  over: Partial<{ source: string; hookId: string; point: string; blockIdx: number; truncated: boolean }> = {},
): void {
  const repo = getVisibleTextRepo();
  const text: NewBlockText = {
    source: over.source ?? "session.context",
    contentHash: `hash-${content}`,
    contentUtf8: content,
    chars: content.length,
    bytes: Buffer.byteLength(content, "utf8"),
    truncated: over.truncated ?? false,
  };
  const { contentId } = repo.upsertBlockText(text);
  const seen: NewBlockSeen = {
    sessionKey,
    turnSeq,
    hookId: over.hookId ?? "seed-hook",
    point: over.point ?? "system.prepend",
    contentId,
    blockIdx: over.blockIdx ?? 0,
    assetIdsJson: null,
  };
  repo.insertBlockSeen(seen);
}

function seedMessage(
  sessionKey: string,
  epoch: number,
  turnSeq: number,
  messageIndex: number,
  role: string,
  content: string,
  over: { contentHash?: string } = {},
): void {
  const snap: NewMessageSnap = {
    sessionKey,
    epoch,
    turnSeq,
    messageIndex,
    role,
    contentHash: over.contentHash ?? `hash-msg-${messageIndex}-${epoch}`,
    contentJson: JSON.stringify(content),
    chars: content.length,
    truncated: false,
  };
  getVisibleTextRepo().insertMessageSnap(snap);
}

describe("四表 bootstrap（§6 命名冻结，additive DDL）", () => {
  it("创建 attribution_block_text / _seen / _message_snap / _archive_watermark", () => {
    const db = getDb();
    expect(db).not.toBeNull();
    const names = db!
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    for (const t of [
      "attribution_block_text",
      "attribution_block_seen",
      "attribution_message_snap",
      "attribution_archive_watermark",
    ]) {
      expect(names.map((r) => r.name)).toContain(t);
    }
    // IF NOT EXISTS：二次建表（经 getDb 再次 runSchema 场景等价）不 throw
    expect(() => {
      db!.prepare("SELECT * FROM attribution_block_text LIMIT 1").all();
      db!.prepare("SELECT * FROM attribution_message_snap LIMIT 1").all();
      db!.prepare("SELECT * FROM attribution_archive_watermark LIMIT 1").all();
    }).not.toThrow();
  });
});

describe("档① 持久化（block_text 去重 + block_seen JOIN 回读）", () => {
  it("同 content_hash → text 行 1 条 + contentId 复用；source 不参与唯一键", () => {
    const repo = getVisibleTextRepo();
    const mk = (source: string): NewBlockText => ({
      source,
      contentHash: "same-hash",
      contentUtf8: "body",
      chars: 4,
      bytes: 4,
      truncated: false,
    });
    const a = repo.upsertBlockText(mk("s1"));
    const b = repo.upsertBlockText(mk("s2"));
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(b.contentId).toBe(a.contentId);
    const counters = getVisibleArchiveWriteCounters();
    expect(counters.blockTextInserted).toBe(1);
    expect(counters.blockTextDedupe).toBe(1);
    expect(counters.failures).toBe(0);
  });

  it("insertBlockSeen → listBlockSeen JOIN text 完整回读（含 truncated/asset_ids）", () => {
    const repo = getVisibleTextRepo();
    seedBlock("sess-a", 2, "archived body", {
      source: "asset.src",
      hookId: "hook-a",
      point: "system.suffix",
      blockIdx: 1,
      truncated: true,
    });
    const rows = repo.listBlockSeen("sess-a");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.turn_seq).toBe(2);
    expect(rows[0]!.hook_id).toBe("hook-a");
    expect(rows[0]!.point).toBe("system.suffix");
    expect(rows[0]!.block_idx).toBe(1);
    expect(rows[0]!.source).toBe("asset.src");
    expect(rows[0]!.content_utf8).toBe("archived body");
    expect(rows[0]!.truncated).toBe(1);
    expect(rows[0]!.asset_ids).toBeNull();
    // 会话隔离
    expect(repo.listBlockSeen("sess-other")).toHaveLength(0);
  });
});

describe("档② 持久化（snap 唯一冲突 + 水位 round-trip）", () => {
  it("(session_key, epoch, message_index) 唯一冲突静默跳，计 dedupe 不 throw", () => {
    const repo = getVisibleTextRepo();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedMessage("sess-s", 0, 1, 2, "user", "msg");
    seedMessage("sess-s", 0, 1, 2, "user", "msg"); // 同锚重放
    seedMessage("sess-s", 1, 1, 2, "user", "msg-rewritten"); // 新 epoch 同 index 合法
    expect(repo.listMessageSnaps("sess-s")).toHaveLength(2);
    expect(info).toHaveBeenCalled(); // 预期 dedupe = info
    expect(warn).not.toHaveBeenCalled();
    const counters = getVisibleArchiveWriteCounters();
    expect(counters.messageSnapInserted).toBe(2);
    expect(counters.messageSnapDedupe).toBe(1);
    info.mockRestore();
    warn.mockRestore();
  });

  it("水位 upsert：INSERT OR REPLACE 单行每会话，读回 epoch + last_seen_count", () => {
    const repo = getVisibleTextRepo();
    expect(repo.getWatermark("sess-w")).toBeNull();
    repo.upsertWatermark("sess-w", 0, 4);
    expect(repo.getWatermark("sess-w")).toMatchObject({ session_key: "sess-w", epoch: 0, last_seen_count: 4 });
    repo.upsertWatermark("sess-w", 1, 2); // compaction
    expect(repo.getWatermark("sess-w")).toMatchObject({ epoch: 1, last_seen_count: 2 });
    expect(repo.getWatermark("other")).toBeNull();
  });
});

describe("windowVisibleText（§5 分侧诚实 + 排序语义）", () => {
  const S = "sess-win";

  /** turn1：block(ctx) + msg idx0(idx1 语义简化：直接 0/1) ；turn2：msg idx2；epoch0 水位 3。 */
  function seedSession(): void {
    seedBlock(S, 1, "ctx-turn1", { source: "session.context" });
    seedMessage(S, 0, 1, 0, "user", "hello");
    seedMessage(S, 0, 1, 1, "assistant", "hi");
    seedMessage(S, 0, 2, 2, "user", "world");
    getVisibleTextRepo().upsertWatermark(S, 0, 3);
  }

  it("默认当前水位 epoch；排序 (turn_seq, tier, seq) 同轮内 block 先于 message", () => {
    seedSession();
    const win = windowVisibleText(getVisibleTextRepo(), S);
    expect(win.epoch).toBe(0);
    expect(win.pieces).toHaveLength(4);
    const order = win.pieces.map((p) => `${p.tier}:${p.turnSeq}:${p.seq}`);
    expect(order).toEqual(["block:1:0", "message:1:0", "message:1:1", "message:2:2"]);

    const [b, m0, m1, m2] = win.pieces;
    expect(b).toMatchObject({
      tier: "block",
      turnSeq: 1,
      seq: 0,
      epoch: null,
      role: null,
      source: "session.context",
      content: "ctx-turn1",
    });
    // 档② piece.content = content_json 原样字符串（repo 不解业务对象）：消息文本需 JSON.parse。
    expect(m0).toMatchObject({ tier: "message", turnSeq: 1, seq: 0, epoch: 0, role: "user" });
    expect(JSON.parse(m0!.content)).toBe("hello");
    expect(m1).toMatchObject({ tier: "message", role: "assistant" });
    expect(JSON.parse(m1!.content)).toBe("hi");
    expect(m2).toMatchObject({ tier: "message", turnSeq: 2, seq: 2, role: "user" });
    expect(JSON.parse(m2!.content)).toBe("world");
  });

  it("turn 区间过滤只影响对应轮次（块按 turn_seq、消息按 turn_seq）", () => {
    seedSession();
    const turn1 = windowVisibleText(getVisibleTextRepo(), S, { turnFrom: 1, turnTo: 1 });
    expect(turn1.pieces.map((p) => p.turnSeq)).toEqual([1, 1, 1]);
    const from2 = windowVisibleText(getVisibleTextRepo(), S, { turnFrom: 2 });
    expect(from2.pieces.map((p) => p.turnSeq)).toEqual([2]);
  });

  it("档①无 epoch 维度：epoch 只过滤消息，不滤块（诚实注记）", () => {
    seedSession();
    // compaction：同 (session, index=2) 在 epoch1 改写，水位推进到 epoch1
    seedMessage(S, 1, 2, 2, "user", "world-rewritten");
    getVisibleTextRepo().upsertWatermark(S, 1, 3);

    const cur = windowVisibleText(getVisibleTextRepo(), S); // 默认 epoch = 水位 epoch1
    expect(cur.epoch).toBe(1);
    expect(cur.pieces.some((p) => p.tier === "block" && p.content === "ctx-turn1")).toBe(true); // 档①跨 epoch 并入
    const msgs = cur.pieces.filter((p) => p.tier === "message");
    expect(msgs).toHaveLength(1); // 单 epoch 视图只含当前代消息（epoch1 的改写行）
    expect(msgs[0]).toMatchObject({ epoch: 1, turnSeq: 2, seq: 2, role: "user" });
    expect(JSON.parse(msgs[0]!.content)).toBe("world-rewritten");
    expect(cur.pieces.some((p) => p.tier === "message" && p.epoch === 0)).toBe(false); // 不混代

    const e0 = windowVisibleText(getVisibleTextRepo(), S, { epoch: 0 });
    const e0msgs = e0.pieces.filter((p) => p.tier === "message");
    expect(e0msgs).toHaveLength(3);
    expect(e0msgs.some((p) => JSON.parse(p.content) === "world")).toBe(true);
    expect(e0msgs.some((p) => p.epoch === 1)).toBe(false);
  });

  it("空会话：无水位行 → epoch=0、pieces 空、readWatermark 兜底 0", () => {
    const win = windowVisibleText(getVisibleTextRepo(), "nobody");
    expect(win).toEqual({ epoch: 0, pieces: [] });
    expect(readWatermark(getVisibleTextRepo(), "nobody")).toEqual({ epoch: 0, lastSeen: 0 });
  });
});

describe("windowVisibleText read 期折叠 dedupeByContentHash（§5 / B5 read 选项）", () => {
  const S = "sess-fold";

  it("缺省关：同 content_hash 的跨档/跨轮重复 piece 照常返回（超集语义保留）", () => {
    // 档① 合成块 content="ctx"（seedBlock 的 hash = `hash-${content}`）；档② 消息逐字节同文
    // 且 contentHash 显式取同值 —— 模拟生产"档①合成块与某消息逐字节相同"的罕见跨档重复。
    seedBlock(S, 1, "ctx", { source: "session.context" });
    seedMessage(S, 0, 2, 2, "user", "ctx", { contentHash: "hash-ctx" });
    seedMessage(S, 0, 2, 3, "user", "world");
    getVisibleTextRepo().upsertWatermark(S, 0, 4);

    const win = windowVisibleText(getVisibleTextRepo(), S);
    expect(win.pieces).toHaveLength(3); // 全部保留，无折叠
    expect(win.pieces.map((p) => `${p.tier}:${p.turnSeq}:${p.seq}`)).toEqual([
      "block:1:0",
      "message:2:2",
      "message:2:3",
    ]);
    // 两条同 hash piece（block + message）都在
    const sameHash = win.pieces.filter((p) => p.contentHash === "hash-ctx");
    expect(sameHash).toHaveLength(2);
    expect(sameHash.map((p) => p.tier)).toEqual(["block", "message"]);
  });

  it("开启：同 content_hash 折叠整条同内容，保留窗口序首次出现（block 先于 message）", () => {
    seedBlock(S, 1, "ctx", { source: "session.context" });
    seedMessage(S, 0, 2, 2, "user", "ctx", { contentHash: "hash-ctx" });
    seedMessage(S, 0, 2, 3, "user", "world");
    getVisibleTextRepo().upsertWatermark(S, 0, 4);

    const win = windowVisibleText(getVisibleTextRepo(), S, { dedupeByContentHash: true });
    expect(win.pieces).toHaveLength(2);
    expect(win.pieces[0]).toMatchObject({ tier: "block", turnSeq: 1, content: "ctx" }); // 首次出现保留
    expect(win.pieces[1]).toMatchObject({ tier: "message", turnSeq: 2, seq: 3, role: "user" });
    expect(JSON.parse(win.pieces[1]!.content)).toBe("world");
  });

  it("开启：静态注入每轮重渲染 → 跨轮同 hash 只留最早 occurrence；不同 hash 不误折叠", () => {
    seedBlock(S, 1, "ctx", { source: "session.context" });
    seedBlock(S, 2, "ctx", { source: "session.context" }); // 同内容次轮重注入（text 去重 + 新 seen）
    seedBlock(S, 2, "other", { source: "skill.v1" });
    getVisibleTextRepo().upsertWatermark(S, 0, 0);

    const win = windowVisibleText(getVisibleTextRepo(), S, { dedupeByContentHash: true });
    expect(win.pieces.map((p) => [p.tier, p.turnSeq, p.seq, p.content])).toEqual([
      ["block", 1, 0, "ctx"],
      ["block", 2, 0, "other"],
    ]);
  });
});

describe("archiveVisibleText（跨 epoch 归档超集，B4）", () => {
  it("compaction 后原始 + 改写版本并存，按 (epoch, turn_seq, seq) 升序", () => {
    seedBlock("sess-arc", 1, "ctx");
    seedMessage("sess-arc", 0, 1, 1, "user", "v1");
    seedMessage("sess-arc", 1, 1, 1, "user", "v1-rewritten"); // 压缩改写占据同 index
    seedMessage("sess-arc", 1, 2, 2, "user", "next");
    getVisibleTextRepo().upsertWatermark("sess-arc", 1, 3);

    const archive = archiveVisibleText(getVisibleTextRepo(), "sess-arc");
    expect(archive.epochs).toEqual([0, 1]);
    // 超集只有消息（归档面 = 档②），块不进 archive()
    expect(archive.pieces).toHaveLength(3);
    expect(archive.pieces.map((p) => [p.epoch, p.turnSeq, p.seq])).toEqual([
      [0, 1, 1],
      [1, 1, 1],
      [1, 2, 2],
    ]);
    expect(archive.pieces.map((p) => JSON.parse(p.content))).toEqual(["v1", "v1-rewritten", "next"]);
    expect(archive.pieces.some((p) => p.content === "ctx")).toBe(false);
  });
});

describe("Null repo 降级", () => {
  it("DB 不可初始化时读写全部 no-op（写零噪音、读空）", () => {
    __resetVisibleTextRepoForTests();
    __resetDbForTests();
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "not a dir");
    process.env.PROXY_DB_PATH = path.join(blocker, "proxy.db");

    const repo = getVisibleTextRepo();
    const text: NewBlockText = {
      source: "s",
      contentHash: "h",
      contentUtf8: "c",
      chars: 1,
      bytes: 1,
      truncated: false,
    };
    expect(repo.upsertBlockText(text)).toEqual({ contentId: 0, inserted: false });
    seedMessage("sess-n", 0, 1, 0, "user", "x"); // Null repo insertMessageSnap no-op
    expect(repo.listBlockSeen("sess-n")).toEqual([]);
    expect(repo.listMessageSnaps("sess-n")).toEqual([]);
    expect(repo.listEpochs("sess-n")).toEqual([]);
    expect(repo.getWatermark("sess-n")).toBeNull();
  });
});
