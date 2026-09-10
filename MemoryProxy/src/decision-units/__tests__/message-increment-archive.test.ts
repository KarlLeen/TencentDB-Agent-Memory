/**
 * 档② message-increment archive 单测（40-visible-text-archive.md §7 test 5/6 + §4.2/§4.3）。
 *
 * 覆盖：
 *   - messageTextFingerprint / truncateMessageContent（内容归一 + cap 诚实截断，§4.3 / C2）
 *   - deriveSegmentTurnSeqs（§4.2 轮次推导，与 turnSeq.ts isHumanUserContent/countHumanTurns
 *     同源；逐索引断言 == countHumanTurns(messages.slice(0, i+1))）
 *   - archiveMessageIncrement 全链路（temp SQLite）：缺省关不写、首段 epoch0、增量只录新尾、
 *     system 行不入档但计入水位、compaction → epoch+1 归零重放且旧 epoch 行保留、超 cap 截断
 *   - classifySameTurnWholeContainment（§7 test 7 / R1-B2 收窄互斥断言）：同轮 user/assistant
 *     消息不得整块包含档① block；tool/system 行合法例外；跨轮不配对；脏数据不 throw
 *
 * 水位语义镜像 decision-unit-runner.ts:126-127（messageCount < 水位 ⇒ 归零重放），B4。
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
  windowVisibleText,
} from "../../db/visibleTextRepo.js";
import type { BlockSeenWithTextRow, MessageSnapRow } from "../../db/visibleTextRepo.js";
import { sha256Of } from "../../injection/visible-block-archive-observer.js";
import { countHumanTurns } from "../../turnSeq.js";
import {
  DEFAULT_MAX_MESSAGE_CHARS,
  archiveMessageIncrement,
  classifySameTurnWholeContainment,
  deriveSegmentTurnSeqs,
  messageTextFingerprint,
  truncateMessageContent,
} from "../message-increment-archive.js";

let dir: string;

function withTempDb(): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-msg-arc-"));
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
const om = (role: string, content: unknown): Msg => ({ role, content });

/** 缺省开启配置（单测不改 cap）。 */
function cfg(over?: { enabled?: boolean; maxMessageChars?: number }) {
  return {
    injection: {
      visibleArchive: { enabled: true, ...(over ?? {}) },
    },
  };
}

// ── messageTextFingerprint ────────────────────────────────────────────────────

describe("messageTextFingerprint（正文 fingerprint 口径，§4.3 / C2）", () => {
  it("string 原样返回", () => {
    expect(messageTextFingerprint("hello")).toBe("hello");
    expect(messageTextFingerprint("")).toBe("");
  });

  it("text blocks 按序 \n 拼接；非 text block 跳过", () => {
    const arr = [
      { type: "tool_use", name: "f", input: { a: 1 } },
      { type: "text", text: "alpha" },
      { type: "text", text: "beta" },
    ];
    expect(messageTextFingerprint(arr)).toBe("alpha\nbeta");
  });

  it("tool_result 递归抽取（string 或 text-block 数组形态）", () => {
    expect(
      messageTextFingerprint([
        { type: "tool_result", tool_use_id: "t1", content: "out" },
      ]),
    ).toBe("out");
    expect(
      messageTextFingerprint([
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "r1" }, { type: "text", text: "r2" }] },
      ]),
    ).toBe("r1\nr2");
  });

  it("非 string / 非数组内容视为空（脏数据不 throw）", () => {
    expect(messageTextFingerprint(42)).toBe("");
    expect(messageTextFingerprint(null)).toBe("");
  });
});

// ── truncateMessageContent ────────────────────────────────────────────────────

