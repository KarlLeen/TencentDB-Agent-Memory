/**
 * `122` · C0 验收格：S3 幂等锚"唯一定义"的同源性与行为。
 *
 * 命题：索引 DDL（`UNIT_DEDUPE_INDEX_SQL`）与入队侧胜者唯一化（`selectUnitDedupeWinners`）
 * **都**从 `UNIT_DEDUPE_ANCHOR` 派生 —— 若有人把任一处改回硬编码（不再经常量），
 * 本文件第一格（`SCHEMA_SQL` 包含常量拼出的索引 SQL）即红。
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SCHEMA_SQL, UNIT_DEDUPE_ANCHOR, UNIT_DEDUPE_INDEX_SQL, selectUnitDedupeWinners } from "../schema.js";

describe("122 · C0 同源：SCHEMA_SQL 内插的就是常量拼出的索引 DDL", () => {
  it("包含关系成立（改了常量 ⇒ SQL 内容跟着变）", () => {
    expect(SCHEMA_SQL).toContain(UNIT_DEDUPE_INDEX_SQL);
    for (const col of UNIT_DEDUPE_ANCHOR.columns) {
      expect(UNIT_DEDUPE_INDEX_SQL).toContain(col);
    }
    expect(UNIT_DEDUPE_INDEX_SQL).toContain(UNIT_DEDUPE_ANCHOR.predicate);
    expect(UNIT_DEDUPE_INDEX_SQL).toContain("attribution_events");
  });

  it("123 · C1/C3 源文件级：DDL 与入队侧都必须是『派生』而非『文字相同』（运行时不可分 ⇒ 只能源级判）", () => {
    const schemaSrc = readFileSync(new URL("../schema.ts", import.meta.url), "utf8");
    // ① 插值在位（SCHEMA_SQL 里引用常量 —— 这一行是"派生"的源级证据）。
    expect(schemaSrc).toContain("${UNIT_DEDUPE_INDEX_SQL}");
    // ② 已解析名的**字面** DDL 不得出现 —— 上面的 toContain(SCHEMA_SQL) 在"改回文字相同的硬编码"时
    //    仍绿（渲染结果逐字相同）；只有源级才能判"是不是派生"。改回硬编码 ⇒ 本行立红。
    //    ⚠️ 判据必须点名到本锚；**禁止**写成"数 CREATE UNIQUE INDEX 次数"（本文件另有 2 处别的表：
    //    idx_ajq_dedupe / idx_ajd_unit_round ⇒ 数总数会在无关改动时误红）。
    expect(schemaSrc).not.toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_ae_unit_dedupe");
    // ③ runner 侧："禁止在本文件另写槽位判断"从注释禁令升级为机械守卫（必须经共享模块/函数）。
    const runnerSrc = readFileSync(new URL("../../decision-units/decision-unit-runner.ts", import.meta.url), "utf8");
    expect(runnerSrc).toContain("selectUnitDedupeWinners");
    expect(runnerSrc).toContain('from "../db/schema.js"');
  });
});

describe("122 · C0 行为：胜者唯一化与锚语义一致（first-wins / NULL 不约束）", () => {
  const row = (turnSeq: number | null, msgSeq: number | null, tag: string) => ({
    sessionKey: "s",
    turnSeq,
    msgSeq,
    tag,
  });

  it("同锚两行 ⇒ 只留第一行（与唯一索引\"首行留、后续跳过\"一致）", () => {
    const rows = [row(1, 32, "first"), row(1, 32, "second")];
    expect(selectUnitDedupeWinners(rows).map((r) => (r as { tag: string }).tag)).toEqual(["first"]);
  });

  it("不同 msg_seq / 不同 turn_seq ⇒ 都留（不误杀）", () => {
    expect(selectUnitDedupeWinners([row(1, 32, "a"), row(1, 64, "b")])).toHaveLength(2);
    expect(selectUnitDedupeWinners([row(1, 32, "a"), row(2, 32, "b")])).toHaveLength(2);
  });

  it("msg_seq=null（谓词外）⇒ 都留", () => {
    expect(selectUnitDedupeWinners([row(1, null, "a"), row(1, null, "b")])).toHaveLength(2);
  });

  it("turn_seq=null/undefined（NULL 互不相等）⇒ 都留", () => {
    expect(selectUnitDedupeWinners([row(null, 1, "a"), row(null, 1, "b")])).toHaveLength(2);
    const noTurn = [{ sessionKey: "s", tag: "a" }, { sessionKey: "s", tag: "b" }];
    expect(selectUnitDedupeWinners(noTurn)).toHaveLength(2);
  });

  it("不同会话同槽位 ⇒ 都留（锚含 session_key）", () => {
    expect(
      selectUnitDedupeWinners([
        { sessionKey: "s1", turnSeq: 1, msgSeq: 1, tag: "a" },
        { sessionKey: "s2", turnSeq: 1, msgSeq: 1, tag: "b" },
      ]),
    ).toHaveLength(2);
  });

  it("保持输入顺序（胜者抽取不重排）", () => {
    expect(
      selectUnitDedupeWinners([row(1, 1, "a"), row(1, 2, "b"), row(1, 1, "a-dup")]).map(
        (r) => (r as { tag: string }).tag,
      ),
    ).toEqual(["a", "b"]);
  });
});
