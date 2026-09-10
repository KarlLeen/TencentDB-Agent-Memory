/**
 * c-4 单测（design §4.8.5 / §5 T25）+ c-1/c-2/c-3 的**只读合题**（T17）。
 *
 * 本文件回答两个不同的问题，别混：
 *
 *   T25（只读硬约束）：c-4 取数路径**零写**。
 *     证据 = 跑完 `sessionWindow` / `sessionAssetTexts` / `rarityTable` / `excludedCategories`
 *     之后，「P0 归档写计数」增量为 0 + 水位行逐字段不变。
 *     并用 **fake 语料 repo** 与 **真 sqlite repo** 各跑一遍（避免"只有 fake 才只读"的假绿）。
 *
 *   T17（有损比较层不得回写）：c-1/c-2/c-3 的产物只用于比较。
 *     证据 = 跑完整引用工具链之后，`attribution_block_text.content_utf8` 与写入时**逐字节相同**；
 *     且 `match_level` / `ngram_table_sha256` 这类审计位能经 `detail_json` 落库回读（**不改 DDL**）。
 *
 * c-4 的边界（不判定）：`sessionAssetTexts` 只给"同会话各资产的可见文本集合"；
 * "引文也出现在别的资产里 ⇒ 不算排他"那一步属 50 spec —— 本文件**不断言**任何排他结论。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../../db/index.js";
import {
  __resetVisibleTextRepoForTests,
  getVisibleTextRepo,
  getVisibleArchiveWriteCounters,
  readWatermark,
  windowVisibleText,
} from "../../../db/visibleTextRepo.js";
import { teardownTempDb, withTempDb } from "../../__tests__/_helpers/base-harness.js";
import {
  __resetAttributionJudgementDetailsRepoForTests,
  getAttributionJudgementDetailsRepo,
} from "../../judgement-details-repo.js";
import { normalizeForMatch, type MatchLevel } from "../normalize.js";
import { distinctiveGrams, gramCoverage, buildRarityTable } from "../ngram.js";
import {
  __resetCitationCorpusRepoForTests,
  getCitationCorpusRepo,
  type CitationCorpusRepo,
} from "../corpus-repo.js";
import { __resetCitationSourceProviderForTests, archiveCitationSource } from "../source.js";
import { stripRenderWrappers } from "../wrapper-registry.js";

const S = "sess-citation";

// ── 归档 fixture（真实形状：块标签包装 + L1 条目前缀；asset_ids = [{assetId, assetType}]）──
const BLOCK_WRAPPED = "<knowledge_tools>\n**团队知识库资源**：wiki 是工程设计文档。\n</knowledge_tools>";
const BLOCK_L1 = "<tdai_recalled_l1_memories>\n1. [episodic] [self score=0.900] alpha 事件\n</tdai_recalled_l1_memories>";
const BLOCK_ORPHAN = "无资产归属的合成块（session-context）";

function seedArchive(): void {
  const repo = getVisibleTextRepo();

  const a = repo.upsertBlockText({
    source: "knowledge.v1",
    contentHash: "h-knowledge",
    contentUtf8: BLOCK_WRAPPED,
    chars: BLOCK_WRAPPED.length,
    bytes: Buffer.byteLength(BLOCK_WRAPPED, "utf8"),
    truncated: false,
  });
  const b = repo.upsertBlockText({
    source: "l1-recall.v1",
    contentHash: "h-l1",
    contentUtf8: BLOCK_L1,
    chars: BLOCK_L1.length,
    bytes: Buffer.byteLength(BLOCK_L1, "utf8"),
    truncated: false,
  });
  const c = repo.upsertBlockText({
    source: "session.context",
    contentHash: "h-orphan",
    contentUtf8: BLOCK_ORPHAN,
    chars: BLOCK_ORPHAN.length,
    bytes: Buffer.byteLength(BLOCK_ORPHAN, "utf8"),
    truncated: false,
  });

  // knowledge 块同时归因到 wiki + code-graph 两个资产
  repo.insertBlockSeen({
    sessionKey: S,
    turnSeq: 1,
    hookId: "knowledge-injector",
    point: "system.suffix",
    contentId: a.contentId,
    blockIdx: 0,
    assetIdsJson: JSON.stringify([
      { assetId: "wiki-1", assetType: "llm_wiki" },
      { assetId: "repo-1", assetType: "code_graph" },
    ]),
  });
  // 同内容第二轮再注入（同 content_id）⇒ sessionAssetTexts 必须按 content_id 去重
  repo.insertBlockSeen({
    sessionKey: S,
    turnSeq: 2,
    hookId: "knowledge-injector",
    point: "system.suffix",
    contentId: a.contentId,
    blockIdx: 0,
    assetIdsJson: JSON.stringify([{ assetId: "wiki-1", assetType: "llm_wiki" }]),
  });
  repo.insertBlockSeen({
    sessionKey: S,
    turnSeq: 2,
    hookId: "l1-recall-injector",
    point: "system.suffix",
    contentId: b.contentId,
    blockIdx: 1,
    assetIdsJson: JSON.stringify([{ assetId: "chat_memory-team1-agtself", assetType: "chat_memory" }]),
  });
  // 无资产归属（合成块）⇒ 不进 sessionAssetTexts
  repo.insertBlockSeen({
    sessionKey: S,
    turnSeq: 1,
    hookId: "session-init",
    point: "system.prefix",
    contentId: c.contentId,
    blockIdx: 2,
    assetIdsJson: null,
  });
  // 畸形 asset_ids ⇒ 忽略（绝不 throw）
  repo.insertBlockSeen({
    sessionKey: S,
    turnSeq: 3,
    hookId: "broken-injector",
    point: "system.suffix",
    contentId: c.contentId,
    blockIdx: 3,
    assetIdsJson: "{not json",
  });

  // 档② 消息 + 水位（供 sessionWindow 的可读性断言）
  repo.insertMessageSnap({
    sessionKey: S,
    epoch: 0,
    turnSeq: 1,
    messageIndex: 1,
    role: "user",
    contentHash: "m1",
    contentJson: JSON.stringify("hello citation base"),
    chars: 19,
    truncated: false,
  });
  repo.upsertWatermark(S, 0, 2);
}

const fakeCorpus: CitationCorpusRepo = {
  listBlockTexts(opts) {
    const rows = [
      { contentId: 1, contentUtf8: BLOCK_WRAPPED },
      { contentId: 2, contentUtf8: BLOCK_L1 },
    ];
    return rows.slice(0, opts?.limit ?? rows.length);
  },
  listMessageSnaps(opts) {
    const rows = [{ msgId: 1, contentJson: JSON.stringify("hello citation base") }];
    return rows.slice(0, opts?.limit ?? rows.length);
  },
};

beforeEach(() => {
  withTempDb();
  __resetVisibleTextRepoForTests();
  __resetCitationCorpusRepoForTests();
  __resetCitationSourceProviderForTests();
  seedArchive();
});

afterEach(() => {
  __resetVisibleTextRepoForTests();
  __resetCitationCorpusRepoForTests();
  __resetCitationSourceProviderForTests();
  __resetAttributionJudgementDetailsRepoForTests();
  teardownTempDb();
});

describe("c-4 取数（不判定）：sessionWindow / sessionAssetTexts / rarityTable / excludedCategories", () => {
  it("sessionWindow 直复用 P0 §5（窗口序 (turn_seq, tier, seq)）", () => {
    const repo = getVisibleTextRepo();
    const provider = archiveCitationSource(repo, { corpusRepo: fakeCorpus });
    const win = provider.sessionWindow(S);
    const expected = windowVisibleText(repo, S);
    expect(win.epoch).toBe(expected.epoch);
    expect(win.pieces.map((p) => `${p.tier}:${p.turnSeq}:${p.seq}`)).toEqual(
      expected.pieces.map((p) => `${p.tier}:${p.turnSeq}:${p.seq}`),
    );
  });

  it("sessionAssetTexts 按 asset_ids 分组 + 按 content_id 去重 + 无归属/畸形一律跳过", () => {
    const provider = archiveCitationSource(getVisibleTextRepo(), { corpusRepo: fakeCorpus });
    const map = provider.sessionAssetTexts(S);

    expect([...map.keys()].sort()).toEqual(["chat_memory-team1-agtself", "repo-1", "wiki-1"]);
    // 同内容两轮注入 + 同资产 ⇒ 只留一份
    expect(map.get("wiki-1")).toEqual([BLOCK_WRAPPED]);
    expect(map.get("repo-1")).toEqual([BLOCK_WRAPPED]);
    expect(map.get("chat_memory-team1-agtself")).toEqual([BLOCK_L1]);
    // 合成块（asset_ids=null）与畸形 JSON 的行都不在
    for (const texts of map.values()) expect(texts).not.toContain(BLOCK_ORPHAN);
  });

  it("rarityTable 懒构建 + 进程内缓存（同语料 ⇒ 同一对象，证『表可复现』）", () => {
    const provider = archiveCitationSource(getVisibleTextRepo(), { corpusRepo: fakeCorpus });
    const first = provider.rarityTable();
    const second = provider.rarityTable();
    expect(second).toBe(first); // 同一引用 ⇒ 没有重复构建
    expect(first.docCount).toBe(3); // 2 blocks + 1 message
    expect(first.corpusRows.blocks).toBe(2);
    expect(first.corpusRows.messages).toBe(1);
    expect(first.n).toBe(4);
  });

  it("rarityTable 的档②侧走 messageTextFingerprint 文本投影（不新造口径）", () => {
    // 消息 content_json 是 JSON 串：{"type":"text","text":"..."} ⇒ 投影出纯文本
    const provider = archiveCitationSource(getVisibleTextRepo(), {
      corpusRepo: {
        listBlockTexts: () => [],
        listMessageSnaps: () => [
          { msgId: 1, contentJson: JSON.stringify([{ type: "text", text: "投影文本内容" }]) },
        ],
      },
    });
    const table = provider.rarityTable();
    expect(table.docCount).toBe(1);
    expect([...table.df.keys()].some((g) => "投影文本内容".includes(g))).toBe(true);
  });

  it("excludedCategories 缺口期返回空数组（实现面缺口登记 §8.3，不自己设计枚举）", () => {
    const provider = archiveCitationSource(getVisibleTextRepo(), { corpusRepo: fakeCorpus });
    expect(provider.excludedCategories()).toEqual([]);
  });
});

describe("T25 只读硬约束：c-4 全路径零写（fake 与真 repo 各跑一遍）", () => {
  function exercise(provider: ReturnType<typeof archiveCitationSource>): void {
    provider.sessionWindow(S);
    provider.sessionAssetTexts(S);
    provider.rarityTable();
    provider.rarityTable();
    provider.excludedCategories();
  }

  it("fake 语料 repo：跑完写计数增量为 0 + 水位不变", () => {
    const repo = getVisibleTextRepo();
    const before = getVisibleArchiveWriteCounters();
    const wmBefore = readWatermark(repo, S);
    exercise(archiveCitationSource(repo, { corpusRepo: fakeCorpus }));
    expect(getVisibleArchiveWriteCounters()).toEqual(before);
    expect(readWatermark(repo, S)).toEqual(wmBefore);
  });

  it("真 sqlite 语料 repo（getCitationCorpusRepo）：同样零写 + 确实读得到归档", () => {
    const repo = getVisibleTextRepo();
    __resetCitationCorpusRepoForTests(); // 让 singleton 绑到当前临时库
    const real = getCitationCorpusRepo();
    expect(real.listBlockTexts({ limit: 10 })).toHaveLength(3);
    expect(real.listMessageSnaps({ limit: 10 })).toHaveLength(1);

    const before = getVisibleArchiveWriteCounters();
    const wmBefore = readWatermark(repo, S);
    exercise(archiveCitationSource(repo, { corpusRepo: real }));
    expect(getVisibleArchiveWriteCounters()).toEqual(before);
    expect(readWatermark(repo, S)).toEqual(wmBefore);
  });

  it("真语料 repo 只 SELECT：表结构不变（无 CREATE/ALTER 副作用）", () => {
    __resetCitationCorpusRepoForTests();
    const db = getDb();
    const tablesBefore = db!
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    getCitationCorpusRepo().listBlockTexts({ limit: 5 });
    getCitationCorpusRepo().listMessageSnaps({ limit: 5 });
    const tablesAfter = db!
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tablesAfter).toEqual(tablesBefore);
  });

  it("空语料（Null repo 降级）⇒ 空表 + 覆盖率为哨兵，而不是 0/1（不抛）", () => {
    const nullRepo: CitationCorpusRepo = {
      listBlockTexts: () => [],
      listMessageSnaps: () => [],
    };
    const provider = archiveCitationSource(getVisibleTextRepo(), { corpusRepo: nullRepo });
    const table = provider.rarityTable();
    expect(table.docCount).toBe(0);
    expect(table.df.size).toBe(0);
    expect(table.tableSha256).toMatch(/^[0-9a-f]{64}$/);
    // 无表 ⇒ 覆盖率走哨兵（无依据），而不是"没覆盖"的合法 0
    const cov = gramCoverage("abcd", "abcd", table);
    expect(Number.isNaN(cov.coverage)).toBe(true);
    expect(cov.coverage).not.toBe(0);
  });
});

describe("T17 有损比较层不得回写：跑完整引用工具链后归档逐字节不变", () => {
  it("content_utf8 逐字节相同 + 写计数增量为 0（防『顺手净化』）", () => {
    const repo = getVisibleTextRepo();
    const beforeRows = repo.listBlockSeen(S).map((r) => ({ id: r.content_id, text: r.content_utf8 }));
    const beforeCounters = getVisibleArchiveWriteCounters();

    const provider = archiveCitationSource(repo, { corpusRepo: fakeCorpus });
    const table = provider.rarityTable();
    const levels: MatchLevel[] = ["exact", "whitespace", "punctuation"];

    for (const row of repo.listBlockSeen(S)) {
      const stripped = stripRenderWrappers(row.content_utf8).text;
      for (const level of levels) normalizeForMatch(row.content_utf8, level);
      normalizeForMatch(stripped, "punctuation");
      gramCoverage(row.content_utf8, row.content_utf8, table);
      distinctiveGrams(row.content_utf8, table, { topK: 5 });
    }
    provider.sessionAssetTexts(S);
    provider.sessionWindow(S);

    const afterRows = repo.listBlockSeen(S).map((r) => ({ id: r.content_id, text: r.content_utf8 }));
    expect(afterRows).toEqual(beforeRows); // 含 content_utf8 逐字节 + content_id 不变
    // 直接对 DB 再核一次（不经过 repo 的映射层）
    const raw = getDb()!
      .prepare("SELECT content_hash, content_utf8 FROM attribution_block_text ORDER BY content_id ASC")
      .all() as Array<{ content_hash: string; content_utf8: string }>;
    expect(raw.map((r) => r.content_utf8)).toEqual([BLOCK_WRAPPED, BLOCK_L1, BLOCK_ORPHAN]);
    expect(getVisibleArchiveWriteCounters()).toEqual(beforeCounters);
  });

  it("审计位可经 detail_json 落库回读（match_level / ngram_table_sha256；不改 DDL）", () => {
    const table = buildRarityTable(["aaab", "aacd", "bbcd"], { n: 2 });
    const details = getAttributionJudgementDetailsRepo();
    const res = details.insertIdempotent({
      unitId: "unit-citation-1",
      sessionKey: S,
      assetId: "wiki-1",
      assetType: "llm_wiki",
      round: 0,
      verdict: "unconfirmed",
      evidenceSourceType: "injected",
      promptSha256: null,
      judgeImpl: "mock:v1",
      detail: {
        // ⚠️ 这里只演**形状**：基座只出度量与口径，判定属 50 spec。
        match_level: "punctuation" satisfies MatchLevel,
        ngram_table_sha256: table.tableSha256,
        ngram_n: table.n,
        coverage: gramCoverage(BLOCK_WRAPPED, "wiki", table).coverage,
      },
    });
    expect(res.inserted).toBe(true);

    const row = details.getById(res.judgementId);
    expect(row).not.toBeNull();
    const detail = JSON.parse(row!.detail_json) as Record<string, unknown>;
    expect(detail.match_level).toBe("punctuation");
    expect(detail.ngram_table_sha256).toBe(table.tableSha256);
    expect(detail.ngram_n).toBe(2);
    // 明细表列集合未被本基座改动（审计位一律塞 detail_json，不改 DDL）
    const columns = getDb()!
      .prepare("PRAGMA table_info(attribution_judgement_details)")
      .all()
      .map((c) => (c as { name: string }).name);
    expect(columns).toEqual([
      "judgement_id",
      "unit_id",
      "session_key",
      "space_id",
      "asset_id",
      "asset_type",
      "round",
      "verdict",
      "evidence_source_type",
      "prompt_sha256",
      "judge_impl",
      "detail_json",
      "created_at",
    ]);
  });
});