describe("truncateMessageContent（超 cap 截断后仍为合法 JSON，§4.3 / C2）", () => {
  it("string 超预算取前 maxChars", () => {
    const out = truncateMessageContent("x".repeat(100), 10);
    expect(typeof out).toBe("string");
    expect(out).toBe("x".repeat(10));
  });

  it("数组保持结构，text 逐段削到预算内（预算耗尽时不再保留尾随块）", () => {
    const arr = [{ type: "text", text: "aaa" }, { type: "tool_use", name: "f", input: { a: 1 } }];
    const out = truncateMessageContent(arr, 2) as unknown[];
    expect(JSON.parse(JSON.stringify(out))).toEqual([{ type: "text", text: "aa" }]); // budget 2 耗尽 → 尾随块不保留

    // budget 充足时非 text 块原样保留、不耗预算
    const ok = truncateMessageContent(
      [{ type: "tool_use", name: "f", input: { a: 1 } }, { type: "text", text: "aaa" }],
      4,
    ) as unknown[];
    expect(JSON.parse(JSON.stringify(ok))).toEqual([
      { type: "tool_use", name: "f", input: { a: 1 } },
      { type: "text", text: "aaa" },
    ]);
  });

  it("嵌套 tool_result 共享预算", () => {
    const arr = [
      { type: "text", text: "aaa" },
      { type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "bbbb" }] },
    ];
    const out = truncateMessageContent(arr, 6) as unknown[];
    const json = JSON.parse(JSON.stringify(out)) as Array<{
      text?: string;
      content?: Array<{ text: string }>;
    }>;
    expect(json[0]!.text).toBe("aaa");
    expect(json[1]!.content).toEqual([{ type: "text", text: "bbb" }]); // budget 6-3=3
  });
});

// ── deriveSegmentTurnSeqs（§4.2 / B3）─────────────────────────────────────────

describe("deriveSegmentTurnSeqs（轮次推导与 turnSeq.ts 同源）", () => {
  it("openai：role=tool 不算人类轮；system/assistant 不增轮", () => {
    const msgs: Msg[] = [
      om("system", "You are a proxy."),
      om("user", "hello"),
      om("assistant", "hi"),
      om("tool", "{\"o\":1}"),
      om("user", "world"),
      om("assistant", "done"),
    ];
    expect(deriveSegmentTurnSeqs(msgs, 0, "openai")).toEqual([0, 1, 1, 1, 2, 2]);
    // 增量段语义：fromIndex=3 起，前缀计数只含 idx0..2 的人类轮 → [1, 2, 2]
    expect(deriveSegmentTurnSeqs(msgs, 3, "openai")).toEqual([1, 2, 2]);
  });

  it("anthropic：tool_result-only user 消息与 <system-reminder> 不算人类轮", () => {
    const msgs: Msg[] = [
      om("user", [{ type: "tool_result", tool_use_id: "t0", content: "r0" }]),
      om("user", "question one"),
      om("assistant", [{ type: "text", text: "thinking" }]),
      om("user", "<system-reminder>auto-continue</system-reminder>"),
      om("user", "question two"),
    ];
    expect(deriveSegmentTurnSeqs(msgs, 0, "anthropic")).toEqual([0, 1, 1, 1, 2]);
    expect(deriveSegmentTurnSeqs(msgs, 3, "anthropic")).toEqual([1, 2]);
  });

  it("每条消息 turn_seq == countHumanTurns(前缀)（与 extractor turnSeqOf 同语义）", () => {
    const msgs: Msg[] = [
      om("system", "s"),
      om("user", "a"),
      om("assistant", [{ type: "text", text: "t1" }]),
      om("user", [{ type: "tool_result", tool_use_id: "t", content: "r" }]),
      om("user", "b"),
      om("user", "<system-reminder>loop</system-reminder>"),
    ];
    const derived = deriveSegmentTurnSeqs(msgs, 0, "openai");
    for (let i = 0; i < msgs.length; i++) {
      expect(derived[i]).toBe(countHumanTurns(msgs.slice(0, i + 1), "openai"));
    }
  });
});

// ── archiveMessageIncrement 全链路 ─────────────────────────────────────────────

