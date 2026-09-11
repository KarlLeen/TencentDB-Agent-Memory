/**
 * 56 · 证据供给 provider（50 spec §11，漏斗②③）：judge 候选的**真实供给**。
 *
 * 两路（契约 = docs/implementation/50-attribution-judge-worker.md §11）：
 *   - injected 路 = `injection.hook.done` 行（`asset_id` 非空、`turn_seq` 列对齐当前单元轮）
 *     ∪ 队列 payload `visibleAssets`（restraint 便捷路径）；
 *   - fetched 路 = `asset_fetched` 行经 §10 锚定门控：`in_turn(当前轮)` 且有 `asset_id` ⇒ 进候选；
 *     四态 unresolved 一律排除 + 按原因计数（不许"带标记进"）。
 * 合并（C2）：同 `assetId` 双源 ⇒ 一条候选、**fetched 优先**；双源事实落 `dualSource`
 * （不进 `JudgeCandidate` —— 契约零改动）。
 *
 * 边界（硬约束）：
 *   - **只读零写**（C4）：一次 `listBySessionWithRowid` 读会话全量，不重复读库、不推进水位；
 *   - DB 降级（Null repo）⇒ 两路空、**保留 `visibleAssets` 便捷路径**（不失联）——
 *     此时输出与旧路径（`extractJudgeCandidates`）逐字节一致；
 *   - 候选顺序确定性（mock judge 按顺序取第一个命中）：fetched 首见序 → hook.done 首见序
 *     → visibleAssets 原序；双源合并不新增位置。
 */
import type { AttributionEventRepo } from "../db/attributionEventRepo.js";
import { anchorFetchedRows } from "./fetched-anchoring.js";
import type { JudgeCandidate } from "./judge/types.js";

const FETCHED_EVENT_TYPE = "asset_fetched";
const HOOK_DONE_EVENT_TYPE = "injection.hook.done";

/** 观测计数（C5；落 `detail_json.evidenceSupply.stats`，分母齐全）。 */
export interface EvidenceSupplyStats {
  /** fetched 行总数（分母）。 */
  fetchedRows: number;
  /** fetched 进候选（in_turn 当前轮 + 有 asset_id，按 assetId 去重后）。 */
  fetchedIn: number;
  fetchedExcludedHead: number;
  fetchedExcludedTail: number;
  fetchedExcludedBoundary: number;
  fetchedExcludedNonMonotonic: number;
  /** in_turn 但非当前轮（§11.5 补充桶：无它分母凑不齐）。 */
  fetchedOtherTurn: number;
  /** in_turn 当前轮但 asset_id 为 NULL（brainstorm A3：无身份不进候选）。 */
  fetchedNoAssetId: number;
  /** hook.done 分支进候选数。 */
  injectedInHookDone: number;
  /** visibleAssets 分支进候选数。 */
  injectedInVisibleAssets: number;
  /** 双源合并数（fetched ∩ injected，同 assetId）。 */
  mergedDualSource: number;
  /** injected 两分支互撞去重数（hook.done ∩ visibleAssets，同 assetId；不算双源）。 */
  injectedDuplicate: number;
}

/** 双源事实（C2：不进 JudgeCandidate，落 detail_json）。 */
export interface DualSourceFact {
  assetId: string;
  assetType: string;
  fetchedTurnSeq: number;
  injectedVia: "hook.done" | "visibleAssets";
}

export interface EvidenceSupplyResult {
  candidates: JudgeCandidate[];
  stats: EvidenceSupplyStats;
  dualSource: DualSourceFact[];
  /**
   * fetched 候选的轮次（C1"进候选（带轮次 t）"的落点；`JudgeCandidate` 契约零改动 ⇒ 不进候选体）。
   * 有 fetched 进候选时 = 当前单元轮；否则 `null`。落 `detail_json.evidenceSupply.fetchedTurnSeq`。
   */
  fetchedTurnSeq: number | null;
}

export interface EvidenceSupplyInput {
  sessionKey: string;
  /** 当前单元轮次；`null` ⇒ 永不匹配（两路空，visibleAssets 分支仍走，不猜）。 */
  turnSeq: number | null;
  /** 队列 payload 的 `visibleAssets`（restraint 便捷路径；缺省/非数组 ⇒ 空）。 */
  visibleAssets?: unknown;
}

export interface EvidenceSupplyProvider {
  supply(input: EvidenceSupplyInput): EvidenceSupplyResult;
}

function emptyStats(): EvidenceSupplyStats {
  return {
    fetchedRows: 0,
    fetchedIn: 0,
    fetchedExcludedHead: 0,
    fetchedExcludedTail: 0,
    fetchedExcludedBoundary: 0,
    fetchedExcludedNonMonotonic: 0,
    fetchedOtherTurn: 0,
    fetchedNoAssetId: 0,
    injectedInHookDone: 0,
    injectedInVisibleAssets: 0,
    mergedDualSource: 0,
    injectedDuplicate: 0,
  };
}

/**
 * `visibleAssets` 数组 → 候选（assetId 去重保序、标 `"injected"`）。
 * 单份搬运逻辑：`worker.ts` 的 `extractJudgeCandidates`（旧路径 fallback）与本 provider
 * 的 visibleAssets 分支共用 —— 不许出现第二份（52 的教训）。
 */
