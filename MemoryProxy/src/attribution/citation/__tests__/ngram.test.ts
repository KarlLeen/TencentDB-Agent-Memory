/**
 * c-3 单测（design §4.8.4 / §5 T21、T22、T23、T24）。
 *
 * 三件事必须钉死，否则这张表在 50 spec 里不可用：
 *   T21 可复现 —— 同语料两次构建同 `tableSha256`；**语料顺序打乱不变**；换 `n` 必变。
 *   T22 cap 语义 —— 取"按稳定序前 cap 条"，触发即 `corpusRows.capped=true`，可复现。
 *   T23 df/idf 正确性 —— 3 行手算语料逐 gram 对账；`idf` 随 `df` 单调不增。
 *   T24 度量接口形状 —— 只出数字/数组，**不返回布尔判定**；"无依据"是 NaN 哨兵，
 *       与两种**合法 0/1** 严格区分（这是 §4.8.4 明文锁的边界）。
 */

import { describe, expect, it } from "vitest";

import {
  COVERAGE_NO_BASIS,
  DEFAULT_CORPUS_CAP,
  DEFAULT_NGRAM_N,
  IDF_NO_BASIS,
  buildRarityTable,
  charNgramSet,
  charNgrams,
  distinctiveGrams,
  gramCoverage,
  isCoverageKnown,
  rarity,
} from "../ngram.js";

const HEX64 = /^[0-9a-f]{64}$/;

describe("c-3 基础：char n-gram（按码点切 / 去重 / 保序 / 短文本无 gram）", () => {
  it("去重 + 保序", () => {
    expect(charNgrams("aaaa", 2)).toEqual(["aa"]);
    expect(charNgrams("abc", 1)).toEqual(["a", "b", "c"]);
    expect(charNgrams("abab", 2)).toEqual(["ab", "ba"]);
  });

  it("短于阶数 ⇒ 无 gram（不是抛）", () => {
    expect(charNgrams("ab", 4)).toEqual([]);
    expect(charNgrams("", 4)).toEqual([]);
    expect(charNgrams("abc", 0)).toEqual([]);
    expect(charNgrams("abc", -1)).toEqual([]);
  });

  it("按码点切：增补平面字符不被切坏", () => {
    expect(charNgrams("😀😀a", 2)).toEqual(["😀😀", "😀a"]);
    expect([...charNgramSet("😀😀😀", 2)]).toEqual(["😀😀"]);
  });

  it("默认阶数/上限是显式常量（改它就是换表，必须走本文件）", () => {
    expect(DEFAULT_NGRAM_N).toBe(4);
    expect(DEFAULT_CORPUS_CAP).toBe(2000);
  });
});

describe("T21 稀有度表确定性：同语料同 sha / 顺序无关 / 换 n 必换表", () => {
  const corpus = ["aaab", "aacd", "bbcd"];

  it("同语料两次构建 ⇒ tableSha256 逐字节相同（64 位 hex）", () => {
    const a = buildRarityTable(corpus, { n: 2 });
    const b = buildRarityTable(corpus, { n: 2 });
    expect(a.tableSha256).toBe(b.tableSha256);
    expect(a.tableSha256).toMatch(HEX64);
  });

  it("语料输入顺序打乱 ⇒ sha 不变（df 是集合语义 + 输出按 gram 升序）", () => {
    const base = buildRarityTable(corpus, { n: 2 });
    const shuffled = buildRarityTable(["bbcd", "aaab", "aacd"], { n: 2 });
    expect(shuffled.tableSha256).toBe(base.tableSha256);
    expect(shuffled.docCount).toBe(base.docCount);
  });

  it("换 n ⇒ sha 必变（n 参与了哈希）", () => {
    const n2 = buildRarityTable(corpus, { n: 2 });
    const n3 = buildRarityTable(corpus, { n: 3 });
    expect(n3.n).toBe(3);
    expect(n3.tableSha256).not.toBe(n2.tableSha256);
  });

  it("corpusRows 参与 sha：只看行数出处也变（blocks/messages/capped 都在哈希里）", () => {
    const plain = buildRarityTable(corpus, { n: 2 });
    const withRows = buildRarityTable(corpus, { n: 2, rows: { blocks: 2000, messages: 2000, capped: true } });
    expect(withRows.corpusRows).toEqual({ blocks: 2000, messages: 2000, capped: true });
    expect(withRows.tableSha256).not.toBe(plain.tableSha256);
  });
});

