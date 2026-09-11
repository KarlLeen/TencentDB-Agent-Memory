/**
 * 57 · shortlist（④）+ 三道机械锚点（⑤）测试矩阵 T1–T5（契约 = 50 spec §12；T6 e2e 在三跳冒烟）。
 *
 * 钉的四条（工单 F3/F4/F7 + 用户复核加码）：
 *   - T1 双命中格焊死"未重排"（mock 按序取第一个命中 ⇒ verdict 必须中 56 顺序的第一个）；
 *   - T2 命中级别四格（exact/whitespace/punctuation/none）逐级可复现；
 *   - T3 coverage 可手算 + 空语料 ⇒ 显式 "unknown"（不落 0/1）；
 *   - 零阈值零布尔：输出形状只有级别/数字/unknown 哨兵。
 * 反向控制（手工、用后即还原）：R1 溢出静默丢弃 ⇒ T1 红；R2 unknown 落 0 ⇒ T3 红；
 * R3 重排候选 ⇒ T1 双命中格红。
 */
import { describe, expect, it } from "vitest";

import { getAttributionWriteCounters } from "../../../db/attributionEventRepo.js";
import { getDb } from "../../../db/index.js";
import { getVisibleArchiveWriteCounters } from "../../../db/visibleTextRepo.js";
import type { JudgeCandidate } from "../../judge/types.js";
import type { EvidenceSupplyProvider, EvidenceSupplyStats } from "../../evidence-supply.js";
import { runWorker } from "../../worker.js";
import {
  detailsRepo,
  queueRepo,
  teardownTempDb,
  withTempDb,
  workerDeps,
} from "../../__tests__/_helpers/base-harness.js";
import { buildRarityTable, type RarityTable } from "../ngram.js";
import { gradeCandidates, shortlistCandidates, SHORTLIST_K } from "../grading.js";
import type { CitationSourceProvider } from "../source.js";
import type { VisibleWindowPiece } from "../../../db/visibleTextRepo.js";

// ── fixtures ────────────────────────────────────────────────────────────────────

function zeroStats(): EvidenceSupplyStats {
  return {
    fetchedRows: 0,
    fetchedIn: 0,
    fetchedExcludedHead: 0,
    fetchedExcludedTail: 0,
    fetchedExcludedBoundary: 0,
    fetchedExcludedNonMonotonic: 0,
    fetchedOtherTurn: 0,
    fetchedNoAssetId: 0,
    injectedInHookDone: 0,
    injectedInVisibleAssets: 0,
    mergedDualSource: 0,
    injectedDuplicate: 0,
  };
}

function fakeSupply(candidates: JudgeCandidate[]): EvidenceSupplyProvider {
  return {
    supply: () => ({ candidates, stats: zeroStats(), dualSource: [], fetchedTurnSeq: null }),
  };
}

const cand = (assetId: string, src: "fetched" | "injected" = "injected"): JudgeCandidate => ({
  assetId,
  assetType: "skill",
  evidenceSourceType: src,
});

/** message 层 piece 的 content（档② content_json：JSON 编码的字符串，visibleTextOfPiece 会 parse）。 */
const msgContent = (text: string): string => JSON.stringify(text);

function fakeSource(input: {
  pieces?: Array<{ turnSeq: number; tier: "block" | "message"; content: string }>;
  assetTexts?: Record<string, string[]>;
  table?: RarityTable;
}): CitationSourceProvider {
  const pieces: VisibleWindowPiece[] = (input.pieces ?? []).map((p, i) => ({
    epoch: null,
    turnSeq: p.turnSeq,
    tier: p.tier,
    seq: i,
    source: "test",
    contentHash: `h${i}`,
    content: p.content,
    truncated: false,
    chars: p.content.length,
    role: null,
    blockIdx: null,
  }));
  return {
    sessionWindow: () => ({ epoch: null, pieces }),
    sessionAssetTexts: () => new Map(Object.entries(input.assetTexts ?? {})),
    rarityTable: () => input.table ?? buildRarityTable([]),
    excludedCategories: () => [],
  };
}

/** 递归断言输出形状无布尔（零布尔约束）。 */
function assertNoBoolean(v: unknown, path = "root"): void {
  if (typeof v === "boolean") throw new Error(`布尔出现在 ${path}`);
  if (Array.isArray(v)) v.forEach((x, i) => assertNoBoolean(x, `${path}[${i}]`));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) assertNoBoolean(x, `${path}.${k}`);
  }
}

