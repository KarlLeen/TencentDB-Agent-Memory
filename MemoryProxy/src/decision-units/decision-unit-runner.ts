/**
 * S3 决策单元 runner —— 两条 handler 接缝的调用入口。
 * docs/implementation/30-decision-unit-extractor.md §4.1 / §4.9 / §5.2 的实现。
 *
 * 职责（全部 best-effort，绝不 throw 中断请求）：
 *   1. config 开关 + 主对话守卫自检；
 *   2. 进程内水位线（sessionKey → 已处理消息数；compaction 时重置全量重放）；
 *   3. 以 `minIndex = max(0, watermark-1)` 调纯函数推导 —— 只回吐"本轮新密封"单元；
 *   4. 对密封 restraint 调 loadVisibleAssets（A2：只读 S2 已落行快照，读不到就省略）；
 *   5. getAttributionEventRepo().appendMany(...) 一次事务落库。
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

export interface RunDecisionUnitExtractionParams {
  config: { injection?: { decisionUnitExtractor?: DecisionUnitExtractorConfig } };
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

/** 测试专用：清空水位线，使下次调用从全量重放开始。 */
export function __resetDecisionUnitStateForTests(): void {
  watermarks.clear();
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
  } catch {
    // repo 已是 Null 降级 / 读失败静默 → runner 拿不到就省略，绝不 throw
    return undefined;
  }
}

export function runDecisionUnitExtraction(params: RunDecisionUnitExtractionParams): void {
  const enabled = params.config?.injection?.decisionUnitExtractor?.enabled === true;
  if (!enabled) return;
  if (!params.mainDialog || !params.hasConversation || !params.sessionKey) return;
  if (!Array.isArray(params.messages) || params.messages.length === 0) return;

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
    console.error(
      `[decision-unit] derive error (best-effort) session=${params.sessionKey}:`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  if (units.length > 0) {
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
  }

  watermarks.set(params.sessionKey, messageCount);
}
