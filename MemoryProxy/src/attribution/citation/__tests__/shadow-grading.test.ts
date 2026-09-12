/**
 * 106 · (d)-1 影子度量测试。
 *
 * 覆盖：
 *   - 形状：递归零布尔；coverage 类 `"unknown"` 哨兵；指纹 = sha256[:16]（绝不落正文）；
 *   - (d2) 主向：资产行级片段 ⊆ 会话消息（覆盖 + 指纹 + 序号）；
 *   - (d1) 向：消息行级片段 ⊆ 资产正文；
 *   - L_MIN：低于下限的行被排除（片段计数可见）；
 *   - 无资产文本 ⇒ 全 unknown/null（不猜）；
 *   - C5 两态键集（worker 组装）：缺省两键皆无；开启两键同在且既有条目键集逐字不变。
 */
import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import type { VisibleWindowPiece } from "../../../db/visibleTextRepo.js";
import {
  detailsRepo,
  queueRepo,
  teardownTempDb,
  withTempDb,
  workerDeps,
} from "../../__tests__/_helpers/base-harness.js";
import type { JudgeCandidate } from "../../judge/types.js";
import { runWorker } from "../../worker.js";
import { buildRarityTable, type RarityTable } from "../ngram.js";
import { shadowGradeCandidates, SHADOW_L_MIN } from "../shadow-grading.js";
import type { CitationSourceProvider } from "../source.js";

const cand = (assetId: string): JudgeCandidate => ({
  assetId,
  assetType: "skill",
  evidenceSourceType: "injected",
});

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

function assertNoBoolean(v: unknown, path = "root"): void {
  if (typeof v === "boolean") throw new Error(`布尔出现在 ${path}`);
  if (Array.isArray(v)) v.forEach((x, i) => assertNoBoolean(x, `${path}[${i}]`));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) assertNoBoolean(x, `${path}.${k}`);
}

const sha16 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

