/**
 * `122` · C0 验收格：S3 幂等锚"唯一定义"的同源性与行为。
 *
 * 命题：索引 DDL（`UNIT_DEDUPE_INDEX_SQL`）与入队侧胜者唯一化（`selectUnitDedupeWinners`）
 * **都**从 `UNIT_DEDUPE_ANCHOR` 派生 —— 若有人把任一处改回硬编码（不再经常量），
 * 本文件第一格（`SCHEMA_SQL` 包含常量拼出的索引 SQL）即红。
 */
import { describe, expect, it } from "vitest";

import { SCHEMA_SQL, UNIT_DEDUPE_ANCHOR, UNIT_DEDUPE_INDEX_SQL, selectUnitDedupeWinners } from "../schema.js";

describe("122 · C0 同源：SCHEMA_SQL 内插的就是常量拼出的索引 DDL", () => {
  it("包含关系成立（任一处回归硬编码 ⇒ 红）", () => {
    expect(SCHEMA_SQL).toContain(UNIT_DEDUPE_INDEX_SQL);
    for (const col of UNIT_DEDUPE_ANCHOR.columns) {
      expect(UNIT_DEDUPE_INDEX_SQL).toContain(col);
    }
    expect(UNIT_DEDUPE_INDEX_SQL).toContain(UNIT_DEDUPE_ANCHOR.predicate);
    expect(UNIT_DEDUPE_INDEX_SQL).toContain("attribution_events");
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
