/**
 * 50 spec §10 · fetched 行 → 决策单元的锚定（纯函数，零 IO）。
 *
 * 输入：显式带 `rowid` 的事件行（读口 = `AttributionEventRepo.listBySessionWithRowid`）。
 * 输出：每条 `asset_fetched` 行一个判定 —— `in_turn(turnSeq)` 或
 * `unresolved(head | tail | boundary | non_monotonic)`；**输出不含 `unit_id`**（K2）。
 *
 * 真值表 / 优先级 / 承重前提：见 docs/implementation/50-attribution-judge-worker.md §10。
 */
import { ASSET_FETCHED_EVENT_TYPE } from "./bridge-fetch-events.js";
import { EVENT_TYPE_DECISION_UNIT_CREATED } from "../decision-units/decision-unit-runner.js";

/** 锚定所需的最小行形状（`AttributionEventRowWithRowid` 结构兼容）。 */
export interface SessionEventRowLite {
  rowid: number;
  event_id: string;
  session_key: string;
  event_type: string;
  turn_seq: number | null;
  created_at: number;
}

export type FetchedAnchorUnresolvedReason = "head" | "tail" | "boundary" | "non_monotonic";

export type FetchedAnchorVerdict =
  | { kind: "in_turn"; turnSeq: number }
  | { kind: "unresolved"; reason: FetchedAnchorUnresolvedReason };

export interface AnchoredFetchedRow {
  eventId: string;
  verdict: FetchedAnchorVerdict;
}

type UnitRow = SessionEventRowLite & { turn_seq: number };

function isUnitRow(r: SessionEventRowLite): r is UnitRow {
  return r.event_type === EVENT_TYPE_DECISION_UNIT_CREATED && r.turn_seq !== null;
}

/**
 * 按 50 spec §10.2 真值表逐行判定（rowid 唯一定序；`created_at` 只做 non_monotonic
 * 自检，不参与裁决）。判定优先级：non_monotonic → head → tail → boundary → in_turn。
 */
export function anchorFetchedRows(rows: readonly SessionEventRowLite[]): AnchoredFetchedRow[] {
  const bySession = new Map<string, SessionEventRowLite[]>();
  for (const r of rows) {
    const arr = bySession.get(r.session_key);
    if (arr) arr.push(r);
    else bySession.set(r.session_key, [r]);
  }

  const out: AnchoredFetchedRow[] = [];
  for (const sessionRows of bySession.values()) {
    const sorted = [...sessionRows].sort((a, b) => a.rowid - b.rowid);
    const units = sorted.filter(isUnitRow);

    for (const f of sorted) {
      if (f.event_type !== ASSET_FETCHED_EVENT_TYPE) continue;

      let prev: UnitRow | undefined;
      let next: UnitRow | undefined;
      for (const u of units) {
        if (u.rowid < f.rowid) {
          if (!prev || u.rowid > prev.rowid) prev = u;
        } else if (u.rowid > f.rowid) {
          if (!next || u.rowid < next.rowid) next = u;
        }
      }

      // C2#1：夹缝（闭区间，缺侧取会话边界）内全部事件行的 created_at 沿 rowid 非单调 ⇒ 该段不可信
      const lo = prev ? prev.rowid : Number.NEGATIVE_INFINITY;
      const hi = next ? next.rowid : Number.POSITIVE_INFINITY;
      let nonMonotonic = false;
      let lastCreatedAt: number | null = null;
      for (const r of sorted) {
        if (r.rowid < lo || r.rowid > hi) continue;
        if (lastCreatedAt !== null && r.created_at < lastCreatedAt) {
          nonMonotonic = true;
          break;
        }
        lastCreatedAt = r.created_at;
      }

      let verdict: FetchedAnchorVerdict;
      if (nonMonotonic) {
        verdict = { kind: "unresolved", reason: "non_monotonic" };
      } else if (!prev) {
        verdict = { kind: "unresolved", reason: "head" };
      } else if (!next) {
        verdict = { kind: "unresolved", reason: "tail" };
      } else if (prev.turn_seq !== next.turn_seq) {
        verdict = { kind: "unresolved", reason: "boundary" };
      } else {
        verdict = { kind: "in_turn", turnSeq: prev.turn_seq };
      }
      out.push({ eventId: f.event_id, verdict });
    }
  }
  return out;
}
