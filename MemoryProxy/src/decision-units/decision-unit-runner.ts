/**
 * S3 决策单元 runner —— 两条 handler 接缝的调用入口。
 * docs/implementation/30-decision-unit-extractor.md §4.1 / §4.9 / §5.2 的实现。
 *
 * 职责（全部 best-effort，绝不 throw 中断请求）：
 *   1. config 开关 + 主对话守卫自检；
 *   2. 进程内水位线（sessionKey → 已处理消息数；compaction 时重置全量重放；
 *      按会话上限淘汰）＋运行统计（v1.1 最小观测，见 getDecisionUnitRunStats）；
 *   3. 以 `minIndex = max(0, watermark-1)` 调纯函数推导 —— 只回吐"本轮新密封"单元；
 *   4. 对密封 restraint 调 loadVisibleAssets（A2：只读 S2 已落行快照，读不到就省略）；
 *   5. getAttributionEventRepo().appendMany(...) 一次事务落库。
 *   6. （共享基座，attribution-base-design.md §4.6）落库后 fire-and-forget 入 judge 队列 ——
 *      **动态 import**：`attribution.judge.enqueue` 缺省 false 时连模块都不加载（零访问）。
 *
 * 同步临界区：better-sqlite3 同步写 + 模块内 Map，JS 单线程下无并发交错。
 * 崩溃重放冲突由 repo 的 `idx_ae_unit_dedupe` 静默跳过兜底。
 */
import { deriveDecisionUnits } from "./decision-unit-extractor.js";
import type { RestraintPayload, SealedDecisionUnit } from "./types.js";
import { getAttributionEventRepo } from "../db/attributionEventRepo.js";
import type { AttributionEventRepo, NewAttributionEvent } from "../db/attributionEventRepo.js";

/** S3 只新增这一事件类型的写入方（master §3 词汇表不变）。 */
export const EVENT_TYPE_DECISION_UNIT_CREATED = "decision_unit.created";

/** 只声明 runner 需要的 config 形状（结构类型，避免依赖注入的 ProxyConfig 全形）。 */
export interface DecisionUnitExtractorConfig {
  enabled?: boolean;
}

/** 共享基座入队开关（结构类型：只声明本 runner 需要的那一格）。 */
export interface DecisionUnitJudgeEnqueueConfig {
  attribution?: { judge?: { enqueue?: boolean } };
}

export interface RunDecisionUnitExtractionParams {
  config: {
    injection?: { decisionUnitExtractor?: DecisionUnitExtractorConfig };
    attribution?: { judge?: { enqueue?: boolean } };
  };
  protocol: "anthropic" | "openai";
  mainDialog: boolean;
  hasConversation: boolean;
  messages: unknown[];
  sessionKey: string;
  spaceId?: string;
  userId?: string | null;
  agentSource?: string;
}

/** 进程内水位线：sessionKey → 已处理消息条数（含当前轮）。 */
const watermarks = new Map<string, number>();

/** 水位线会话上限：淘汰最早一条，防长跑 server 无限增长（二轮评审 R4）。 */
const MAX_WATERMARK_SESSIONS = 2048;

function evictOldestWatermark(): void {
  while (watermarks.size > MAX_WATERMARK_SESSIONS) {
    const oldest = watermarks.keys().next();
    if (oldest.done) break;
    watermarks.delete(oldest.value);
  }
}

/** S3 最小观测（二轮评审 R1）：进程内运行计数，供开启 checklist / 测试断言。 */
export interface DecisionUnitRunStats {
  runs: number;
  /** 本轮推导出的密封单元数（含 tombstone）。 */
  sealedUnits: number;
  /** 撕裂窗口 unknown 留痕（payload.resultMissing === true）条数。 */
  tombstones: number;
  deriveErrors: number;
  /** live：当前水位线会话数（上限 MAX_WATERMARK_SESSIONS，超过即淘汰最早者）。 */
  activeWatermarkSessions: number;
}
const runStats: DecisionUnitRunStats = {
  runs: 0,
  sealedUnits: 0,
  tombstones: 0,
  deriveErrors: 0,
  activeWatermarkSessions: 0,
};

/** 读运行统计快照（activeWatermarkSessions 取 live 值）。 */
export function getDecisionUnitRunStats(): DecisionUnitRunStats {
  return { ...runStats, activeWatermarkSessions: watermarks.size };
}

/** 测试专用：清空水位线与运行统计，使下次调用从全量重放开始。 */
export function __resetDecisionUnitStateForTests(): void {
  watermarks.clear();
  runStats.runs = 0;
  runStats.sealedUnits = 0;
  runStats.tombstones = 0;
  runStats.deriveErrors = 0;
}