describe("T22 cap 语义：取稳定序前 cap 条，触发即 capped=true", () => {
  const five = ["r1", "r2", "r3", "r4", "r5"];

  it("超 cap ⇒ 只取前 cap 条 + capped=true", () => {
    const t = buildRarityTable(five, { n: 2, cap: 3 });
    expect(t.docCount).toBe(3);
    expect(t.corpusRows.capped).toBe(true);
    // 取的是"前 3 条"：r4/r5 的 gram 不在 df 里
    expect(t.df.get("r4")).toBeUndefined();
    expect(t.df.get("r3")).toBe(1);
  });

  it("cap 内 ⇒ capped=false，且 == 不传 cap 的结果", () => {
    const t = buildRarityTable(five, { n: 2, cap: 10 });
    expect(t.docCount).toBe(5);
    expect(t.corpusRows.capped).toBe(false);
    expect(t.tableSha256).toBe(buildRarityTable(five, { n: 2 }).tableSha256);
  });

  it("cap 可复现：同 cap 同语料 ⇒ 同 sha；换 cap ⇒ 换 sha", () => {
    const a = buildRarityTable(five, { n: 2, cap: 3 });
    const b = buildRarityTable(five, { n: 2, cap: 3 });
    const c = buildRarityTable(five, { n: 2, cap: 4 });
    expect(a.tableSha256).toBe(b.tableSha256);
    expect(c.tableSha256).not.toBe(a.tableSha256);
  });

  it("rows.capped 可显式上报（per-source cap 只有调用方知道，见 §4.8.6）", () => {
    const t = buildRarityTable(["only-one"], { n: 2, rows: { blocks: 2000, messages: 2000, capped: true } });
    expect(t.docCount).toBe(1);
    expect(t.corpusRows.capped).toBe(true); // 兜底 cap 未触发，但按上报置位
  });

  it("空语料合法（docCount=0，不抛）—— 缺 DB / 无归档的降级路径", () => {
    const t = buildRarityTable([]);
    expect(t.docCount).toBe(0);
    expect(t.df.size).toBe(0);
    expect(t.tableSha256).toMatch(HEX64);
    expect(t.n).toBe(DEFAULT_NGRAM_N);
  });
});

describe("T23 df/idf 正确性：3 行手算语料逐 gram 对账", () => {
  // n=2：aaab→{aa,ab}；aacd→{aa,ac,cd}；bbcd→{bb,bc,cd}；docCount=3
  const table = buildRarityTable(["aaab", "aacd", "bbcd"], { n: 2 });

  it("df = 文档频次（文档 = 一条归档行，不是 gram 总数）", () => {
    expect(table.docCount).toBe(3);
    expect(table.df.get("aa")).toBe(2);
    expect(table.df.get("cd")).toBe(2);
    expect(table.df.get("ab")).toBe(1);
    expect(table.df.get("ac")).toBe(1);
    expect(table.df.get("bb")).toBe(1);
    expect(table.df.get("bc")).toBe(1);
    expect(table.df.get("zz")).toBeUndefined();
  });

  it("idf = ln((docCount+1)/(df+1))（加一平滑；df=0 也有有限大值，不炸 Infinity）", () => {
    expect(rarity(table, "aa").idf).toBeCloseTo(Math.log(4 / 3), 12);
    expect(rarity(table, "ab").idf).toBeCloseTo(Math.log(4 / 2), 12);
    const unknown = rarity(table, "zz");
    expect(unknown.df).toBe(0);
    expect(unknown.idf).toBeCloseTo(Math.log(4 / 1), 12);
    expect(Number.isFinite(unknown.idf)).toBe(true);
  });

  it("idf 随 df 单调不增（df 越大越不稀有）", () => {
    expect(rarity(table, "ab").idf).toBeGreaterThan(rarity(table, "aa").idf);
    expect(rarity(table, "zz").idf).toBeGreaterThan(rarity(table, "ab").idf);
  });

  it("空表：idf 是哨兵 NaN（无统计依据 ≠ 无限稀有）", () => {
    const empty = buildRarityTable([]);
    const r = rarity(empty, "anything");
    expect(r.df).toBe(0);
    expect(Number.isNaN(r.idf)).toBe(true);
    expect(r.idf).toBe(IDF_NO_BASIS);
    expect(r.idf).not.toBe(0);
    expect(r.idf).not.toBe(1);
  });
});

