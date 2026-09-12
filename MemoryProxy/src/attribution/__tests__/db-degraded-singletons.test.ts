/**
 * 矩阵行 5/6 · DB 不可用（`getDb() → null`）的**单例选择**与降级语义。
 *
 * 为什么需要本文件（缺口性质，不是重复覆盖）：
 *   全仓的降级纪律是「`getDb()` 返回 null ⇒ 装配 Null 实现 ⇒ 静默降级不抛」（F1）。
 *   但既有证据都是**手工注入** Null 实现来验"Null 实现本身不抛"：
 *     - `judge-queue-repo.test.ts` T11 注入 `new NullAttributionJudgeQueueRepo()`；
 *     - `source.test.ts` T25 注入 `{ listBlockTexts: () => [], ... }` 字面量。
 *   于是 `getXxxRepo()` 里 `db ? new Sqlite… : new Null…` 的 **else 分支从未被走到**，
 *   真正的 `NullCitationCorpusRepo` **类**也从未被任何用例实例化过 ——
 *   "空语料 ⇒ 空表"是拿**手搓字面量**证的，不是拿**生产选择出来的那个对象**证的。
 *
 *   本文件把 `PROXY_DB_PATH` 指向一个**目录**（open 必失败，姿势同 `worker.test.ts:149`），
 *   让 `getDb()` 真的返回 null，然后断言四个单例**经真实选择分支**落到 Null 实现上、
 *   且行为是「不抛 + 不伪造」。
 *
 * 断言口径（照 checklist §3 注）：降级路径验的是 **"不抛 + 不伪造"**，**不是**"有数据"。
 *   ⇒ 空结果断言 `[]` / `NaN` 哨兵 / `inserted:false`；**不**断言任何"编造出来的值"。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetDbForTests, getDb } from "../../db/index.js";
import {
  __resetVisibleTextRepoForTests,
  getVisibleTextRepo,
} from "../../db/visibleTextRepo.js";
import { enqueueUnitsForJudge } from "../enqueue.js";
import {
  __resetAttributionJudgeQueueRepoForTests,
  getAttributionJudgeQueueRepo,
} from "../judge-queue-repo.js";
import {
  __resetAttributionJudgementDetailsRepoForTests,
  getAttributionJudgementDetailsRepo,
} from "../judgement-details-repo.js";
import {
  __resetCitationCorpusRepoForTests,
  getCitationCorpusRepo,
} from "../citation/corpus-repo.js";
import {
  __resetCitationSourceProviderForTests,
  getCitationSourceProvider,
} from "../citation/source.js";
import { buildRarityTable, distinctiveGrams, gramCoverage, isCoverageKnown } from "../citation/ngram.js";
import { restoreIsolatedDbPath } from "../../__tests__/setup/isolate-db.js";

const S = "sess-degraded";

let dir = "";
/** 一个**目录**充当 DB 文件路径 ⇒ better-sqlite3 open 必失败（SQLITE_CANTOPEN）。 */
let dbPathThatFails = "";
/** 降级时 `getDb()` 会 `console.warn` —— 收进 spy：既消噪，又把它变成"确实走过 F1 分支"的证据。 */
let warnSpy: ReturnType<typeof vi.spyOn>;

/** 让 `getDb()` 走 catch 分支返回 null —— 走的是生产的 F1 路径，不是 mock。 */
function blockDb(): void {
  process.env.PROXY_DB_PATH = dbPathThatFails;
  __resetDbForTests();
}

function resetAllSingletons(): void {
  __resetVisibleTextRepoForTests();
  __resetAttributionJudgeQueueRepoForTests();
  __resetAttributionJudgementDetailsRepoForTests();
  __resetCitationCorpusRepoForTests();
  __resetCitationSourceProviderForTests();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-attr-degraded-"));
  dbPathThatFails = path.join(dir, "db-path-is-a-directory");
  fs.mkdirSync(dbPathThatFails);
  resetAllSingletons();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  blockDb();
});