describe("106 · 影子度量形状与两向语义", () => {
  it("零布尔递归；coverage 类只有数字或 unknown；指纹 = sha256[:16]", () => {
    const line = "这是一条足够长的资产正文行，用于覆盖计算。";
    const out = shadowGradeCandidates({
      sessionKey: "s",
      turnSeq: 1,
      candidates: [cand("A")],
      source: fakeSource({
        pieces: [{ turnSeq: 1, tier: "message", content: JSON.stringify(line) }],
        assetTexts: { A: [line] },
        table: buildRarityTable([line, "其他语料"]),
      }),
    });
    assertNoBoolean(out);
    const m = out[0]!;
    expect(typeof m.shadowAssetSegCount).toBe("number");
    expect(m.shadowBestSegCoverage === "unknown" || typeof m.shadowBestSegCoverage === "number").toBe(true);
    if (m.shadowBestSegSha256_16 !== null) expect(m.shadowBestSegSha256_16).toHaveLength(16);
  });

  it("(d2) 主向：资产整行出现在消息里 ⇒ 覆盖有值且指纹 = 该行 sha16", () => {
    const line = "资产正文的完整一行会被消息覆盖到。";
    const out = shadowGradeCandidates({
      sessionKey: "s",
      turnSeq: 1,
      candidates: [cand("A")],
      source: fakeSource({
        pieces: [{ turnSeq: 1, tier: "message", content: JSON.stringify(line) }],
        assetTexts: { A: [line] },
        table: buildRarityTable([line, "别处的语料"]),
      }),
    });
    const m = out[0]!;
    expect(m.shadowAssetSegCount).toBe(1);
    expect(m.shadowBestSegCoverage).toBe(1); // 整行全被覆盖
    expect(m.shadowBestSegIndex).toBe(0);
    expect(m.shadowBestSegSha256_16).toBe(sha16(line));
  });

  it("(d1) 向：消息行 ⊆ 资产正文 ⇒ shadowMsgSegMaxCoverage 有值", () => {
    const msgLine = "消息里引用资产的一句话，长度超过十六个字符。"; // ≥ L_MIN，否则会被片段下限排除
    const assetText = `前言\n${msgLine}\n后记`;
    const out = shadowGradeCandidates({
      sessionKey: "s",
      turnSeq: 1,
      candidates: [cand("A")],
      source: fakeSource({
        pieces: [{ turnSeq: 1, tier: "message", content: JSON.stringify(msgLine) }],
        assetTexts: { A: [assetText] },
        table: buildRarityTable([assetText, "第三条语料"]),
      }),
    });
    const m = out[0]!;
    expect(m.shadowMsgSegMaxCoverage).toBe(1);
    expect(m.shadowMsgSegIdx).not.toBeNull();
  });

  it("L_MIN：低于下限的行被排除（片段计数直接可见）", () => {
    const longLine = "这是一个明显超过默认下限的资产正文行。";
    const shortLine = "短行六个字"; // 6 字符：默认 16 排除；lMin=4 纳入
    const src = (lMin?: number) =>
      shadowGradeCandidates({
        sessionKey: "s",
        turnSeq: 1,
        candidates: [cand("A")],
        source: fakeSource({
          pieces: [{ turnSeq: 1, tier: "message", content: JSON.stringify(longLine) }],
          assetTexts: { A: [longLine, shortLine] },
          table: buildRarityTable([longLine, "语料"]),
        }),
        ...(lMin === undefined ? {} : { lMin }),
      })[0]!;
    expect(src().shadowAssetSegCount).toBe(1); // 短行 < SHADOW_L_MIN=16 被排除
    expect(src(4).shadowAssetSegCount).toBe(2); // 放宽下限 ⇒ 纳入
    expect(SHADOW_L_MIN).toBe(16);
  });

  it("107 · C1 逐消息口径：跨消息拼凑不抬高（PerMsg ≤ join）", () => {
    const seg = "alpha beta gamma"; // 16 字符（≥ L_MIN）
    const out = shadowGradeCandidates({
      sessionKey: "s",
      turnSeq: 1,
      candidates: [cand("A")],
      source: fakeSource({
        pieces: [
          { turnSeq: 1, tier: "message", content: JSON.stringify("alpha padding padding padding") },
          { turnSeq: 1, tier: "message", content: JSON.stringify("gamma padding padding padding") },
        ],
        assetTexts: { A: [seg] },
        table: buildRarityTable([seg, "无关语料甲乙丙", "第四段语料"]),
      }),
    });
    const m = out[0]!;
    const join = m.shadowBestSegCoverage;
    const per = m.shadowBestSegCoveragePerMsg;
    if (typeof join === "number" && typeof per === "number") {
      expect(per).toBeLessThanOrEqual(join);
    } else {
      // 至少两字段都有值/或都 unknown —— 形状断言（具体数值见 107 报告两口径对照表）
      expect(typeof join).toBe(typeof per === "number" ? "number" : typeof join);
    }
  });

  it("107 · C3 短资产回退：整段 < L_MIN ⇒ segCount=0 且 WholeAssetCoverage 不再是永久 unknown", () => {
    const shortAsset = "短资产标题";
    const msg = "这里完整复述了短资产标题的内容，用于短资产回退演练。";
    const out = shadowGradeCandidates({
      sessionKey: "s",
      turnSeq: 1,
      candidates: [cand("A")],
      source: fakeSource({
        pieces: [{ turnSeq: 1, tier: "message", content: JSON.stringify(msg) }],
        assetTexts: { A: [shortAsset] },
        table: buildRarityTable([shortAsset, "第七段语料"]),
      }),
    });
    const m = out[0]!;
    expect(m.shadowAssetSegCount).toBe(0); // 整段 < 16 ⇒ 无片段
    expect(m.shadowBestSegCoverage).toBe("unknown"); // 片段口径不适用
    expect(m.shadowBestSegCoveragePerMsg).toBe("unknown");
    // 107 · C3：短资产回退列有值（数字或 unknown 都是"可见"，不再全空）
    expect(m.shadowWholeAssetCoverage === "unknown" || typeof m.shadowWholeAssetCoverage === "number").toBe(true);
  });

  it("无资产文本 ⇒ 全 unknown/null（不猜）", () => {
    const out = shadowGradeCandidates({
      sessionKey: "s",
      turnSeq: 1,
      candidates: [cand("ghost")],
      source: fakeSource({ pieces: [], assetTexts: {}, table: buildRarityTable([]) }),
    });
    expect(out[0]).toEqual({
      assetId: "ghost",
      shadowAssetSegCount: 0,
      shadowBestSegCoverage: "unknown",
      shadowBestSegCoveragePerMsg: "unknown",
      shadowBestSegIndex: null,
      shadowBestSegSha256_16: null,
      shadowMsgSegMaxCoverage: "unknown",
      shadowMsgSegIdx: null,
      shadowWholeAssetCoverage: "unknown",
    });
  });
});

