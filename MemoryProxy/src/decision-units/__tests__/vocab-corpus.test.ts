/**
 * vocab 命中矩阵数据驱动测试（二轮评审 BP1 收编，v1.1）。
 *
 * 职责：逐条跑 corpus（正例/反例/边角 + golden transcript），并强制"词法↔corpus
 * 覆盖完整"——新增 matcher label / 种子不补 fixture 即红。词法改动引起的
 * recall/precision 移动在这里立刻可见（配合 git diff 定位是哪一条翻转）。
 *
 * 对应 spec：docs/implementation/30-decision-unit-extractor.md §6 用例清单
 * （vocab-corpus.test.ts 一行）；corpus 数据见 ./vocab-corpus-fixtures.ts。
 */
import { describe, expect, it } from "vitest";

import { deriveDecisionUnits } from "../decision-unit-extractor.js";
import type { SealedDecisionUnit } from "../types.js";
import {
  isRiskyMatcherLabel,
  KEY_TOOL_MATCHERS,
  matchHumanSeeds,
  matchKeyToolFirst,
  matchKeyToolLabels,
  matchRiskyToolLabels,
  RISKY_HUMAN_SEEDS,
} from "../vocab.js";
import {
  EXACT_MATCH_CASES,
  GOLDEN_TRANSCRIPTS,
  HUMAN_NEGATIVE_CASES,
  HUMAN_POSITIVE_CASES,
  KEY_NEGATIVE_CASES,
  KEY_POSITIVE_CASES,
  type GoldenTranscriptCase,
} from "./vocab-corpus-fixtures.js";

const short = (text: string): string => (text.length > 48 ? `${text.slice(0, 45)}…` : text);

describe("vocab corpus · key 命令面命中矩阵", () => {
  for (const c of KEY_POSITIVE_CASES) {
    it(`正例 ${c.label}: ${short(c.text)}`, () => {
      expect(matchKeyToolLabels(c.text), c.text).toContain(c.label);
      if (isRiskyMatcherLabel(c.label)) {
        expect(matchRiskyToolLabels(c.text), c.text).toContain(c.label);
      }
    });
  }

  it("覆盖完整性：每个 KEY_TOOL_MATCHERS label 都有 ≥1 正例（新增词法不补 corpus 即红）", () => {
    const inCorpus = new Set(KEY_POSITIVE_CASES.map((c) => c.label));
    for (const m of KEY_TOOL_MATCHERS) {
      expect(inCorpus, `缺少 ${m.label} 的正例（KEY_POSITIVE_CASES）`).toContain(m.label);
    }
  });

  it("反例不误报（precision）", () => {
    for (const text of KEY_NEGATIVE_CASES) {
      expect(matchKeyToolLabels(text), `key: ${text}`).toEqual([]);
      expect(matchRiskyToolLabels(text), `risky: ${text}`).toEqual([]);
    }
  });

  it("边角锁精确命中集与优先级（多命中 / 段切分 / --amend 正文不误判）", () => {
    for (const c of EXACT_MATCH_CASES) {
      expect(matchKeyToolLabels(c.text), `key: ${c.text}`).toEqual(c.keyLabels);
      expect(matchRiskyToolLabels(c.text), `risky: ${c.text}`).toEqual(c.riskyLabels);
      expect(matchKeyToolFirst(c.text), `first: ${c.text}`).toBe(c.firstLabel);
    }
  });
});

describe("vocab corpus · human 口语种子（restraint 触发面）", () => {
  for (const c of HUMAN_POSITIVE_CASES) {
    it(`正例 seed ${c.label}: ${short(c.text)}`, () => {
      expect(matchHumanSeeds(c.text), c.text).toContain(c.label);
    });
  }

  it("覆盖完整性：每个 RISKY_HUMAN_SEEDS 种子都有 ≥1 正例", () => {
    const inCorpus = new Set(HUMAN_POSITIVE_CASES.map((c) => c.label));
    for (const seed of RISKY_HUMAN_SEEDS) {
      expect(inCorpus, `缺少 seed ${seed} 的正例（HUMAN_POSITIVE_CASES）`).toContain(seed);
    }
  });

  it("反例不误报（纯中文 / 安全请求）", () => {
    for (const text of HUMAN_NEGATIVE_CASES) {
      expect(matchHumanSeeds(text), text).toEqual([]);
    }
  });
});

function summarize(u: SealedDecisionUnit): Record<string, unknown> {
  const p = u.payload as unknown as Record<string, unknown>;
  return {
    kind: u.kind,
    unitType: p.unitType,
    matchedBy: p.matchedBy,
    filePath: p.filePath,
    resultStatus: p.resultStatus,
    resultMissing: p.resultMissing === true,
  };
}

function assertGolden(g: GoldenTranscriptCase): void {
  const units = deriveDecisionUnits(g.messages, g.protocol);
  const actual = units.map(summarize);
  expect(actual, `${g.name}: 单元数`).toHaveLength(g.expected.length);
  for (const exp of g.expected) {
    expect(
      actual.some((a) => Object.entries(exp).every(([k, v]) => a[k] === v)),
      `${g.name}: 缺 ${JSON.stringify(exp)}; actual=${JSON.stringify(actual)}`,
    ).toBe(true);
  }
}

describe("vocab corpus · golden transcript 全管线输出（seal/配对/tombstone/克制）", () => {
  for (const g of GOLDEN_TRANSCRIPTS) {
    it(g.name, () => {
      assertGolden(g);
    });
  }
});