describe("archiveMessageIncrement（全链路，temp SQLite）", () => {
  const SESSION = "sess-arc";
  // idx0=system（不入档但计水位），idx1/2/3 = user/assistant/user（全录，epoch0）
  const BASE: Msg[] = [
    om("system", "You are a proxy."),
    om("user", "first question"),
    om("assistant", "first ack"),
    om("user", "second question"),
  ];

  it("visibleArchive 缺省关 / 无 sessionKey 时零写入（§7 test 11 子集）", () => {
    archiveMessageIncrement({ config: {}, protocol: "openai", messages: BASE, sessionKey: SESSION });
    archiveMessageIncrement({
      config: { injection: { visibleArchive: { enabled: false } } },
      protocol: "openai",
      messages: BASE,
      sessionKey: SESSION,
    });
    archiveMessageIncrement({
      config: cfg(),
      protocol: "openai",
      messages: BASE,
      sessionKey: "",
    });
    const repo = getVisibleTextRepo();
    expect(repo.listMessageSnaps(SESSION)).toHaveLength(0);
    expect(repo.getWatermark(SESSION)).toBeNull();
  });

  it("首轮全量入 epoch0，水位 = messageCount，索引/role/turn_seq 精确", () => {
    archiveMessageIncrement({ config: cfg(), protocol: "openai", messages: BASE, sessionKey: SESSION });
    const repo = getVisibleTextRepo();
    const snaps = repo.listMessageSnaps(SESSION);
    expect(snaps.map((s) => s.message_index)).toEqual([1, 2, 3]);
    expect(snaps.map((s) => s.role)).toEqual(["user", "assistant", "user"]);
    expect(snaps.map((s) => s.turn_seq)).toEqual([1, 1, 2]);
    expect(snaps.map((s) => s.epoch)).toEqual([0, 0, 0]);
    expect(snaps.map((s) => s.truncated)).toEqual([0, 0, 0]);
    expect(snaps[0]!.content_json).toBe(JSON.stringify("first question"));
    expect(snaps[0]!.content_hash).toBe(sha256Of("first question"));
    expect(repo.getWatermark(SESSION)).toMatchObject({ epoch: 0, last_seen_count: 4 });
    expect(getVisibleArchiveWriteCounters().messageSnapInserted).toBe(3);

    // 同批重放：messageCount <= 水位 → 0 新增、0 dedupe（不进插入路径）
    archiveMessageIncrement({ config: cfg(), protocol: "openai", messages: BASE, sessionKey: SESSION });
    expect(repo.listMessageSnaps(SESSION)).toHaveLength(3);
    expect(getVisibleArchiveWriteCounters().messageSnapDedupe).toBe(0);
    expect(getVisibleArchiveWriteCounters().messageSnapInserted).toBe(3);
  });

  it("延长会话只录新尾（工具循环延续同轮，turn_seq 不再增）", () => {
    archiveMessageIncrement({ config: cfg(), protocol: "openai", messages: BASE, sessionKey: SESSION });
    const extended: Msg[] = [
      ...BASE,
      om("tool", "{\"rows\": 3}"),
      om("assistant", "tool ack"),
    ];
    archiveMessageIncrement({ config: cfg(), protocol: "openai", messages: extended, sessionKey: SESSION });
    const repo = getVisibleTextRepo();
    const snaps = repo.listMessageSnaps(SESSION);
    expect(snaps).toHaveLength(5);
    const tail = snaps.slice(3);
    expect(tail.map((s) => s.message_index)).toEqual([4, 5]);
    expect(tail.map((s) => s.role)).toEqual(["tool", "assistant"]);
    expect(tail.map((s) => s.turn_seq)).toEqual([2, 2]);
    expect(repo.getWatermark(SESSION)).toMatchObject({ epoch: 0, last_seen_count: 6 });
  });

  it("system 行不入档但仍推进水位（消息流位置由 message_index 保留）", () => {
    archiveMessageIncrement({
      config: cfg(),
      protocol: "openai",
      messages: [om("system", "only a system row")],
      sessionKey: SESSION,
    });
    const repo = getVisibleTextRepo();
    expect(repo.listMessageSnaps(SESSION)).toHaveLength(0);
    expect(repo.getWatermark(SESSION)).toMatchObject({ epoch: 0, last_seen_count: 1 });
  });

  it("超 cap 截断：truncated=1、chars=原长、content 存前段合法 JSON、hash=全文 fingerprint", () => {
    const long = "L".repeat(40);
    archiveMessageIncrement({
      config: cfg({ maxMessageChars: 8 }),
      protocol: "openai",
      messages: [om("user", long)],
      sessionKey: SESSION,
    });
    const repo = getVisibleTextRepo();
    const snaps = repo.listMessageSnaps(SESSION);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.chars).toBe(40);
    expect(snaps[0]!.truncated).toBe(1);
    expect(JSON.parse(snaps[0]!.content_json)).toBe("L".repeat(8));
    expect(snaps[0]!.content_hash).toBe(sha256Of(long));
  });

  it("anthropic 数组内容（assistant text / user tool_result）round-trip 原样", () => {
    const msgs: Msg[] = [
      om("user", "ask"),
      om("assistant", [{ type: "text", text: "block one" }, { type: "text", text: "block two" }]),
      om("user", [{ type: "tool_result", tool_use_id: "t9", content: "fetched payload" }]),
    ];
    archiveMessageIncrement({ config: cfg(), protocol: "anthropic", messages: msgs, sessionKey: SESSION });
    const repo = getVisibleTextRepo();
    const snaps = repo.listMessageSnaps(SESSION);
    expect(snaps).toHaveLength(3);
    expect(JSON.parse(snaps[1]!.content_json)).toEqual([
      { type: "text", text: "block one" },
      { type: "text", text: "block two" },
    ]);
    // tool_result-only user 消息不算人类轮 → turn_seq 停在 1
    expect(snaps[2]!.role).toBe("user");
    expect(snaps[2]!.turn_seq).toBe(1);
    expect(snaps[2]!.content_hash).toBe(sha256Of("fetched payload"));
  });

  it("§8.2 长 tool_result（cap 内）原样还原，并在拼接窗口可逐字节锚定", () => {
    // 采样量级对齐 §8.2 的 long-probe（~21k），构造 cap(65,536) 内的 24k 召回 payload。
    const payload = `FETCHED-DOC-HEAD\n${"memory line\n".repeat(2_000)}FETCHED-DOC-TAIL`;
    expect(payload.length).toBeGreaterThan(20_000);
    expect(payload.length).toBeLessThan(DEFAULT_MAX_MESSAGE_CHARS);

    const msgs: Msg[] = [
      om("system", "You are a proxy."),
      om("user", "recall the fetched doc"),
      om("assistant", [{ type: "text", text: "recalling" }]),
      om("user", [{ type: "tool_result", tool_use_id: "t-doc", content: payload }]),
    ];
    archiveMessageIncrement({ config: cfg(), protocol: "anthropic", messages: msgs, sessionKey: SESSION });

    const repo = getVisibleTextRepo();
    const snap = repo.listMessageSnaps(SESSION).find((s) => s.content_hash === sha256Of(payload));
    expect(snap).toBeDefined();
    // 原样还原：未截断、chars = 可见正文原长、content_json 逐字节 == 来源 payload
    expect(snap!.truncated).toBe(0);
    expect(snap!.chars).toBe(payload.length);
    expect(snap!.role).toBe("user");
    const parsed = JSON.parse(snap!.content_json) as Array<{ type: string; content: string }>;
    expect(parsed[0]!.type).toBe("tool_result");
    expect(parsed[0]!.content).toBe(payload);
    expect(Buffer.byteLength(parsed[0]!.content, "utf8")).toBe(Buffer.byteLength(payload, "utf8"));

    // 拼接窗口锚定：该 piece 可定位（epoch/turn/seq 槽位），可见正文逐字节等于来源（引用验证可锚定）
    const win = windowVisibleText(repo, SESSION);
    const piece = win.pieces.find((p) => p.tier === "message" && p.contentHash === sha256Of(payload));
    expect(piece).toBeDefined();
    expect(piece).toMatchObject({
      epoch: 0,
      turnSeq: 1,
      seq: 3,
      role: "user",
      truncated: false,
      chars: payload.length,
    });
    expect(messageTextFingerprint(JSON.parse(piece!.content))).toBe(payload);
  });

  it("compaction（messageCount < 水位）→ epoch+1 归零重放；旧 epoch 行保留、改写不吞行（B4）", () => {
    archiveMessageIncrement({ config: cfg(), protocol: "openai", messages: BASE, sessionKey: SESSION });
    const repo = getVisibleTextRepo();
    expect(repo.getWatermark(SESSION)).toMatchObject({ epoch: 0, last_seen_count: 4 });

    // 会话被剪枝 + 改写：只剩 system + 一条改写后的 user 首问（count 2 < 4）
    const rewritten: Msg[] = [om("system", "You are a proxy."), om("user", "first question (rewritten)")];
    archiveMessageIncrement({ config: cfg(), protocol: "openai", messages: rewritten, sessionKey: SESSION });

    expect(repo.getWatermark(SESSION)).toMatchObject({ epoch: 1, last_seen_count: 2 });
    expect(repo.listEpochs(SESSION)).toEqual([0, 1]);

    // 旧 epoch 行保留（归档超集不吞行）
    const e0 = repo.listMessageSnaps(SESSION, { epoch: 0 });
    expect(e0).toHaveLength(3);
    // 新 epoch 重放：rewritten 只落 idx1（system idx0 跳过），turn_seq 从 0 起重算
    const e1 = repo.listMessageSnaps(SESSION, { epoch: 1 });
    expect(e1).toHaveLength(1);
    expect(e1[0]!.message_index).toBe(1);
    expect(e1[0]!.turn_seq).toBe(1);
    expect(JSON.parse(e1[0]!.content_json)).toBe("first question (rewritten)");
    // 改写内容落新 epoch 行，与旧 epoch 同 index 的原始版本并存
    const e0idx1 = e0.find((s) => s.message_index === 1);
    expect(JSON.parse(e0idx1!.content_json)).toBe("first question");
    expect(e0.find((s) => s.message_index === 2)).toBeDefined();
    expect(e0.find((s) => s.message_index === 3)).toBeDefined();
  });

  it("compaction 后同批重放 0 新增且水位不漂移", () => {
    archiveMessageIncrement({ config: cfg(), protocol: "openai", messages: BASE, sessionKey: SESSION });
    const compact: Msg[] = [om("system", "You are a proxy."), om("user", "first question (rewritten)")];
    archiveMessageIncrement({ config: cfg(), protocol: "openai", messages: compact, sessionKey: SESSION });
    const before = getVisibleArchiveWriteCounters().messageSnapInserted;
    const wmBefore = getVisibleTextRepo().getWatermark(SESSION);
    archiveMessageIncrement({ config: cfg(), protocol: "openai", messages: compact, sessionKey: SESSION });
    expect(getVisibleArchiveWriteCounters().messageSnapInserted).toBe(before);
    expect(getVisibleTextRepo().getWatermark(SESSION)).toMatchObject({
      epoch: wmBefore?.epoch,
      last_seen_count: wmBefore?.last_seen_count,
    });
  });

  it("空消息列表不写任何东西；空内容消息不落行（水位照常推进已见条数）", () => {
    expect(() =>
      archiveMessageIncrement({ config: cfg(), protocol: "openai", messages: [], sessionKey: SESSION }),
    ).not.toThrow();
    expect(getVisibleTextRepo().getWatermark(SESSION)).toBeNull();

    archiveMessageIncrement({ config: cfg(), protocol: "openai", messages: [om("user", "")], sessionKey: SESSION });
    const db = getDb();
    const n = db!
      .prepare("SELECT COUNT(*) AS n FROM attribution_message_snap WHERE session_key = ?")
      .get(SESSION) as { n: number };
    expect(Number(n.n)).toBe(0); // 空 fingerprint 不落行
    expect(getVisibleTextRepo().getWatermark(SESSION)).toMatchObject({ epoch: 0, last_seen_count: 1 });
  });
});

