/**
 * attribution-event-observer — 归因捕获（S2）事件观察者。
 *
 * 把注入管线的生命周期写成 `attribution_events` 行（docs/implementation/20-event-observer.md）。
 *
 * 关键设计（与 spec 一致）：
 *  - 无状态：hook 级回调需要的 `meta` 由 pipeline 在调用点透传（接口尾部可选参数），
 *    本类**不 latch 任何请求态** → 全局缓存 pipeline 下的并发安全（20-spec §3.1）。
 *  - fire-and-forget：所有方法外层 try/catch，绝不 throw，写入失败只 warn 不阻断注入。
 *  - 缺 sessionKey 即放弃整段（20-spec §4.2）——不伪造会话键（绝不用 traceId 顶替）。
 *  - hook.done 的 block 带 `metadata.assets` 时按资产摊行：K 个去重资产写 K 行，
 *    每行各挂 (asset_id, asset_type)，payload 保留整块摘要（20-spec §4.3/§4.4）。
 */

import type { AgentContextMetadata, ContextBlock, InjectionHook, InjectionPoint } from "./types.js";
import type { HookResult, InjectionObserver } from "./observer.js";
import {
  getAttributionEventRepo,
  type AttributionEventRepo,
  type NewAttributionEvent,
} from "../db/attributionEventRepo.js";
import { log } from "../report/log.js";

// ── Event type vocabulary（沿用 LoggingInjectionObserver 的日志事件名）───────────────

export const EVENT_TYPE_PIPELINE_START = "injection.pipeline.start";
export const EVENT_TYPE_PIPELINE_DONE = "injection.pipeline.done";
export const EVENT_TYPE_PIPELINE_ERROR = "injection.pipeline.error";
export const EVENT_TYPE_HOOK_START = "injection.hook.start";
export const EVENT_TYPE_HOOK_DONE = "injection.hook.done";
export const EVENT_TYPE_HOOK_ERROR = "injection.hook.error";

// ── Pure asset collection ──────────────────────────────────────────────────────

/** 事件 payload 摘要里的资产条目（只带身份 + 可选辅助字段，不含 spans）。 */
export interface CollectableAsset {
  assetId: string;
  assetType: string;
  name?: string;
  version?: number;
}

/**
 * 从 blocks 聚合 `metadata.assets`（20-spec §4.4）：
 *  - 只认 metadata.assets 为数组的 block；
 *  - 条目 assetId/assetType 非空 string，否则跳过（脏数据不 throw）；
 *  - 去重键 `assetType:assetId`，跨 block 重复取先到者。
 */