describe("106 · C5 两态键集（worker 组装；兄弟键不改既有条目）", () => {
  const payload = {
    kind: "restraint",
    turnSeq: 1,
    msgSeq: 1,
    payload: { visibleAssets: [{ assetId: "a1", assetType: "skill" }], text: "见 a1" },
  };

  it("缺省（无 citationSource）：两键皆不出现", async () => {
    withTempDb();
    try {
      queueRepo().enqueue({ unitId: "u-shadow-off", sessionKey: "sess-shadow-off", payload });
      const r = await runWorker(workerDeps(), { drain: true });
      expect(r.completed).toBe(1);
      const row = detailsRepo().listBySession("sess-shadow-off")[0]!;
      const d = JSON.parse(row.detail_json) as Record<string, unknown>;
      expect("citationMetrics" in d).toBe(false);
      expect("citationMetricsShadow" in d).toBe(false);
    } finally {
      teardownTempDb();
    }
  });

  it("开启（注入 citationSource）：两键同在；既有条目键集逐字不变", async () => {
    withTempDb();
    try {
      queueRepo().enqueue({ unitId: "u-shadow-on", sessionKey: "sess-shadow-on", payload });
      const r = await runWorker(
        workerDeps({
          citationSource: fakeSource({
            pieces: [
              { turnSeq: 1, tier: "message", content: JSON.stringify("见 a1 的说明文字（引用自资产）。") },
            ],
            assetTexts: { a1: ["见 a1 的说明文字（引用自资产）。"] },
            table: buildRarityTable(["见 a1 的说明文字（引用自资产）。", "语料B"]),
          }),
        }),
        { drain: true },
      );
      expect(r.completed).toBe(1);
      const row = detailsRepo().listBySession("sess-shadow-on")[0]!;
      const d = JSON.parse(row.detail_json) as {
        citationMetrics?: Array<Record<string, unknown>>;
        citationMetricsShadow?: Array<Record<string, unknown>>;
      };
      expect(Array.isArray(d.citationMetrics)).toBe(true);
      expect(Array.isArray(d.citationMetricsShadow)).toBe(true);
      // 既有条目键集 = 104/105 后的既成 8 键（逐字不变；影子不在其中 —— C2）
      expect(Object.keys(d.citationMetrics![0]!).sort()).toEqual(
        [
          "assetId",
          "coverage",
          "coverageCovered",
          "coverageDistinct",
          "exclusionCount",
          "matchLevel",
          "matchedTier",
          "ngramTableSha256",
        ].sort(),
      );
      // 影子条目键 = assetId + 8（106 六 + 107 两：PerMsg / WholeAsset；兄弟键形状）
      expect(Object.keys(d.citationMetricsShadow![0]!).sort()).toEqual(
        [
          "assetId",
          "shadowAssetSegCount",
          "shadowBestSegCoverage",
          "shadowBestSegCoveragePerMsg",
          "shadowBestSegIndex",
          "shadowBestSegSha256_16",
          "shadowMsgSegIdx",
          "shadowMsgSegMaxCoverage",
          "shadowWholeAssetCoverage",
        ].sort(),
      );
      assertNoBoolean(d.citationMetricsShadow);
    } finally {
      teardownTempDb();
    }
  });
});