afterEach(() => {
  warnSpy.mockRestore();
  resetAllSingletons();
  __resetDbForTests();
  restoreIsolatedDbPath(); // 73 · C3：delete → 恢复 setup 隔离值（防裸跑回落到默认真库）
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("前置：getDb() 真的是 null（否则本文件的断言全部无意义）", () => {
  it("库路径是目录 ⇒ open 失败 ⇒ getDb() 返回 null，且进程确实报了降级", () => {
    expect(getDb()).toBeNull();
    // 且**不是**"已经失败过所以缓存了 null"的假象：这句话本身就是 F1 契约。
    expect(getDb()).toBeNull();

    // "null" 有两种可能：走了 F1 降级，或代码被改坏了静默吞掉。日志把两者分开 ——
    // 只有真走 catch 分支才会打这条 warn（db/index.ts:103-107）。
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("[session-db] failed to initialize SQLite, persistence disabled");
  });
});

describe("矩阵 5/6 · 四类单例的选择分支（db ? Sqlite : Null）真的走到 Null", () => {
  it("getVisibleTextRepo() ⇒ NullVisibleTextRepo：读空、写 no-op、不抛", () => {
    const repo = getVisibleTextRepo();
    expect(repo.getWatermark(S)).toBeNull();
    expect(repo.listBlockSeen(S)).toEqual([]);
    expect(repo.listEpochs(S)).toEqual([]);
    expect(() => repo.insertBlockSeen({} as never)).not.toThrow();
    expect(() => repo.upsertWatermark(S, 0, 1)).not.toThrow();
  });

  it("getAttributionJudgeQueueRepo() ⇒ Null 实现：全部静默降级（不抛、不伪造成功）", () => {
    const repo = getAttributionJudgeQueueRepo();
    expect(repo.enqueue({ unitId: "u", sessionKey: S, payload: {} })).toBe(false);
    expect(repo.claimBatch({ owner: "A", batchSize: 8, leaseTtlMs: 1000 })).toEqual([]);
    expect(repo.complete(1, "A")).toBe(false);
    expect(repo.fail(1, "A", "e", { maxAttempts: 3 })).toBeNull();
    expect(repo.retryFailed()).toBe(0);
    expect(repo.get(1)).toBeNull();
    expect(repo.listByStatus("pending")).toEqual([]);
    expect(repo.countByStatus()).toEqual({});
  });

  it("矩阵行 5 真路径：enqueue=true 且无 DB ⇒ enqueueUnitsForJudge 不抛、inserted 恒 0", () => {
    // 关键差别：这里**没有**手工注入 Null repo —— 走的是 enqueue.ts → getAttributionJudgeQueueRepo()
    // 的真实装配路径。行 5 的"入队静默降级、不抛"自此由**选择分支**证，而不只是 Null 类自己的单测。
    const outcome = enqueueUnitsForJudge({
      config: { attribution: { judge: { enqueue: true } } },
      units: [{ unitId: "unit-x", kind: "code_change", turnSeq: 1, msgSeq: 1, payload: {} }],
      sessionKey: S,
    });
    expect(outcome.skipped).toBe(false); // 开关是开的：确实尝试过入队
    expect(outcome.inserted, "无 DB 时不得报告任何成功入队").toBe(0);
  });

  it("getAttributionJudgementDetailsRepo() ⇒ Null 实现：不落库、不伪造 inserted:true", () => {
    const repo = getAttributionJudgementDetailsRepo();
    const res = repo.insertIdempotent({
      unitId: "unit-x",
      sessionKey: S,
      assetId: "wiki-1",
      assetType: "llm_wiki",
      round: 0,
      verdict: "unconfirmed",
      evidenceSourceType: "injected",
      promptSha256: null,
      judgeImpl: "mock:v1",
      detail: {},
    });
    // 无 DB ⇒ 一行都没落：既不是 inserted（不伪造成功），也不是 duplicate（库里并无该行）
    expect(res.kind).toBe("failed");
    expect(typeof res.judgementId).toBe("string");
    expect(res.judgementId.length).toBeGreaterThan(0);
    expect(repo.getById(res.judgementId)).toBeNull();
    expect(repo.listByUnit("unit-x")).toEqual([]);
    expect(repo.listBySession(S)).toEqual([]);
  });
});

describe("c-4 无 DB 降级：真 NullCitationCorpusRepo + provider 不炸、出空表、走哨兵", () => {
  it("getCitationCorpusRepo() ⇒ 真的 NullCitationCorpusRepo（类本体，不是手搓字面量）", () => {
    const repo = getCitationCorpusRepo();
    expect(repo.constructor.name).toBe("NullCitationCorpusRepo"); // 证"选择分支"走对了
    expect(repo.listBlockTexts()).toEqual([]);
    expect(repo.listMessageSnaps()).toEqual([]);
    expect(() => repo.listBlockTexts({ limit: 0 })).not.toThrow();
    expect(() => repo.listMessageSnaps({ limit: -1 })).not.toThrow();
  });

  it("getCitationSourceProvider()：rarityTable 不炸 + 空表 + 覆盖率走 NaN 哨兵（不是合法 0）", () => {
    const provider = getCitationSourceProvider();
    const table = provider.rarityTable(); // 若抛，本用例即失败

    expect(table.docCount).toBe(0);
    expect(table.df.size).toBe(0);
    expect(table.tableSha256).toMatch(/^[0-9a-f]{64}$/); // 仍有可复现标识，不是 undefined
    expect(table.corpusRows).toEqual({ blocks: 0, messages: 0, capped: false }); // 不伪造 capped
    expect(table.n).toBe(buildRarityTable([]).n); // n 走缺省，不因无 DB 而变

    // 无依据 ⇒ 哨兵；**必须**与"合法 0"分家（c-3 的核心纪律）。
    const cov = gramCoverage("abcd", "abcd", table);
    expect(isCoverageKnown(cov.coverage)).toBe(false);
    expect(Number.isNaN(cov.coverage)).toBe(true);
    expect(cov.coverage).not.toBe(0);

    // 无表 ⇒ 不得凭空产出"区分性 gram"。
    expect(distinctiveGrams("abcd abcd", table, { topK: 5 })).toEqual([]);
  });

  it("getCitationSourceProvider()：窗口/资产/缺口接口同样不炸且为空", () => {
    const provider = getCitationSourceProvider();
    const win = provider.sessionWindow(S);
    expect(win.pieces).toEqual([]);
    expect(provider.sessionAssetTexts(S).size).toBe(0);
    // 59 缺口消除：expanded 常量不依赖 DB，降级态同样返回两类（判据用字面量钉值）
    expect(provider.excludedCategories()).toEqual(["client-system", "user-original"]);
  });

  it("rarityTable 在降级态仍可缓存复用（懒构建不因无 DB 退化成每次重建）", () => {
    const provider = getCitationSourceProvider();
    expect(provider.rarityTable()).toBe(provider.rarityTable());
    expect(provider.rarityTable().tableSha256).toBe(buildRarityTable([]).tableSha256);
  });
});