export function extractVisibleAssetCandidates(visibleAssets: unknown): JudgeCandidate[] {
  if (!Array.isArray(visibleAssets)) return [];
  const out: JudgeCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of visibleAssets) {
    if (!raw || typeof raw !== "object") continue;
    const assetId = (raw as { assetId?: unknown }).assetId;
    const assetType = (raw as { assetType?: unknown }).assetType;
    if (typeof assetId !== "string" || assetId.length === 0) continue;
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    out.push({
      assetId,
      assetType: typeof assetType === "string" ? assetType : "unknown",
      // 来源 = S2 注入切片 ⇒ injected
      evidenceSourceType: "injected",
    });
  }
  return out;
}

interface AssetSeed {
  assetId: string;
  assetType: string;
  created_at: number;
  rowid: number;
}

/** 生产装配点：`buildWorkerDeps`（worker.ts）。测试可注入 fake repo。 */
export function createEvidenceSupplyProvider(
  repo: Pick<AttributionEventRepo, "listBySessionWithRowid">,
): EvidenceSupplyProvider {
  return {
    supply(input: EvidenceSupplyInput): EvidenceSupplyResult {
      const stats = emptyStats();
      const rows = repo.listBySessionWithRowid(input.sessionKey);

      // ── fetched 路：§10 锚定门控 ─────────────────────────────────────────
      const fetchedRows = rows.filter((r) => r.event_type === FETCHED_EVENT_TYPE);
      stats.fetchedRows = fetchedRows.length;
      const verdictByEventId = new Map(anchorFetchedRows(rows).map((a) => [a.eventId, a.verdict]));

      const inTurnSeeds: AssetSeed[] = [];
      for (const f of fetchedRows) {
        const v = verdictByEventId.get(f.event_id);
        if (!v) continue; // 不会发生（每条 fetched 行都有判定）；防御性跳过
        if (v.kind === "unresolved") {
          if (v.reason === "head") stats.fetchedExcludedHead += 1;
          else if (v.reason === "tail") stats.fetchedExcludedTail += 1;
          else if (v.reason === "boundary") stats.fetchedExcludedBoundary += 1;
          else stats.fetchedExcludedNonMonotonic += 1;
          continue;
        }
        if (v.turnSeq !== input.turnSeq) {
          stats.fetchedOtherTurn += 1;
          continue;
        }
        if (!f.asset_id) {
          stats.fetchedNoAssetId += 1;
          continue;
        }
        inTurnSeeds.push({
          assetId: f.asset_id,
          assetType: f.asset_type ?? "unknown",
          created_at: f.created_at,
          rowid: f.rowid,
        });
      }
      // A2：同资产重复按 (created_at ASC, rowid ASC) 取首见
      inTurnSeeds.sort((a, b) => a.created_at - b.created_at || a.rowid - b.rowid);

      // ── 合并（C2）：fetched 优先；顺序确定性（C2/§11.2）──────────────────
      const candidates: JudgeCandidate[] = [];
      const dualSource: DualSourceFact[] = [];
      const byAssetId = new Map<string, JudgeCandidate>();

      for (const s of inTurnSeeds) {
        if (byAssetId.has(s.assetId)) continue; // 首见
        const c: JudgeCandidate = { assetId: s.assetId, assetType: s.assetType, evidenceSourceType: "fetched" };
        byAssetId.set(s.assetId, c);
        candidates.push(c);
        stats.fetchedIn += 1;
      }

      // ── injected 路分支 1：hook.done（asset_id 非空 + turn_seq 列对齐；null 轮永不匹配）─
      const hookSeeds: AssetSeed[] = rows
        .filter(
          (r) =>
            r.event_type === HOOK_DONE_EVENT_TYPE &&
            r.asset_id !== null &&
            typeof r.turn_seq === "number" &&
            r.turn_seq === input.turnSeq,
        )
        .map((r) => ({
          assetId: r.asset_id as string,
          assetType: r.asset_type ?? "unknown",
          created_at: r.created_at,
          rowid: r.rowid,
        }));
      hookSeeds.sort((a, b) => a.created_at - b.created_at || a.rowid - b.rowid);
      const hookSeen = new Set<string>();
      for (const s of hookSeeds) {
        if (hookSeen.has(s.assetId)) continue; // 首见
        hookSeen.add(s.assetId);
        const existing = byAssetId.get(s.assetId);
        if (existing) {
          if (existing.evidenceSourceType === "fetched") {
            stats.mergedDualSource += 1;
            dualSource.push({
              assetId: s.assetId,
              assetType: s.assetType,
              fetchedTurnSeq: input.turnSeq as number,
              injectedVia: "hook.done",
            });
          } else {
            stats.injectedDuplicate += 1;
          }
          continue;
        }
        const c: JudgeCandidate = { assetId: s.assetId, assetType: s.assetType, evidenceSourceType: "injected" };
        byAssetId.set(s.assetId, c);
        candidates.push(c);
        stats.injectedInHookDone += 1;
      }

      // ── injected 路分支 2：visibleAssets（便捷路径；Null repo 也在，C4 不失联）─
      for (const c of extractVisibleAssetCandidates(input.visibleAssets)) {
        const existing = byAssetId.get(c.assetId);
        if (existing) {
          if (existing.evidenceSourceType === "fetched") {
            stats.mergedDualSource += 1;
            dualSource.push({
              assetId: c.assetId,
              assetType: c.assetType,
              fetchedTurnSeq: input.turnSeq ?? -1,
              injectedVia: "visibleAssets",
            });
          } else {
            stats.injectedDuplicate += 1;
          }
          continue;
        }
        byAssetId.set(c.assetId, c);
        candidates.push(c);
        stats.injectedInVisibleAssets += 1;
      }

      return {
        candidates,
        stats,
        dualSource,
        fetchedTurnSeq: stats.fetchedIn > 0 ? input.turnSeq : null,
      };
    },
  };
}