// ── T1 shortlist ────────────────────────────────────────────────────────────────

describe("57 · T1 shortlist（前 K + 溢出可观测 + 未重排）", () => {
  it("K+1 个候选 ⇒ judge 只见前 K，溢出计数/清单正确", async () => {
    withTempDb();
    try {
      const candidates = Array.from({ length: SHORTLIST_K + 1 }, (_, i) =>
        cand(`skl-c${String(i + 1).padStart(2, "0")}`),
      );
      queueRepo().enqueue({
        unitId: "u-t1-overflow",
        sessionKey: "sess-t1",
        payload: { kind: "key_tool_call", turnSeq: 1, msgSeq: 16, payload: { text: "无命中" } },
      });

      const result = await runWorker(workerDeps({ evidenceSupply: fakeSupply(candidates) }), {
        drain: true,
      });
      expect(result.completed).toBe(1);

      const rows = detailsRepo().listBySession("sess-t1");
      expect(rows.length).toBe(1);
      const detail = JSON.parse(rows[0]!.detail_json) as {
        candidateCount: number;
        shortlist: { k: number; total: number; overflowCount: number; overflowAssetIds: string[] };
      };
      console.log(`T1 溢出格 → ${JSON.stringify(detail.shortlist)} candidateCount=${detail.candidateCount}`);
      expect(detail.candidateCount, "judge 只见前 K").toBe(SHORTLIST_K);
      expect(detail.shortlist).toEqual({
        k: SHORTLIST_K,
        total: SHORTLIST_K + 1,
        overflowCount: 1,
        overflowAssetIds: [`skl-c${SHORTLIST_K + 1}`],
      });
    } finally {
      teardownTempDb();
    }
  });

  it("双命中格：两候选都可被 mock 命中 ⇒ verdict 必须中 56 顺序的第一个（焊死未重排）", async () => {
    withTempDb();
    try {
      queueRepo().enqueue({
        unitId: "u-t1-order",
        sessionKey: "sess-t1b",
        payload: {
          kind: "key_tool_call",
          turnSeq: 1,
          msgSeq: 16,
          payload: { text: "用了 skl-a 也用了 skl-b" }, // 两候选都可命中
        },
      });

      await runWorker(
        workerDeps({ evidenceSupply: fakeSupply([cand("skl-a"), cand("skl-b")]) }),
        { drain: true },
      );

      const rows = detailsRepo().listBySession("sess-t1b");
      expect(rows.length).toBe(1);
      console.log(`T1 双命中格 → verdict.assetId=${rows[0]!.asset_id}`);
      expect(rows[0]!.asset_id, "mock 按序取第一个命中 ⇒ 必须中 56 顺序的第一个").toBe("skl-a");
      expect(rows[0]!.verdict).toBe("confirmed");
    } finally {
      teardownTempDb();
    }
  });

  it("shortlistCandidates 纯函数：slice 保序、不重排", () => {
    const input = [cand("x1"), cand("x2"), cand("x3")];
    const out = shortlistCandidates(input, 2);
    expect(out.candidates.map((c) => c.assetId)).toEqual(["x1", "x2"]);
    expect(out.overflowAssetIds).toEqual(["x3"]);
    expect(out.total).toBe(3);
  });
});

// ── T2 归一化命中四格 ───────────────────────────────────────────────────────────