/** A2（spec §4.9）：restraint 密封时读同会话同锚点轮 S2 注入可见切片快照。 */
function loadVisibleAssets(
  repo: AttributionEventRepo,
  sessionKey: string,
  turnSeq: number,
): Array<{ assetId: string; assetType: string }> | undefined {
  try {
    const rows = repo.listBySession(sessionKey, { eventType: "injection.hook.done", limit: 5000 });
    const seen = new Set<string>();
    const out: Array<{ assetId: string; assetType: string }> = [];
    for (const row of rows) {
      if (row.turn_seq !== turnSeq) continue;
      if (!row.asset_id || !row.asset_type) continue;
      const key = `${row.asset_id}\u0000${row.asset_type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ assetId: row.asset_id, assetType: row.asset_type });
    }
    return out.length > 0 ? out : undefined;
  } catch (err) {
    // repo 读失败（非 Null 空表）→ 降级省略 visibleAssets，但留下告警便于观测退化。
    console.warn(
      `[decision-unit] visibleAssets load failed (best-effort) session=${sessionKey} turn=${turnSeq}:`,
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}

export function runDecisionUnitExtraction(params: RunDecisionUnitExtractionParams): void {
  const enabled = params.config?.injection?.decisionUnitExtractor?.enabled === true;
  if (!enabled) return;
  if (!params.mainDialog || !params.hasConversation || !params.sessionKey) return;
  if (!Array.isArray(params.messages) || params.messages.length === 0) return;
  runStats.runs += 1;

  const messageCount = params.messages.length;
  let watermark = watermarks.get(params.sessionKey) ?? 0;
  const compacted = messageCount < watermark;
  if (compacted) watermark = 0;

  // 水位线-1：上一轮末消息可能在本轮被密封（其后续消息出现），留 1 条 lookback。
  const minIndex = Math.max(0, watermark - 1);

  let units: SealedDecisionUnit[];
  try {
    units = deriveDecisionUnits(params.messages, params.protocol, { minIndex });
  } catch (err) {
    // 纯函数理论上不 throw；任何异常都 best-effort 降级，不中断请求。
    runStats.deriveErrors += 1;
    console.error(
      `[decision-unit] derive error (best-effort) session=${params.sessionKey}:`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  if (units.length > 0) {
    runStats.sealedUnits += units.length;
    runStats.tombstones += units.filter(
      (u) => (u.payload as { resultMissing?: boolean }).resultMissing === true,
    ).length;
    const repo = getAttributionEventRepo();
    const events: NewAttributionEvent[] = units.map((unit) => {
      let payload = unit.payload;
      if (unit.kind === "restraint") {
        const visibleAssets = loadVisibleAssets(repo, params.sessionKey, unit.turnSeq);
        if (visibleAssets !== undefined) {
          payload = { ...payload, visibleAssets } as RestraintPayload;
        }
      }
      return {
        spaceId: params.spaceId,
        userId: params.userId ?? undefined,
        agentSource: params.agentSource,
        sessionKey: params.sessionKey,
        turnSeq: unit.turnSeq,
        msgSeq: unit.msgSeq,
        eventType: EVENT_TYPE_DECISION_UNIT_CREATED,
        unitId: unit.unitId,
        payload,
      };
    });
    repo.appendMany(events);
    // 共享基座（v2 前置骨架）：落库后 fire-and-forget 入 judge 队列。
    maybeEnqueueJudgeQueue(params, units, events);
  }

  watermarks.set(params.sessionKey, messageCount);
  evictOldestWatermark();
}

/**
 * 共享基座入队（attribution-base-design.md §4.6）。三条不变量：
 *   1. 开关缺省 false ⇒ **提前 return**，不 import、不碰库（零访问硬约束）；
 *   2. **动态 import** ⇒ 关闭时 `src/attribution/*` 整个模块图都不加载；
 *   3. 任何异常只 warn —— 入队失败绝不能影响 v1 落库链路（fire-and-forget）。
 *
 * 用 events 而非 units 派生入队项，是为了让 payload 与**真正落库的那一份**逐字节一致
 * （restraint 的 visibleAssets 是在 events.map 里合并进去的）。
 */
function maybeEnqueueJudgeQueue(
  params: RunDecisionUnitExtractionParams,
  units: SealedDecisionUnit[],
  events: NewAttributionEvent[],
): void {
  if (params.config?.attribution?.judge?.enqueue !== true) return;
  try {
    const queueUnits = events.flatMap((event, index) => {
      const unitId = event.unitId;
      if (typeof unitId !== "string" || unitId.length === 0) return [];
      return [
        {
          unitId,
          kind: String(units[index]?.kind ?? "unknown"),
          turnSeq: event.turnSeq ?? 0,
          msgSeq: event.msgSeq ?? 0,
          payload: event.payload,
        },
      ];
    });

    void import("../attribution/enqueue.js")
      .then((mod) => {
        mod.enqueueUnitsForJudge({
          config: params.config,
          units: queueUnits,
          sessionKey: params.sessionKey,
          spaceId: params.spaceId,
        });
      })
      .catch((err: unknown) => {
        console.warn(
          "[decision-unit] attribution enqueue failed (best-effort):",
          err instanceof Error ? err.message : String(err),
        );
      });
  } catch (err) {
    console.warn(
      "[decision-unit] attribution enqueue dispatch failed (best-effort):",
      err instanceof Error ? err.message : String(err),
    );
  }
}
