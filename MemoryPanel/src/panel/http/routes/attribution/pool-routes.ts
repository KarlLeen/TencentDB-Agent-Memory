/**
 * 76 · S7-c 归因 BFF：池页两端点。
 *
 *   POST /api/v1/attribution/pool    → proxy GET  /v3/admin/attribution/audit-pool
 *   POST /api/v1/attribution/review  → proxy POST /v3/admin/attribution/audit-reviews
 *
 * ⚠️ `actor` **由服务端从 `x-tdai-user-key` 注入**（`panelMeta.userKey`）——body 里的
 * 任何 `actor` 字段**一律忽略**（否则审计身份可伪造）；用户 key 缺失 ⇒ 400（不匿名）。
 * `prev_status` / 迁移合法性由 proxy 侧兜底 400（前端也按迁移表阻断）。
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

export function registerAttributionPoolRoutes(
  api: Hono,
  deps: PanelDeps,
  auth: MiddlewareHandler,
): void {
  api.post('/attribution/pool', auth, async (c) => {
    const body = await readBody(c);
    if (!body) return respondControlError(c, 400, 'INVALID_BODY');
    const env = await deps.attributionProxy.getEnvelope(
      '/v3/admin/attribution/audit-pool',
      {
        category: asQueryValue(body.category),
        space_id: asQueryValue(body.space_id),
        limit: asQueryValue(body.limit),
        offset: asQueryValue(body.offset),
      },
      attributionCred(deps),
    );
    return respondProxy(c, env);
  });

  api.post('/attribution/review', auth, async (c) => {
    const body = await readBody(c);
    if (!body) return respondControlError(c, 400, 'INVALID_BODY');
    const userKey = c.get('panelMeta')?.userKey;
    if (!userKey) {
      // 双保险（validatePanelMetaHeaders 已拦）；**不匿名**。
      return respondControlError(c, 400, 'MISSING_USER_KEY');
    }
    // 显式重建 payload：**body.actor 不参与**（服务端注入 = 会话用户）。
    const payload = {
      audit_key: body.audit_key,
      prev_status: body.prev_status,
      status: body.status,
      note: body.note,
      actor: userKey,
    };
    const env = await deps.attributionProxy.postEnvelope(
      '/v3/admin/attribution/audit-reviews',
      payload,
      attributionCred(deps),
    );
    return respondProxy(c, env);
  });
}