describe("57 · T2 引文归一化命中（exact / whitespace / punctuation / none）", () => {
  const ASSET = "标 题：你好，世 界！（v1）"; // 全角标点 + 单空格

  function grade(pieceText: string, assetText = ASSET) {
    return gradeCandidates({
      sessionKey: "sess-t2",
      turnSeq: 1,
      candidates: [cand("A")],
      source: fakeSource({
        pieces: [{ turnSeq: 1, tier: "message", content: msgContent(pieceText) }],
        assetTexts: { A: [assetText] },
      }),
    })[0]!;
  }

  it("exact：逐字节相同 ⇒ exact", () => {
    const m = grade(ASSET);
    console.log(`T2 exact → matchLevel=${m.matchLevel} tier=${m.matchedTier}`);
    expect(m.matchLevel).toBe("exact");
    expect(m.matchedTier).toBe("message");
  });

  it("whitespace：仅空白差异 ⇒ whitespace（exact 不中）", () => {
    const m = grade("标 题：你好，世 界！（v1）", "标  题：你好，世  界！（v1）"); // 资产侧双空格
    console.log(`T2 whitespace → matchLevel=${m.matchLevel}`);
    expect(m.matchLevel).toBe("whitespace");
  });

  it("punctuation：全/半角标点差异 ⇒ punctuation（前两级不中）", () => {
    const m = grade("标 题:你好,世 界!(v1)"); // 半角标点 vs 资产全角
    console.log(`T2 punctuation → matchLevel=${m.matchLevel}`);
    expect(m.matchLevel).toBe("punctuation");
  });

  it("none：无共同内容 ⇒ none + coverage=unknown + 排他 0", () => {
    const m = grade("完全无关的一段话");
    console.log(`T2 none → matchLevel=${m.matchLevel} coverage=${m.coverage}`);
    expect(m.matchLevel).toBe("none");
    expect(m.matchedTier).toBe(null);
    expect(m.coverage).toBe("unknown");
    expect(m.exclusionCount).toBe(0);
  });

  it("无资产文本（fetched 未注入）⇒ matchLevel=null（不猜）", () => {
    const m = gradeCandidates({
      sessionKey: "sess-t2",
      turnSeq: 1,
      candidates: [cand("ghost", "fetched")],
      source: fakeSource({
        pieces: [{ turnSeq: 1, tier: "message", content: msgContent(ASSET) }],
        assetTexts: {}, // 无该资产
      }),
    })[0]!;
    console.log(`T2 no-text → matchLevel=${m.matchLevel}`);
    expect(m.matchLevel).toBe(null);
    expect(m.coverage).toBe("unknown");
  });
});

// ── T3 稀有度覆盖（可手算 + unknown 哨兵）────────────────────────────────────────

describe("57 · T3 稀有度覆盖（数值 golden + NaN ⇒ unknown）", () => {
  it("coverage 可手算：资产 grams 被引文覆盖 1/1 = 1、1/2 = 0.5、1/3（数值 golden）", () => {
    // 接法（§12.2-②）：coverage = 资产文本的 distinctive grams 被命中文段（引文）覆盖的比例。
    // 语料 2 文档 ⇒ docCount=2；n=4；引文 "abcd" = 1 个 gram。
    const table = buildRarityTable(["zzzz yyyy", "qqqq wwww"]);
    const grade = (pieceText: string, assetText: string) =>
      gradeCandidates({
        sessionKey: "sess-t3",
        turnSeq: 1,
        candidates: [cand("A")],
        source: fakeSource({
          pieces: [{ turnSeq: 1, tier: "message", content: msgContent(pieceText) }],
          assetTexts: { A: [assetText] },
          table,
        }),
      })[0]!;

    const g1 = grade("abcd", "abcd"); // 资产 grams=[abcd] ⇒ 1/1
    console.log(`T3 1/1 → coverage=${g1.coverage} distinct=${g1.coverageDistinct} covered=${g1.coverageCovered}`);
    expect(g1.matchLevel).toBe("exact");
    expect(g1.coverage).toBe(1);
    expect(g1.coverageDistinct).toBe(1);
    expect(g1.coverageCovered).toBe(1);

    const g2 = grade("abcd", "abcde"); // 资产 grams=[abcd,bcde] ⇒ 1/2
    console.log(`T3 1/2 → coverage=${g2.coverage}`);
    expect(g2.coverage).toBe(0.5);
    expect(g2.coverageDistinct).toBe(2);
    expect(g2.coverageCovered).toBe(1);

    const g3 = grade("abcd", "abcdef"); // 资产 grams=[abcd,bcde,cdef] ⇒ 1/3
    console.log(`T3 1/3 → coverage=${g3.coverage}`);
    expect(g3.coverage).toBeCloseTo(1 / 3, 10);
    expect(g3.coverageDistinct).toBe(3);
    expect(g3.coverageCovered).toBe(1);

    const g4 = grade("zzzz", "abcd"); // 引文不命中 ⇒ 无 quote 依据
    expect(g4.matchLevel).toBe("none");
    expect(g4.coverage).toBe("unknown");
  });

  it("空语料 ⇒ docCount=0 ⇒ coverage=显式 unknown（不落 0/1）", () => {
    const m = gradeCandidates({
      sessionKey: "sess-t3",
      turnSeq: 1,
      candidates: [cand("A")],
      source: fakeSource({
        pieces: [{ turnSeq: 1, tier: "message", content: msgContent("abcd") }],
        assetTexts: { A: ["xx abcd xx"] },
        table: buildRarityTable([]), // 空语料
      }),
    })[0]!;
    console.log(`T3 空语料 → matchLevel=${m.matchLevel} coverage=${m.coverage}`);
    expect(m.matchLevel).toBe("exact"); // 命中照算
    expect(m.coverage, "空语料必须显式 unknown，绝不落 0/1").toBe("unknown");
  });
});

