/**
 * 94 · tsc 基线两级分类纯函数单测（C4 四格）。
 *
 * 经 createRequire 加载 `scripts/qa/tsc-baseline-check.mjs`（脚本本体走 main 守卫 ⇒ import 无副作用）。
 * 四格：① allow 命中 ⇒ pass；② warn 命中 ⇒ pass + warned（**R4 钉格**：删 warn 判据必红）；
 * ③ 清单外 file|code ⇒ offenders（fail 判据）；④ stale ⇒ note（清单在而 tsc 不报）。
 */
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

interface ClassifyResult {
  allowed: string[];
  warned: string[];
  offenders: string[];
  staleAllow: string[];
  staleWarn: string[];
}

const require = createRequire(import.meta.url);
const { classify, buildAllow, countLines } = require(
  "../../../scripts/qa/tsc-baseline-check.mjs",
) as {
  classify: (errors: Map<string, string[]>, baseline: unknown) => ClassifyResult;
  buildAllow: (errors: Map<string, string[]>, warnKeys: Set<string>) => Record<string, string[]>;
  countLines: (errors: Map<string, string[]>, keys: string[]) => number;
};

/** 造 errors：key → n 条原始行。 */
function errs(pairs: Array<[string, number]>): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [k, n] of pairs) {
    m.set(
      k,
      Array.from({ length: n }, (_, i) => `x.ts(1,1): error ${k.split("|")[1]}: line-${i}`),
    );
  }
  return m;
}

const BASELINE = {
  allow: { "src/a.ts": ["TS2322"] },
  warn: { "src/config.ts": ["TS2339"] },
};

describe("94 · tsc 基线两级分类（纯函数）", () => {
  it("① allow 命中 ⇒ pass（allowed 含、offenders 空）", () => {
    const r = classify(errs([["src/a.ts|TS2322", 3]]), BASELINE);
    expect(r.allowed).toEqual(["src/a.ts|TS2322"]);
    expect(r.offenders).toEqual([]);
    expect(r.warned).toEqual([]);
  });

  it("② warn 命中 ⇒ pass + warned（R4 钉：删 warn 判据此格必红）", () => {
    const r = classify(errs([["src/config.ts|TS2339", 1]]), BASELINE);
    expect(r.offenders).toEqual([]); // 不判红（降级为警告）
    expect(r.warned).toEqual(["src/config.ts|TS2339"]); // 但必须被点名（保留可见）
  });

  it("③ 清单外 file|code ⇒ offenders（fail 判据）", () => {
    const r = classify(errs([["src/new.ts|TS1000", 1]]), BASELINE);
    expect(r.offenders).toEqual(["src/new.ts|TS1000"]);
    expect(r.allowed).toEqual([]);
    expect(r.warned).toEqual([]);
  });

  it("④ stale ⇒ note（清单在而 tsc 不再报；allow 与 warn 两侧同口径）", () => {
    const r = classify(errs([]), BASELINE);
    expect(r.staleAllow).toEqual(["src/a.ts|TS2322"]);
    expect(r.staleWarn).toEqual(["src/config.ts|TS2339"]);
  });

  it("附 · C3：buildAllow 排除 warn 键（--update 不吞警告）；countLines 口径", () => {
    const allow = buildAllow(
      errs([
        ["src/a.ts|TS2322", 2],
        ["src/config.ts|TS2339", 1],
      ]),
      new Set(["src/config.ts|TS2339"]),
    );
    expect(allow).toEqual({ "src/a.ts": ["TS2322"] });
    expect(countLines(errs([["src/a.ts|TS2322", 2]]), ["src/a.ts|TS2322"])).toBe(2);
  });
});