// ── classifySameTurnWholeContainment（§7 test 7 / R1-B2 收窄互斥断言）─────────────

const BLOCK_XML = "<skills>\n  <name>qa</name>\n</skills>\n";

let rowSeq = 0;

function blockRow(turnSeq: number, content: string, over: Partial<BlockSeenWithTextRow> = {}): BlockSeenWithTextRow {
  rowSeq += 1;
  return {
    seen_id: rowSeq,
    session_key: "sess-guard",
    turn_seq: turnSeq,
    hook_id: "skill-listing-injector",
    point: "system.suffix",
    block_idx: 0,
    asset_ids: null,
    content_id: rowSeq,
    source: "skill.v1",
    content_hash: sha256Of(content),
    content_utf8: content,
    chars: content.length,
    bytes: Buffer.byteLength(content, "utf8"),
    truncated: 0,
    ...over,
  };
}

function messageRow(
  role: string,
  text: string,
  messageIndex: number,
  turnSeq: number,
  over: Partial<MessageSnapRow> = {},
): MessageSnapRow {
  return {
    msg_id: 0,
    session_key: "sess-guard",
    epoch: 0,
    turn_seq: turnSeq,
    message_index: messageIndex,
    role,
    content_hash: sha256Of(text),
    content_json: JSON.stringify(text),
    chars: text.length,
    truncated: 0,
    ...over,
  };
}

