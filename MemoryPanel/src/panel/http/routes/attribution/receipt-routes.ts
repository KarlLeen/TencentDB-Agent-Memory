/**
 * 76 · S7-c 归因 BFF：回执页两端点（RPC）。
 *
 *   POST /api/v1/attribution/sessions   → proxy GET /v3/admin/attribution/sessions
 *   POST /api/v1/attribution/receipt    → proxy GET /v3/admin/attribution/sessions/{key}
 *
 * 无界拒绝照 S7-a：`sessions` 缺 `limit`/`since` ⇒ 400（拒绝无界全表扫）。
 */
import type { Hono, MiddlewareHandler } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';
import { respondControlError } from '../../envelope.js';
import {
  asQueryValue,
  attributionCred,
  readBody,
  respondProxy,
} from './common.js';

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
        space_id: asQueryValue(body.space_id),
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
    return respondProxy(c, env);
  });
}
