/**
 * c-1 单测（design §4.8.2 / §5 T16）。
 *
 * T16 的核心不是"能不能折叠"，而是"**这个折叠面是可枚举的**"：
 *   1. `exact` 是默认级（P0 字节硬比对口径）—— 连 trim 都不做；
 *   2. `whitespace` 只折叠不删除（删了会让 `ab c` 与 `a bc` 撞成同一个串）；
 *   3. `punctuation` 只在**显式表**内折叠，**表外字符一律不动**；
 *   4. 明确**不用 NFKC** —— 下面对每个样例先证明「NFKC 确实会折叠它」，再证明「我们不动它」，
 *      这样"为什么不用 NFKC"就不是文档里的一句话，而是可复算的断言（改动面不可枚举 = 漂移源）。
 */

import { describe, expect, it } from "vitest";

import {
  MATCH_LEVELS,
  PUNCTUATION_FOLD_TABLE,
  collapseWhitespace,
  describeMatchLevel,
  foldPunctuation,
  foldPunctuationChar,
  normalizeForMatch,
} from "../normalize.js";

describe("T16 c-1 归一化：三级 match_level", () => {
  it("exact = 原字节（默认级；连 trim 都不做 —— 硬比对口径）", () => {
    const raw = "  a\tb\n c \u00a0\u3000";
    expect(normalizeForMatch(raw, "exact")).toBe(raw);
    expect(normalizeForMatch(raw, "exact")).toHaveLength(raw.length);
    // 反例：若 exact 顺手 trim/collapse，下面这条会红（这正是"默认级不许偷偷净化"的证据）
    expect(normalizeForMatch(raw, "exact")).not.toBe(normalizeForMatch(raw, "whitespace"));
  });

  it("whitespace = 折叠 [ \\t\\r\\n\\u00a0\\u3000]+ 为单空格 + trim", () => {
    expect(normalizeForMatch("  a\tb\n c ", "whitespace")).toBe("a b c");
    expect(normalizeForMatch("a\u00a0\u3000b", "whitespace")).toBe("a b");
    expect(normalizeForMatch("\t\r\n", "whitespace")).toBe("");
    expect(collapseWhitespace("  x  ")).toBe("x");
  });

  it("whitespace 只折叠、不删除（空格位置不同 ⇒ 结果不同，不得撞串）", () => {
    expect(normalizeForMatch("ab c", "whitespace")).not.toBe(normalizeForMatch("a bc", "whitespace"));
    expect(normalizeForMatch("ab c", "whitespace")).toBe("ab c");
  });

  it("whitespace 不感知标点：全角标点在 whitespace 级原样保留", () => {
    expect(normalizeForMatch("甲，乙。", "whitespace")).toBe("甲，乙。");
    expect(normalizeForMatch("（甲）", "whitespace")).toBe("（甲）");
  });

  it("punctuation = whitespace 之上折叠显式表（空白也一并折叠 + trim）", () => {
    expect(normalizeForMatch("　（甲），乙。　", "punctuation")).toBe("(甲),乙.");
    expect(normalizeForMatch("；：！？", "punctuation")).toBe(";:!?");
  });

  it("严格包含：exact ⊂ whitespace ⊂ punctuation（同一串逐级更强）", () => {
    const raw = " 甲（乙） ，丙\t";
    const ws = normalizeForMatch(raw, "whitespace");
    const pn = normalizeForMatch(raw, "punctuation");
    expect(normalizeForMatch(raw, "exact")).toBe(raw);
    expect(ws).not.toBe(raw);
    expect(pn).not.toBe(ws); // 标点级在空白级之上确有额外动作
    expect(normalizeForMatch(pn, "whitespace")).toBe(pn); // 折叠后再折叠 = 幂等
    expect(normalizeForMatch(pn, "punctuation")).toBe(pn);
  });
});

describe("T16 显式映射表：左列 → 右列逐对成立", () => {
  it("表中每一对都成立（按码点核，不靠肉眼辨形）", () => {
    expect(PUNCTUATION_FOLD_TABLE.length).toBeGreaterThan(0);
    for (const [full, half] of PUNCTUATION_FOLD_TABLE) {
      expect(foldPunctuationChar(full)).toBe(half);
      // 目标形是半角 ASCII ⇒ 再次折叠不变（含 = 幂等）
      expect(foldPunctuationChar(half)).toBe(half);
    }
  });

  it("逐对映射在整串上成立（按码点切，不切坏增补平面字符）", () => {
    const full = PUNCTUATION_FOLD_TABLE.map(([f]) => f).join("");
    const half = PUNCTUATION_FOLD_TABLE.map(([, h]) => h).join("");
    expect(foldPunctuation(full)).toBe(half);
    // 增补平面字符（U+1F600 需要代理对）不被切坏
    expect(foldPunctuation("😀（a）")).toBe("😀(a)");
  });
});

describe("T16 表外字符一律不动（不扩范围 / 不用 NFKC）", () => {
  it("表外全角/CJK 标点原样保留", () => {
    const untouched = "、·※…—《》〈〉～×÷±";
    expect(foldPunctuation(untouched)).toBe(untouched);
    expect(normalizeForMatch(untouched, "punctuation")).toBe(untouched);
  });

  it("NFKC 会折叠但**不在表内**的字符必须原样 —— 这就是「改动面不可枚举」的可复算证据", () => {
    // 每个样例：先证明 NFKC 确实会改动它，再证明我们的表**不动**它。
    const nfkcWouldFold = ["①", "ﬁ", "Ａ", "２", "Ⅲ", "～", "½", "㎡", "㍿", "Ⅷ"];
    for (const ch of nfkcWouldFold) {
      expect(ch.normalize("NFKC"), `${ch} 本应被 NFKC 折叠（用例前提）`).not.toBe(ch);
      expect(foldPunctuationChar(ch), `${ch} 不得被折叠（表外字符一律不动）`).toBe(ch);
      expect(normalizeForMatch(ch, "punctuation")).toBe(ch);
    }
    // 对照：表内字符确实被折叠（证明上面的"不动"不是因为整个函数没生效）
    expect(foldPunctuationChar("\uFF0C")).toBe(",");
  });
});

describe("T16 审计入口：describeMatchLevel", () => {
  it("三级都有可读 ops；级别自报与请求级别一致", () => {
    for (const level of MATCH_LEVELS) {
      const desc = describeMatchLevel(level);
      expect(desc.level).toBe(level);
      expect(desc.ops.length).toBeGreaterThan(0);
      expect(desc.ops.every((op) => typeof op === "string" && op.length > 0)).toBe(true);
    }
  });

  it("只描述『操作』，不返回阈值/布尔（基座只出口径，不出判定）", () => {
    const desc = describeMatchLevel("punctuation");
    expect(desc.ops.join(" | ")).toContain(String(PUNCTUATION_FOLD_TABLE.length));
    // 结构上只有 level + ops 两个字段 —— 没有 "matched"/"passed"/"threshold" 这类判定位
    expect(Object.keys(desc).sort()).toEqual(["level", "ops"]);
  });

  it("MATCH_LEVELS 顺序 = 由弱到强，且与 normalize 行为一致", () => {
    expect([...MATCH_LEVELS]).toEqual(["exact", "whitespace", "punctuation"]);
  });
});
