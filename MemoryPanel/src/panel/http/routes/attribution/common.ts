/**
 * 76 · S7-c 归因 BFF：公共助手（凭证构造 / 信封映射 / body 读取）。
 *
 * 三条纪律：
 *   - 凭证从 `config.attribution` 构造（**独立于内核凭证**，不复用 knowledgeLlmBinding）；
 *   - proxy 信封 → 面板信封（补 `request_id`；**不改码、不回显 proxy 原始 message**——
 *     原始 message 的日志落在 adapter 内）；
 *   - body 读取失败 ⇒ 调用方回 400（不猜、不默认空体）。
 */
import type { Context } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';
import { respondEnvelope } from '../../envelope.js';
import type {
  AttributionProxyCredentials,
  ProxyEnvelope,
} from '../../../kernel/ports/attribution-proxy-port.js';

export function attributionCred(deps: PanelDeps): AttributionProxyCredentials {
  return {
    baseUrl: deps.config.attribution.proxyBaseUrl,
    adminKey: deps.config.attribution.proxyAdminKey,
    timeoutMs: deps.config.attribution.timeoutMs,
  };
}

export function respondProxy(c: Context, env: ProxyEnvelope<unknown>) {
  return respondEnvelope(c, {
    code: env.code,
    message: env.code === 0 ? 'ok' : env.message,
    request_id: c.get('reqId') ?? '',
    data: env.data,
  });
}

export async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const raw = (await c.req.json()) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 只接受 string | number 的查询参数（其余 ⇒ undefined ⇒ 交给 proxy 校验）。 */
export function asQueryValue(v: unknown): string | number | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}
