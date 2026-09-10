/**
 * S4 · bridge 遥测的 SQLite sink（叠加式，`channel: "fetched"` 硬档）。
 * 见 MemoryProxy/docs/implementation/45-bridge-telemetry-sink.md §3.1/§3.3/§3.4。
 *
 * 做什么：把两条 bridge **已经发出**的 `kind='bridge_call'` 埋点，落一行
 * `attribution_events`（`event_type='asset_fetched'`、`payload.channel='fetched'`），
 * 给 S5 当"该轮真的取了哪些资产"的硬档原料。
 *
 * 边界（逐条都是红线）：
 *   - **零 DDL**：复用既有 `attribution_events` 表与索引，`SCHEMA_VERSION` 仍为 1。
 *   - **append-only 且不去重**：两次 `skill_view` 同一 skill = 两条真实事实，
 *     折叠成一条是伪造（§3.5）；`turn_seq`/`msg_seq`/`unit_id` 一律 NULL，不伪造。
 *   - **CH 通路保留**：本 sink 是叠加，不是替换。
 *   - **ctx 绝不落库**：`payload` 只记事实字段，任何 body 原文都不进（P1 + R9）。
 *   - 本函数**不吞异常**：由 `emitBridgeToolCallTelemetry` 的 sink 级 try/catch 兜住
 *     （§3.6），无需在此重复。
 */
import { getAttributionEventRepo } from "../db/attributionEventRepo.js";
import type { BridgeTelemetrySink } from "../memory/bridge-telemetry.js";
import { extractFetchedAssets, isMultiAssetSub } from "./bridge-fetch-assets.js";

/** v2 词表扩展（P3 拍板）；需在 `00-master-spec.md` §3 登记。 */
export const ASSET_FETCHED_EVENT_TYPE = "asset_fetched";

/** 硬档通道标识（与 S5 判定明细的 `evidence_source_type` 同词表）。 */
export const FETCHED_CHANNEL = "fetched";

/** payload schema 版本（便于将来演进）。 */
const PAYLOAD_V = 1;

/**
 * 造一个落 `attribution_events` 的叠加 sink。
 *
 * 装配点：进程启动、构造 bridge handler **之前**（`server.ts`），且仅在
 * `config.injection.bridgeFetchEvents.enabled` 为 true 时 `addBridgeTelemetrySink(...)`。
 * 缺省关闭 ⇒ 不注册 ⇒ 零新行、零新表访问、CH 通路不变。
 */
export function createBridgeFetchEventSink(): BridgeTelemetrySink {
  return (row, ctx) => {
    // skill / memory 之外的 bridgeSource 不该出现；按 skill 通道处理（提取器会因
    // sub 不在单资产集而返回空，不会误产 asset）。
    const bridgeSource: "skill-bridge" | "memory-bridge" =
      row.bridgeSource === "memory-bridge" ? "memory-bridge" : "skill-bridge";

    const executedEndpoint = row.executedEndpoint ?? "";
    const upstreamStatus = row.upstreamStatus ?? 0;

    const assets = extractFetchedAssets({
      bridgeSource,
      sub: executedEndpoint,
      inboundBody: ctx.inboundBody,
      responseText: ctx.responseText ?? null,
      upstreamStatus,
    });
    const asset = assets[0];

    const rejectReason =
      row.rejectReason && row.rejectReason.length > 0 ? row.rejectReason : null;

    const payload: Record<string, unknown> = {
      v: PAYLOAD_V,
      channel: FETCHED_CHANNEL,
      bridgeSource,
      sub: executedEndpoint,
      executedEndpoint,
      upstreamStatus,
      elapsedMs: row.elapsedMs ?? 0,
      rejectReason,
      // null = 本行无 asset（多资产语义 / memory 通道 / 两侧都取不到 id）
      assetSource: asset?.assetSource ?? null,
      // "本行按多资产语义处理、未 fan-out"。memory 通道不解析响应 ⇒ 恒 false
      // （不猜，见 §8.1）。
      multiAsset: bridgeSource === "skill-bridge" && isMultiAssetSub(executedEndpoint),
    };
    // version 仅在响应侧取到时才出现（"取不到省略"，不写 null 冒充）。
    if (asset?.version !== undefined) payload.version = asset.version;

    getAttributionEventRepo().append({
      spaceId: row.spaceId,
      userId: row.userId,
      agentSource: row.agentSource,
      sessionKey: row.sessionKey,
      // S4 不做轮次/单元关联：bridge 侧拿不到轮次（F2），不猜、不伪造。
      turnSeq: null,
      msgSeq: null,
      eventType: ASSET_FETCHED_EVENT_TYPE,
      assetId: asset?.assetId ?? null,
      assetType: asset?.assetType ?? null,
      unitId: null,
      payload,
    });
  };
}
