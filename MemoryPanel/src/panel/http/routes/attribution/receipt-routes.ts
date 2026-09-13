/**
 * 76 · S7-c 归因 BFF：回执页两端点（RPC）。
 *
 *   POST /api/v1/attribution/sessions   → proxy GET /v3/admin/attribution/sessions
 *   POST /api/v1/attribution/receipt    → proxy GET /v3/admin/attribution/sessions/{key}
 *
 * 无界拒绝照 S7-a：`sessions` 缺 `limit`/`since` ⇒ 400（拒绝无界全表扫）。
 *
 * `144 · C3`：回执富化 = **只读** `asset/get`（名称/类型/更新时间）；失败/缺值 ⇒ `meta = null`
 * （前端渲染"未知"，不得用 0/空串冒充）；**零新增写路径**。
 */
import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';
import type { ProxyEnvelope } from '../../../kernel/ports/attribution-proxy-port.js';
import { respondControlError } from '../../envelope.js';
import { buildCtx } from '../knowledge/common.js';
import {
  asQueryValue,
  attributionCred,
  readBody,
  respondProxy,
  spaceIdOf,
} from './common.js';

/**
 * `144 · C3`：按资产 `asset/get` 富化 `session.assets[]`（**best-effort 只读**）。
 *
 * - 单资产失败 / 缺值 ⇒ `meta = null`（前端渲染"未知"）；**任何异常都不得影响回执主体**；
 * - ⚠️ 内核 `status` 是**生命周期**状态，**不是**验证状态 ⇒ **不透传**（验证状态见回执页：
 *   `143` 未落地前固定"待验证（未定义验证器）"——不得拿 `status` 冒充）。
 */
async function enrichAssetMeta(deps: PanelDeps, c: Context, env: ProxyEnvelope<unknown>): Promise<void> {
  try {
    if (env.code !== 0 || env.data === null || typeof env.data !== 'object') return;
    const data = env.data as { session?: { assets?: unknown } };
    const assets = data.session?.assets;
    if (!Array.isArray(assets) || assets.length === 0) return;
    const ctx = buildCtx(c);
    await Promise.all(
      assets.map(async (a) => {
        if (a === null || typeof a !== 'object') return;
        const item = a as Record<string, unknown>;
        const assetId = typeof item.asset_id === 'string' ? item.asset_id : '';
        if (!assetId) return;
        let meta: Record<string, unknown> | null = null;
        try {
          const getEnv = await deps.metaKernel.invoke('asset/get', { asset_id: assetId }, ctx);
          if (getEnv.code === 0 && getEnv.data !== null && typeof getEnv.data === 'object') {
            const raw = getEnv.data as { name?: unknown; asset_type?: unknown; updated_at?: unknown };
            const parsed = typeof raw.updated_at === 'string' ? Date.parse(raw.updated_at) : NaN;
            meta = {
              name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : null,
              asset_type: typeof raw.asset_type === 'string' && raw.asset_type.length > 0 ? raw.asset_type : null,
              updated_at_ms: Number.isFinite(parsed) ? parsed : null,
            };
          }
        } catch {
          meta = null; // 单资产失败 ⇒ 未知（不抛、不阻塞）
        }
        item.meta = meta;
      }),
    );
  } catch {
    /* 富化是 best-effort：失败 ⇒ 无 meta（前端按"未知"渲染），回执主体不受影响 */
  }
}

export function registerAttributionReceiptRoutes(
  api: Hono,
  deps: PanelDeps,
  auth: MiddlewareHandler,
): void {
  api.post('/attribution/sessions', auth, async (c) => {
    const body = await readBody(c);
    if (!body) return respondControlError(c, 400, 'INVALID_BODY');
    if (body.limit === undefined && body.since === undefined) {
      // 与 proxy 同款纪律：至少给一个（防无界）。
      return respondControlError(c, 400, 'UNBOUNDED_QUERY_REJECTED');
    }
    const env = await deps.attributionProxy.getEnvelope(
      '/v3/admin/attribution/sessions',
      {
        since: asQueryValue(body.since),
        limit: asQueryValue(body.limit),
        // 115：space 兜底（显式优先；缺省 ⇒ 登录实例 `panelMeta.instanceId`）——不再依赖前端传参。
        space_id: spaceIdOf(c, body.space_id),
      },
      attributionCred(deps),
    );
    return respondProxy(c, env);
  });

  api.post('/attribution/receipt', auth, async (c) => {
    const body = await readBody(c);
    if (!body) return respondControlError(c, 400, 'INVALID_BODY');
    const sessionKey = typeof body.session_key === 'string' ? body.session_key.trim() : '';
    if (!sessionKey) return respondControlError(c, 400, 'MISSING_SESSION_KEY');
    const env = await deps.attributionProxy.getEnvelope(
      `/v3/admin/attribution/sessions/${encodeURIComponent(sessionKey)}`,
      {
        limit: asQueryValue(body.limit),
        offset: asQueryValue(body.offset),
      },
      attributionCred(deps),
    );
    await enrichAssetMeta(deps, c, env); // 144 · C3：只读富化（失败 ⇒ meta=null，不影响主体）
    return respondProxy(c, env);
  });
}