export function collectAssets(blocks: ContextBlock[]): CollectableAsset[] {
  const seen = new Set<string>();
  const out: CollectableAsset[] = [];
  for (const block of blocks) {
    const rawAssets = block?.metadata?.assets;
    if (!Array.isArray(rawAssets)) continue;
    for (const item of rawAssets) {
      if (typeof item !== "object" || item === null) continue;
      const assetId = (item as { assetId?: unknown }).assetId;
      const assetType = (item as { assetType?: unknown }).assetType;
      if (typeof assetId !== "string" || assetId.length === 0) continue;
      if (typeof assetType !== "string" || assetType.length === 0) continue;
      const key = `${assetType}:${assetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry: CollectableAsset = { assetId, assetType };
      const name = (item as { name?: unknown }).name;
      const version = (item as { version?: unknown }).version;
      if (typeof name === "string" && name.length > 0) entry.name = name;
      if (typeof version === "number") entry.version = version;
      out.push(entry);
    }
  }
  return out;
}

/** 首个带 assets 的 block 的 metadata.source（无则省略）。 */
function blockSourceOf(blocks: ContextBlock[]): string | undefined {
  for (const block of blocks) {
    if (!Array.isArray(block?.metadata?.assets)) continue;
    const source = block.metadata?.source;
    if (typeof source === "string" && source.length > 0) return source;
  }
  return undefined;
}

function assetSummary(assets: CollectableAsset[]): Array<Record<string, string | number>> {
  return assets.map(({ assetId, assetType, name, version }) => {
    const entry: Record<string, string | number> = { assetId, assetType };
    if (name !== undefined) entry.name = name;
    if (version !== undefined) entry.version = version;
    return entry;
  });
}

// ── Observer ──────────────────────────────────────────────────────────────────

type BaseEvent = Omit<
  NewAttributionEvent,
  "eventType" | "assetId" | "assetType" | "payload"
>;

export class AttributionEventObserver implements InjectionObserver {
  private readonly repo: AttributionEventRepo;

  /** repo 可注入（单测用）；缺省取全局 SQLite repo。 */
  constructor(repo?: AttributionEventRepo) {
    this.repo = repo ?? getAttributionEventRepo();
  }

  onPipelineStart(meta: AgentContextMetadata): void {
    this.attempt(() => {
      const base = this.baseOf(meta);
      if (!base) return;
      this.emit(base, EVENT_TYPE_PIPELINE_START, {
        traceId: meta.traceId,
        protocol: meta.protocol,
        modelId: meta.modelId,
        requestPath: meta.requestPath,
      });
    });
  }

  onPipelineEnd(meta: AgentContextMetadata, durationMs: number, results: HookResult[]): void {
    this.attempt(() => {
      const base = this.baseOf(meta);
      if (!base) return;
      const errorCount = results.filter((r) => r.error !== undefined && r.error !== null).length;
      const totalBlockCount = results.reduce((sum, r) => sum + r.blockCount, 0);
      this.emit(base, EVENT_TYPE_PIPELINE_DONE, {
        durationMs,
        hookCount: results.length,
        totalBlockCount,
        errorCount,
        hooks: results.map((r) => {
          const entry: Record<string, unknown> = {
            hookId: r.hookId,
            point: r.point,
            blockCount: r.blockCount,
            durationMs: r.durationMs,
          };
          if (r.cacheStrategy !== undefined) entry.cacheStrategy = r.cacheStrategy;
          if (r.error !== undefined) entry.error = r.error;
          return entry;
        }),
      });
    });
  }

  onPipelineError(meta: AgentContextMetadata, error: Error): void {
    this.attempt(() => {
      const base = this.baseOf(meta);
      if (!base) return;
      this.emit(base, EVENT_TYPE_PIPELINE_ERROR, { errorMsg: error.message });
    });
  }

  onHookStart(hook: InjectionHook, point: InjectionPoint, meta?: AgentContextMetadata): void {
    this.attempt(() => {
      const base = this.baseOf(meta);
      if (!base) return;
      this.emit(base, EVENT_TYPE_HOOK_START, {
        hookId: hook.id,
        point,
        cacheStrategy: hook.cacheStrategy,
      });
    });
  }

  onHookDone(
    hook: InjectionHook,
    point: InjectionPoint,
    blocks: ContextBlock[],
    durationMs: number,
    cacheStrategy?: string,
    meta?: AgentContextMetadata,
  ): void {
    this.attempt(() => {
      const base = this.baseOf(meta);
      if (!base) return;
      const assets = collectAssets(blocks);
      const payloadBase: Record<string, unknown> = {
        hookId: hook.id,
        point,
        blockCount: blocks.length,
        durationMs,
        cacheStrategy,
      };
      const source = blockSourceOf(blocks);
      if (source !== undefined) payloadBase.blockSource = source;
      if (assets.length === 0) {
        this.emit(base, EVENT_TYPE_HOOK_DONE, { ...payloadBase, assets: [] }, null, null);
        return;
      }
      const summary = assetSummary(assets);
      for (const asset of assets) {
        this.emit(
          base,
          EVENT_TYPE_HOOK_DONE,
          { ...payloadBase, assets: summary },
          asset.assetId,
          asset.assetType,
        );
      }
    });
  }

  onHookError(
    hook: InjectionHook,
    point: InjectionPoint,
    error: Error,
    durationMs: number,
    meta?: AgentContextMetadata,
  ): void {
    this.attempt(() => {
      const base = this.baseOf(meta);
      if (!base) return;
      this.emit(base, EVENT_TYPE_HOOK_ERROR, {
        hookId: hook.id,
        point,
        errorMsg: error.message,
        durationMs,
      });
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** 缺 sessionKey 即放弃（20-spec §4.2）。 */
  private baseOf(meta?: AgentContextMetadata): BaseEvent | null {
    if (!meta || typeof meta.sessionKey !== "string" || meta.sessionKey.length === 0) {
      return null;
    }
    return {
      spaceId: meta.spaceId,
      userId: meta.userId,
      agentSource: meta.agentSource,
      sessionKey: meta.sessionKey,
      turnSeq: meta.turnSeq ?? null,
      msgSeq: null,
    };
  }

  private emit(
    base: BaseEvent,
    eventType: string,
    payload: unknown,
    assetId: string | null = null,
    assetType: string | null = null,
  ): void {
    this.repo.append({ ...base, eventType, assetId, assetType, payload });
  }

  private attempt(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      // Observer 纪律：绝不向管线抛。事件写入失败不阻断注入。
      log.warn("attribution-event-observer write failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
