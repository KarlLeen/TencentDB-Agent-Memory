/**
 * 76 · S7-c 归因 BFF 路由聚合。
 *
 * 挂载（RPC，全 POST；三头鉴权照 F6 惯例）：
 *   - /api/v1/attribution/sessions  （会话概览）
 *   - /api/v1/attribution/receipt   （回执 DTO）
 *   - /api/v1/attribution/pool      （抽查/分歧池）
 *   - /api/v1/attribution/review    （状态写口；actor 服务端注入）
 */
import type { Hono } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { registerAttributionReceiptRoutes } from './receipt-routes.js';
import { registerAttributionPoolRoutes } from './pool-routes.js';

export function registerAttributionRoutes(api: Hono, deps: PanelDeps): void {
  // 三头校验中间件（含"缺 user key ⇒ 400 MISSING_USER_KEY"——非 /meta/ 路径 action 为空
  // ⇒ 不 omitUserKey ⇒ 匿名调用被拦在路由前）。
  const auth = validatePanelMetaHeaders(deps);
  registerAttributionReceiptRoutes(api, deps, auth);
  registerAttributionPoolRoutes(api, deps, auth);
}