describe("classifySameTurnWholeContainment（§7 test 7 / B2 收窄互斥断言）", () => {
  it("同轮 user 消息整块包含 block → 判违规 whole，归属分类字段齐全", () => {
    const block = blockRow(2, BLOCK_XML, { source: "skill.v1" });
    const msg = messageRow("user", `prefix ${BLOCK_XML} suffix`, 5, 2);
    const hits = classifySameTurnWholeContainment([block], [msg]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      blockHook: "skill-listing-injector",
      source: "skill.v1",
      blockIdx: 0,
      msgIndex: 5,
      role: "user",
      kind: "whole",
    });
    expect(hits[0]!.blockChars).toBe(BLOCK_XML.length);
    expect(hits[0]!.truncatedBlock).toBe(false);
    expect(hits[0]!.truncatedMsg).toBe(false);
  });

  it("tool 行合法例外：同轮 tool 消息含整块（skill_view 全文回填）→ 不判", () => {
    const block = blockRow(2, BLOCK_XML);
    const toolMsg = messageRow("tool", `full skill body:\n${BLOCK_XML}`, 4, 2);
    expect(classifySameTurnWholeContainment([block], [toolMsg])).toEqual([]);
  });

  it("assistant 消息不含块文本 / 消息可见文本为空 → 不判（system 行本就不入档）", () => {
    const block = blockRow(2, BLOCK_XML);
    const asst = messageRow("assistant", "unrelated ack", 4, 2);
    expect(classifySameTurnWholeContainment([block], [asst])).toEqual([]);
    const empty = messageRow("assistant", "", 5, 2); // 空 fingerprint 不会落行，纯函数也稳健
    expect(classifySameTurnWholeContainment([block], [empty])).toEqual([]);
  });

  it("跨轮不配对：block 在 turn1、消息在 turn2 → 不判（静态注入每轮重渲染 ≠ 同轮互斥）", () => {
    const block = blockRow(1, BLOCK_XML);
    const msg = messageRow("user", BLOCK_XML, 9, 2);
    expect(classifySameTurnWholeContainment([block], [msg])).toEqual([]);
  });

  it("多 turn 只做同轮配对：各轮命中各自 block，跨轮文本不串判", () => {
    const blocks = [blockRow(1, "ctx-one"), blockRow(2, BLOCK_XML), blockRow(3, "third-block")];
    const msgs = [
      messageRow("user", "ctx-one", 1, 1), // 含 turn1 block → 命中
      messageRow("user", "hi", 3, 2), // 不含 → 不命中
      messageRow("user", "third-block in message", 6, 3), // 含 turn3 block → 命中
    ];
    const hits = classifySameTurnWholeContainment(blocks, msgs);
    expect(hits.map((h) => h.msgIndex)).toEqual([1, 6]);
    expect(hits.map((h) => h.role)).toEqual(["user", "user"]);
    expect(hits.map((h) => h.kind)).toEqual(["whole", "whole"]);
  });

  it("脏数据不 throw：content_json 非 JSON / block 空内容直接跳过", () => {
    const block = blockRow(1, BLOCK_XML);
    const bad = messageRow("user", "x", 1, 1, { content_json: "{oops" });
    expect(() => classifySameTurnWholeContainment([block], [bad])).not.toThrow();
    expect(classifySameTurnWholeContainment([block], [bad])).toEqual([]);
    expect(() => classifySameTurnWholeContainment([blockRow(1, "")], [messageRow("user", BLOCK_XML, 1, 1)])).not.toThrow();
  });
});