// ── T4 排他性（只出数字）────────────────────────────────────────────────────────

describe("57 · T4 排他性（命中文段在其他资产文本中的资产数）", () => {
  it("同段现于另一资产 ⇒ exclusionCount=1；再多无关资产不涨", () => {
    const m = gradeCandidates({
      sessionKey: "sess-t4",
      turnSeq: 1,
      candidates: [cand("A")],
      source: fakeSource({
        pieces: [{ turnSeq: 1, tier: "message", content: msgContent("独特文段甲") }],
        assetTexts: {
          A: ["独特文段甲"],
          B: ["前缀 独特文段甲 后缀"], // 含同段（exact 子串）
          C: ["完全无关"],
        },
      }),
    })[0]!;
    console.log(`T4 → matchLevel=${m.matchLevel} exclusionCount=${m.exclusionCount}`);
    expect(m.matchLevel).toBe("exact");
    expect(m.exclusionCount).toBe(1); // 只出数字：B 一个资产
  });
});

// ── T5 零写（T25 姿势）──────────────────────────────────────────────────────────

describe("57 · T5 零写（grading 全路径写计数增量 0 + 水位不变）", () => {
  it("真临时库跑 gradeCandidates（含 rarityTable 构建）⇒ 两类写计数不变 + 水位行数不变", async () => {
    withTempDb();
    try {
      const { archiveCitationSource } = await import("../source.js");
      const { getVisibleTextRepo } = await import("../../../db/visibleTextRepo.js");
      const db = getDb();
      expect(db, "临时库不可用 ⇒ T5 无意义").not.toBe(null);

      const attrBefore = getAttributionWriteCounters();
      const visBefore = getVisibleArchiveWriteCounters();
      const wmBefore = (
        db!.prepare("SELECT COUNT(*) AS n FROM attribution_archive_watermark").get() as { n: number }
      ).n;

      const out = gradeCandidates({
        sessionKey: "sess-t5",
        turnSeq: 1,
        candidates: [cand("A"), cand("B")],
        source: archiveCitationSource(getVisibleTextRepo()),
      });
      // 防"空跑假绿"：输出条数 = 候选数（三个只读方法真被走了）
      expect(out.length).toBe(2);

      const attrAfter = getAttributionWriteCounters();
      const visAfter = getVisibleArchiveWriteCounters();
      const wmAfter = (
        db!.prepare("SELECT COUNT(*) AS n FROM attribution_archive_watermark").get() as { n: number }
      ).n;
      console.log(
        `T5 → attr ${JSON.stringify(attrBefore)}→${JSON.stringify(attrAfter)} vis ${JSON.stringify(visBefore)}→${JSON.stringify(visAfter)} wm ${wmBefore}→${wmAfter}`,
      );
      expect(attrAfter).toEqual(attrBefore);
      expect(visAfter).toEqual(visBefore);
      expect(wmAfter).toBe(wmBefore);
    } finally {
      teardownTempDb();
    }
  });

  it("输出形状零布尔（递归检查）", () => {
    const out = gradeCandidates({
      sessionKey: "sess-t5b",
      turnSeq: 1,
      candidates: [cand("A")],
      source: fakeSource({
        pieces: [{ turnSeq: 1, tier: "message", content: msgContent("独特文段甲") }],
        assetTexts: { A: ["独特文段甲"] },
        table: buildRarityTable(["zzzz yyyy"]),
      }),
    });
    expect(out[0]!.matchLevel).toBe("exact");
    assertNoBoolean(out);
  });
});