describe("T24 度量接口形状：只出数字/数组，不出布尔判定", () => {
  const table = buildRarityTable(["AAAB", "AAAC", "AAAD"], { n: 2 }); // AA:3, AB/AC/AD:1
  const windowText = "AAAB";

  it("覆盖率是数字：引文全在窗口 ⇒ 1；gram 全不在窗口 ⇒ **合法 0**", () => {
    const hit = gramCoverage(windowText, "AAAB", table);
    expect(hit.coverage).toBe(1);
    expect(hit.distinct).toBe(2);
    expect(hit.covered).toBe(2);
    expect(hit.n).toBe(2);

    const miss = gramCoverage(windowText, "AD", table); // AD 在语料里(df=1)但不在窗口
    expect(miss.coverage).toBe(0); // 合法 0：真实结论"不覆盖"
    expect(miss.distinct).toBe(1);
    expect(miss.covered).toBe(0);
  });

  it("三种『无依据』都返回 NaN 哨兵，且与 0/1 严格区分", () => {
    // ① 空表
    const noTable = gramCoverage(windowText, "AAAB", buildRarityTable([]));
    // ② 引文过短（没有 n-gram）
    const tooShort = gramCoverage(windowText, "A", table);
    // ③ minIdf 过严：引文 gram 全被过滤（AD idf≈0.69 < 1）
    const filtered = gramCoverage(windowText, "AD", table, { minIdf: 1 });
    for (const r of [noTable, tooShort, filtered]) {
      expect(Number.isNaN(r.coverage)).toBe(true);
      expect(r.coverage).toBe(COVERAGE_NO_BASIS);
      expect(r.coverage).not.toBe(0);
      expect(r.coverage).not.toBe(1);
      expect(isCoverageKnown(r.coverage)).toBe(false);
      expect(r.distinct).toBe(0);
      expect(r.covered).toBe(0);
    }
    // 对照：合法 0 / 1 都是"有依据"的
    expect(isCoverageKnown(0)).toBe(true);
    expect(isCoverageKnown(1)).toBe(true);
  });

  it("distinctiveGrams：数组 + 每项 {gram,idf}，按 idf 降序、同 idf 按 gram 升序（全序可复现）", () => {
    const ranked = distinctiveGrams("ABCD", table, { topK: 10 });
    expect(Array.isArray(ranked)).toBe(true);
    for (const entry of ranked) {
      expect(Object.keys(entry).sort()).toEqual(["gram", "idf"]);
      expect(typeof entry.gram).toBe("string");
      expect(typeof entry.idf).toBe("number");
    }
    // AB:df1→ln2；BC/CD:df0→ln4 ⇒ 先 ln4 两个（BC<CD 升序），再 ln2
    expect(ranked.map((e) => e.gram)).toEqual(["BC", "CD", "AB"]);
    expect(ranked[0]!.idf).toBeGreaterThan(ranked[2]!.idf);
  });

  it("distinctiveGrams：topK 截断；空表 ⇒ []（不抛、不假装有结果）", () => {
    expect(distinctiveGrams("ABCD", table, { topK: 1 }).map((e) => e.gram)).toEqual(["BC"]);
    expect(distinctiveGrams("ABCD", buildRarityTable([]))).toEqual([]);
    expect(distinctiveGrams("A", table)).toEqual([]); // 过短
  });

  it("接口里没有布尔判定位（防止有人把阈值塞进基座）", () => {
    const r = gramCoverage(windowText, "AAAB", table);
    expect(Object.keys(r).sort()).toEqual(["coverage", "covered", "distinct", "n"]);
    expect(Object.values(r).every((v) => typeof v === "number")).toBe(true);
  });
});
