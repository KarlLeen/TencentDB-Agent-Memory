/**
 * 55 · S5 §9.1 决策单元锚定 —— T1–T7 测试矩阵（契约 = 50 spec §10）。
 *
 * 钉的三类系统性错误（brief K1/K2/K4 + 工单 F3–F5）：
 *   - T2 钉「取前一个单元会系统性错一轮」（跨轮边界禁猜方向）；
 *   - T5 钉「墙钟回拨 ⇒ 该段不可信」（rowid 才是定序键）；
 *   - T6 钉「分辨率到轮为止，输出不得含 unit_id」。
 * 反向控制（手工、用后即还原）：R1 实现改成「取前一个」⇒ T2 必红；R2 去掉 non_monotonic 自检 ⇒ T5 必红。
 */
import { describe, it, expect } from "vitest";
import { ASSET_FETCHED_EVENT_TYPE } from "../bridge-fetch-events.js";
import { EVENT_TYPE_DECISION_UNIT_CREATED } from "../../decision-units/decision-unit-runner.js";
import {
  anchorFetchedRows,
  type AnchoredFetchedRow,
  type SessionEventRowLite,
} from "../fetched-anchoring.js";

let rid = 0;

function baseRow(
  p: Partial<SessionEventRowLite> & { session_key: string; event_type: string },
): SessionEventRowLite {
  rid += 1;
  return {
    rowid: p.rowid ?? rid,
    event_id: p.event_id ?? `ev-${rid}`,
    session_key: p.session_key,
    event_type: p.event_type,
    turn_seq: p.turn_seq ?? null,
    created_at: p.created_at ?? 1_700_000_000_000 + rid,
  };
}

const unit = (s: string, turnSeq: number, createdAt?: number): SessionEventRowLite =>
  baseRow({
    session_key: s,
    event_type: EVENT_TYPE_DECISION_UNIT_CREATED,
    turn_seq: turnSeq,
    ...(createdAt !== undefined ? { created_at: createdAt } : {}),
  });

const fetched = (s: string, createdAt?: number): SessionEventRowLite =>
  baseRow({
    session_key: s,
    event_type: ASSET_FETCHED_EVENT_TYPE,
    ...(createdAt !== undefined ? { created_at: createdAt } : {}),
  });

function show(title: string, out: AnchoredFetchedRow[]): void {
  const cells = out.map((o) =>
    o.verdict.kind === "in_turn"
      ? `${o.eventId}=in_turn(t${o.verdict.turnSeq})`
      : `${o.eventId}=unresolved(${o.verdict.reason})`,
  );
  console.log(`${title} → ${cells.length === 0 ? "(无 fetched 行)" : cells.join("  ")}`);
}

describe("55 · 决策单元锚定 T1–T7（契约 = 50 spec §10.2 真值表）", () => {
  it("T1 轮内（前后邻同 turn_seq）⇒ in_turn(t)；乱序输入同判定（rowid 才是定序键）", () => {
    const rows = [unit("S", 1), fetched("S"), unit("S", 1)];
    const out = anchorFetchedRows(rows);
    show("T1", out);
    expect(out).toHaveLength(1);
    expect(out[0].verdict).toEqual({ kind: "in_turn", turnSeq: 1 });

    const shuffled = [rows[2], rows[0], rows[1]];
    const out2 = anchorFetchedRows(shuffled);
    expect(out2[0].verdict).toEqual({ kind: "in_turn", turnSeq: 1 });
  });

  it("T2 跨轮边界 ⇒ unresolved(boundary)，且**不是**『取前一个』（K1 钉死）", () => {
    const rows = [unit("S", 1), fetched("S"), unit("S", 2)];
    const out = anchorFetchedRows(rows);
    show("T2", out);
    expect(out).toHaveLength(1);
    expect(out[0].verdict).toEqual({ kind: "unresolved", reason: "boundary" });
    // 「取前一个单元」会给出 in_turn(1) —— 显式排除（R1 反向控制的判定点）
    expect(out[0].verdict).not.toEqual({ kind: "in_turn", turnSeq: 1 });
    expect(out[0].verdict).not.toEqual({ kind: "in_turn", turnSeq: 2 });
  });

  it("T3 头窗（无任何前邻 unit）⇒ unresolved(head)", () => {
    const rows = [fetched("S"), unit("S", 1)];
    const out = anchorFetchedRows(rows);
    show("T3", out);
    expect(out[0].verdict).toEqual({ kind: "unresolved", reason: "head" });
  });

  it("T4 尾窗（无任何后邻 unit）⇒ unresolved(tail)", () => {
    const rows = [unit("S", 1), fetched("S")];
    const out = anchorFetchedRows(rows);
    show("T4", out);
    expect(out[0].verdict).toEqual({ kind: "unresolved", reason: "tail" });
  });

  it("T5 倒挂段（created_at 回拨、rowid 不动）⇒ unresolved(non_monotonic)", () => {
    // prev/next 同轮（不做自检会误判 in_turn(1) —— R2 反向控制的判定点），
    // 但夹缝里 created_at 严格下降（3000 → 2000）。
    const rows = [unit("S", 1, 1000), fetched("S", 3000), unit("S", 1, 2000)];
    const out = anchorFetchedRows(rows);
    show("T5", out);
    expect(out[0].verdict).toEqual({ kind: "unresolved", reason: "non_monotonic" });
  });

  it("T6 同轮多单元 ⇒ in_turn(t)，输出**无 unit_id**（K2：分辨率到轮为止）", () => {
    const rows = [unit("S", 1), unit("S", 1), fetched("S"), unit("S", 1)];
    const out = anchorFetchedRows(rows);
    show("T6", out);
    expect(out[0].verdict).toEqual({ kind: "in_turn", turnSeq: 1 });
    expect(Object.keys(out[0].verdict).sort()).toEqual(["kind", "turnSeq"]);
  });

  it("T7 跨会话隔离：A 的 fetched 看不到 B 的 unit（含强情形）", () => {
    // 弱情形：A 只有 fetched；B 有 unit ⇒ 泄漏会判 tail/boundary，隔离 ⇒ head
    const out1 = anchorFetchedRows([fetched("A"), unit("B", 1), unit("B", 2)]);
    show("T7-弱", out1);
    expect(out1).toHaveLength(1);
    expect(out1[0].verdict).toEqual({ kind: "unresolved", reason: "head" });

    // 强情形：A 的 fetched 被 A 的同轮 unit 夹住、行间穿插 B 的异轮 unit ⇒
    // 泄漏则 prev/next 变 B 的 9/8 判 boundary；隔离 ⇒ in_turn(1)
    const rows2 = [unit("A", 1), unit("B", 9), fetched("A"), unit("B", 8), unit("A", 1)];
    const out2 = anchorFetchedRows(rows2);
    show("T7-强", out2);
    expect(out2).toHaveLength(1);
    expect(out2[0].verdict).toEqual({ kind: "in_turn", turnSeq: 1 });
  });
});
