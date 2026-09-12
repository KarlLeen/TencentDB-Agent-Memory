/**
 * 58 · mechanical:v1（⑥ 裁决/阈值）测试矩阵 T1–T4（契约 = 50 spec §13；T5 e2e 在三跳冒烟）。
 *
 * T1 golden 归因集 = 标定标注集 N=25 逐条（fixtures/verdict-calibration-cases.json，
 * sha256 见 §13.6；四类 {injected,fetched}×{正,反} + DR-6a/b + 边界，真链路 11 / 构造 14）。
 * 反向控制（手工、用后即还原）：R1 阈值改坏 ⇒ T1 红；R2 去掉 isCoverageKnown 门禁 ⇒ T2 红；
 * R3 缺省 provider 改 mechanical ⇒ T3 红。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildRarityTable } from "../../citation/ngram.js";
import { gradeCandidates, type CandidateCitationMetrics } from "../../citation/grading.js";
import type { CitationSourceProvider } from "../../citation/source.js";
import { buildConfig } from "../../../config.js";
import { createJudge } from "../create-judge.js";
import { MechanicalJudge } from "../mechanical-judge.js";
import type { JudgeCandidate, JudgeVerdict } from "../types.js";
import {
  detailsRepo,
  queueRepo,
  teardownTempDb,
  withTempDb,
  workerDeps,
} from "../../__tests__/_helpers/base-harness.js";
import { buildWorkerDeps, runWorker } from "../../worker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface FixtureCase {
  id: string;
  category: string;
  provenance: "real-link" | "constructed";
  description: string;
  source: {
    pieces: Array<{ turnSeq: number; tier: "block" | "message"; content: string }>;
    assetTexts: Record<string, string[]>;
    corpus: string[];
  };
  candidates: JudgeCandidate[];
  expected: { verdict: string; assetId: string | null; rationale: string };
}

const FIXTURES_PATH = path.join(__dirname, "fixtures", "verdict-calibration-cases.json");
const FIXTURES_RAW = fs.readFileSync(FIXTURES_PATH);
const FIXTURES_SHA256 = (await import("node:crypto")).createHash("sha256").update(FIXTURES_RAW).digest("hex");
const FIXTURES = JSON.parse(FIXTURES_RAW.toString("utf8")) as { cases: FixtureCase[] };

function replaySource(src: FixtureCase["source"]): CitationSourceProvider {
  const table = buildRarityTable(src.corpus);
  return {
    sessionWindow: () => ({
      epoch: null,
      pieces: src.pieces.map((p, i) => ({
        epoch: null,
        turnSeq: p.turnSeq,
        tier: p.tier,
        seq: i,
        source: "replay",
        contentHash: `h${i}`,
        content: p.content,
        truncated: false,
        chars: p.content.length,
        role: null,
        blockIdx: null,
      })),
    }),
    sessionAssetTexts: () => new Map(Object.entries(src.assetTexts)),
    rarityTable: () => table,
    excludedCategories: () => [],
  };
}

async function verdictOf(c: FixtureCase): Promise<{ verdict: JudgeVerdict; metrics: CandidateCitationMetrics[] }> {
  const metrics = gradeCandidates({
    sessionKey: "replay",
    turnSeq: 1,
    candidates: c.candidates,
    source: replaySource(c.source),
  });
  const judge = new MechanicalJudge();
  const verdict = await judge.judge({
    unitId: c.id,
    sessionKey: "replay",
    round: 0,
    unit: { kind: "calibration", payload: {} },
    candidates: c.candidates,
    promptRef: judge.promptRef,
    citationMetrics: metrics,
  });
  return { verdict, metrics };
}

describe("58 · T1 golden 归因集（标注集 N=25 逐条；指纹进快照注释）", () => {
  it(`指纹：fixtures sha256 = ${FIXTURES_SHA256.slice(0, 16)}…（全值见 50 spec §13.6）；N = ${FIXTURES.cases.length}`, () => {
    console.log(`T1 指纹 → fixtures sha256=${FIXTURES_SHA256} N=${FIXTURES.cases.length}`);
    expect(FIXTURES.cases.length).toBe(25);
    // 分母自证：四类各 5 + DR-6a 1 + DR-6b 2 + 边界 2
    const count = (cat: string) => FIXTURES.cases.filter((c) => c.category === cat).length;
    expect(count("injected-正例")).toBe(5);
    expect(count("injected-反例")).toBe(5);
    expect(count("fetched-正例")).toBe(5);
    expect(count("fetched-反例")).toBe(5);
    expect(count("DR-6a 版本漂移")).toBe(1);
    expect(count("DR-6b 双通道")).toBe(2);
    expect(count("边界")).toBe(2);
  });

  for (const c of FIXTURES.cases) {
    it(`${c.id}（${c.category}/${c.provenance}）⇒ ${c.expected.verdict}${c.expected.assetId ? "@" + c.expected.assetId : ""}`, async () => {
      const { verdict } = await verdictOf(c);
      console.log(`T1 ${c.id} → ${verdict.verdict}${verdict.assetId ? "@" + verdict.assetId : ""}（期望 ${c.expected.verdict}${c.expected.assetId ? "@" + c.expected.assetId : ""}）`);
      expect(verdict.verdict, `${c.id} 标注：${c.expected.rationale}`).toBe(c.expected.verdict);
      if (c.expected.verdict !== "unconfirmed") {
        expect(verdict.assetId, `${c.id} 标注：${c.expected.rationale}`).toBe(c.expected.assetId);
        // 护栏（C1-5）：verdict.assetId ∈ candidates
        expect(
          c.candidates.some((k) => k.assetId === verdict.assetId),
          `${c.id} 护栏：assetId 不在候选里`,
        ).toBe(true);
      } else {
        expect(verdict.assetId).toBe(null);
      }
      expect(verdict.rationaleRef.startsWith("mechanical:"), "rationaleRef 引用式").toBe(true);
    });
  }
});

describe("58 · T2 门禁（unknown / 无文本 / 空语料 / candidates=[] ⇒ unconfirmed）", () => {
  const byId = (id: string): FixtureCase => FIXTURES.cases.find((c) => c.id === id)!;

  it("空语料 ⇒ coverage=unknown 且 verdict=unconfirmed（不落 0/1、不进比较）", async () => {
    const { verdict, metrics } = await verdictOf(byId("fake-fet-neg-3"));
    expect(metrics[0]!.coverage, "空语料 ⇒ unknown 哨兵").toBe("unknown");
    // 104 后：该 case 的命中原本来自 tier=block 自匹配（已移除） ⇒ 无命中（none）。
    expect(metrics[0]!.matchLevel, "104 后无命中（block 自匹配已移除）").toBe("none");
    expect(verdict.verdict).toBe("unconfirmed");
    expect(verdict.assetId).toBe(null);
  });

  it("无资产文本 ⇒ matchLevel=null 且 unconfirmed", async () => {
    const { verdict, metrics } = await verdictOf(byId("fake-fet-neg-2"));
    expect(metrics[0]!.matchLevel).toBe(null);
    expect(verdict.verdict).toBe("unconfirmed");
  });

  it("candidates.length===0 ⇒ 显式 unconfirmed（B5：不得静默 false）", async () => {
    const judge = new MechanicalJudge();
    const verdict = await judge.judge({
      unitId: "edge-empty",
      sessionKey: "replay",
      round: 0,
      unit: { kind: "calibration", payload: {} },
      candidates: [],
      promptRef: judge.promptRef,
      citationMetrics: [],
    });
    expect(verdict).toEqual({
      assetId: null,
      verdict: "unconfirmed",
      rationaleRef: "mechanical:no-candidates",
    });
  });

  it("缺 citationMetrics ⇒ 全 unconfirmed（不猜）", async () => {
    const judge = new MechanicalJudge();
    const verdict = await judge.judge({
      unitId: "edge-no-metrics",
      sessionKey: "replay",
      round: 0,
      unit: { kind: "calibration", payload: {} },
      candidates: [{ assetId: "a", assetType: "skill", evidenceSourceType: "injected" }],
      promptRef: judge.promptRef,
    });
    expect(verdict).toEqual({
      assetId: null,
      verdict: "unconfirmed",
      rationaleRef: "mechanical:no-metrics",
    });
  });

  it("coverage=NaN（非有限数，手工构造不过 grading）⇒ unconfirmed（isCoverageKnown 门禁，绝不进比较）", async () => {
    // B5 警告的正是这条：`NaN >= t` 恒 false（静默 unconfirmed），而 `!(x < t)` 会误判 confirmed。
    // grading 产物只会是 "unknown" 字符串（typeof 检查挡）；本格钉"另一来源直接给 NaN 数字"时
    // isCoverageKnown 冗余门禁仍挡 —— R2 反向控制的判定点。
    const judge = new MechanicalJudge();
    const verdict = await judge.judge({
      unitId: "edge-nan",
      sessionKey: "replay",
      round: 0,
      unit: { kind: "calibration", payload: {} },
      candidates: [{ assetId: "a", assetType: "skill", evidenceSourceType: "injected" }],
      promptRef: judge.promptRef,
      citationMetrics: [
        {
          assetId: "a",
          matchLevel: "exact",
          matchedTier: "block",
          coverage: Number.NaN,
          coverageDistinct: 0,
          coverageCovered: 0,
          exclusionCount: 0,
          ngramTableSha256: "x",
        },
      ],
    });
    expect(verdict.verdict).toBe("unconfirmed");
    expect(verdict.assetId).toBe(null);
  });
});

describe("58 · T3 缺省关闭（缺省 mock；显式才 mechanical）", () => {
  it("默认 config ⇒ judge_impl=mock:v1；显式 provider=mechanical ⇒ judge_impl=mechanical:v1（落库列实证）", async () => {
    // ① 默认（缺省关闭）：buildConfig({}) 的 provider 缺省 ⇒ mock
    withTempDb();
    try {
      queueRepo().enqueue({
        unitId: "u-t3-default",
        sessionKey: "sess-t3a",
        payload: { kind: "restraint", turnSeq: 1, payload: { text: "abc" } },
      });
      await runWorker(buildWorkerDeps(buildConfig({}), "t3-owner"), { drain: true });
      const rowsA = detailsRepo().listBySession("sess-t3a");
      expect(rowsA.length).toBe(1);
      console.log(`T3 默认 → judge_impl=${rowsA[0]!.judge_impl}`);
      expect(rowsA[0]!.judge_impl, "缺省必须是 mock（未标定不上线，B5）").toBe("mock:v1");
    } finally {
      teardownTempDb();
    }

    // ② 显式开启 mechanical
    withTempDb();
    try {
      const cfg = buildConfig({});
      cfg.attribution = { ...(cfg.attribution ?? {}), judge: { ...(cfg.attribution?.judge ?? {}), provider: "mechanical" } } as typeof cfg.attribution;
      queueRepo().enqueue({
        unitId: "u-t3-mech",
        sessionKey: "sess-t3b",
        payload: { kind: "restraint", turnSeq: 1, payload: { text: "abc" } },
      });
      await runWorker(buildWorkerDeps(cfg, "t3-owner"), { drain: true });
      const rowsB = detailsRepo().listBySession("sess-t3b");
      expect(rowsB.length).toBe(1);
      console.log(`T3 显式 → judge_impl=${rowsB[0]!.judge_impl}`);
      expect(rowsB[0]!.judge_impl).toBe("mechanical:v1");
    } finally {
      teardownTempDb();
    }
  });

  it("createJudge 解析：mock / mechanical / 未知（60 起 fail-closed：throw，不再降级 mock）", () => {
    expect(createJudge({ attribution: { judge: { provider: "mock" } } }).impl).toBe("mock:v1");
    expect(createJudge({ attribution: { judge: { provider: "mechanical" } } }).impl).toBe("mechanical:v1");
    expect(() => createJudge({ attribution: { judge: { provider: "not-a-provider" } } })).toThrow(
      /unknown judge provider/,
    );
    expect(createJudge({}).impl).toBe("mock:v1"); // 缺省
  });
});

describe("58 · T4 DR-6a/b（版本漂移锚版 / 双通道一致）", () => {
  const byId = (id: string): FixtureCase => FIXTURES.cases.find((c) => c.id === id)!;

  it("DR-6a：注入 v1 → 库存改 v2 ⇒ 引文命中档①的 v1 块（锚版 = 归档窗口，不是实时存储）", async () => {
    const c = byId("dr6a");
    const { verdict, metrics } = await verdictOf(c);
    // 锚版判：confirmed @ v1 资产；命中级别 exact；命中发生在 block 层（注入归档）
    // 104 后：原命中路径 = tier=block 自匹配（已移除） ⇒ 本条降级为 unconfirmed（如实登记；
    // "锚版"可判定性的端到端验证待引文可达性（103 (d)）恢复后重建）。
    expect(verdict.verdict).toBe("unconfirmed");
    expect(verdict.assetId).toBe(null);
    expect(metrics[0]!.matchLevel).toBe("none");
    expect(metrics[0]!.matchedTier).toBe(null);
    // DR-2 锚版语义（修正版理解）：档①**如实归档了两个版本**——R0 注入的 v1 块 +
    // R1 hook-cache miss 重拉 listing 得到的 v2 块（本场景实测 piece[2]=v1、piece[5]=v2）。
    // "锚版"= 按**归档窗口**判（各版本都在档里），不是"回查当前资产存储的最新版"；
    // 命中发生在窗口序在前的 v1 块（取最强 = 第一个 exact）⇒ confirmed @ v1 版。
    const blockPieces = c.source.pieces.filter((p) => p.tier === "block");
    const v1Block = blockPieces.find((p) => p.content.includes("V1-ANCHOR"));
    const v2Block = blockPieces.find((p) => p.content.includes("V2-NEW-ANCHOR"));
    expect(v1Block, "档①必须有注入时刻的 v1 块（锚版依据）").toBeDefined();
    expect(v2Block, "档①如实归档了版本漂移（v1 之后又有 v2 注入块）").toBeDefined();
    expect(
      c.source.pieces.indexOf(v1Block!) < c.source.pieces.indexOf(v2Block!),
      "v1 块在窗口序里先于 v2 块 ⇒ 命中落在 v1 块",
    ).toBe(true);
    console.log(
      `T4 DR-6a → unconfirmed（104 后 block 自匹配移除）；档① v1+v2 双版本归档仍在窗口（锚版语义的块级证据）`,
    );
  });

  it("DR-6b：同逻辑会话 anthropic/openai ⇒ 度量与 verdict 逐条一致（分母 = 2 条样本对）", async () => {
    const a = await verdictOf(byId("dr6b-anthropic"));
    const b = await verdictOf(byId("dr6b-openai"));
    const mA = a.metrics[0]!;
    const mB = b.metrics[0]!;
    console.log(
      `T4 DR-6b → a=${a.verdict.verdict}(${mA.matchLevel}/${mA.coverage}/${mA.exclusionCount}) b=${b.verdict.verdict}(${mB.matchLevel}/${mB.coverage}/${mB.exclusionCount})`,
    );
    // 逐字段一致（度量 + verdict 两层）
    expect({
      matchLevel: mB.matchLevel,
      coverage: mB.coverage,
      exclusionCount: mB.exclusionCount,
    }).toEqual({ matchLevel: mA.matchLevel, coverage: mA.coverage, exclusionCount: mA.exclusionCount });
    expect({ verdict: b.verdict.verdict, assetId: b.verdict.assetId }).toEqual({
      verdict: a.verdict.verdict,
      assetId: a.verdict.assetId,
    });
  });
});
