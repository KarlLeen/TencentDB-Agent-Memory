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

/**
 * 115 · space 兜底（**面板既有约定**，与其余 12 个接口一致）：归因面 BFF **不依赖前端传参**。
 *
 * 显式非空 `space_id` 优先；缺省/空 ⇒ 用**登录实例**（`X-Tdai-Service-Id` ⇒ `panelMeta.instanceId`，
 * 同 `skill-api.ts:361-364` 的逐字约定："`space_id`：**前端不传**……从 `X-Tdai-Service-Id`
 * header (= panelSession.instanceId) 走"）。
 *
 * 背景（`111` 实测）：BFF 纯透传时，前端按通用约定不传 ⇒ 上游 `space_id` 缺席 ⇒ proxy 池
 * 落缺省 `_default` ⇒ **真库上恒空**（真库无一行 `_default`）。
 */
export function spaceIdOf(c: Context, explicit: unknown): string | undefined {
  const v = asQueryValue(explicit);
  if (v !== undefined && v !== '') return String(v);
  return c.get('panelMeta')?.instanceId;
}
