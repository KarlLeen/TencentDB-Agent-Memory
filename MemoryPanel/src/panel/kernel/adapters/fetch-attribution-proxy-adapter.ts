/**
 * 76 · S7-c：fetch 实现的 `AttributionProxyPort`（→ context-proxy `/v3/admin/attribution/*`）。
 *
 * 安全约束（硬）：
 *   - `adminKey` 只出现在**请求头**里；**绝不**进日志、进响应、进错误文案（本文件不打 headers）；
 *   - proxy 原始 `message`（可能带细节）**不进入面板响应**（转成**面板稳定错误码** + 服务端日志）；
 *   - fail-closed：key 缺失 ⇒ `503 ATTRIBUTION_PROXY_NOT_CONFIGURED`（不是 200 空列表）。
 */
import type { Logger } from '../../infra/logger.js';
import {
  ATTRIBUTION_PROXY_ERRORS,
  type AttributionProxyCredentials,
  type AttributionProxyPort,
  type ProxyEnvelope,
} from '../ports/attribution-proxy-port.js';

function fail<T>(code: number, message: string): ProxyEnvelope<T> {
  return { code, message, data: null };
}

export class FetchAttributionProxyAdapter implements AttributionProxyPort {
  constructor(private readonly logger?: Logger) {}

  getEnvelope<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    cred: AttributionProxyCredentials,
  ): Promise<ProxyEnvelope<T>> {
    return this.invoke<T>('GET', path, query, undefined, cred);
  }

  postEnvelope<T>(
    path: string,
    body: unknown,
    cred: AttributionProxyCredentials,
  ): Promise<ProxyEnvelope<T>> {
    return this.invoke<T>('POST', path, {}, body, cred);
  }

  private async invoke<T>(
    method: 'GET' | 'POST',
    path: string,
    query: Record<string, string | number | undefined>,
    body: unknown,
    cred: AttributionProxyCredentials,
  ): Promise<ProxyEnvelope<T>> {
    // fail-closed：未配置 key ⇒ 明确错误（**不是**空数据）。
    if (!cred.adminKey) {
      this.logger?.warn('attribution proxy admin key not configured', { path });
      return fail<T>(503, ATTRIBUTION_PROXY_ERRORS.notConfigured);
    }

    let url: URL;
    try {
      url = new URL(path, cred.baseUrl);
    } catch {
      return fail<T>(503, ATTRIBUTION_PROXY_ERRORS.notConfigured);
    }
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, cred.timeoutMs));
    try {
      const res = await fetch(url, {
        method,
        headers: {
          // ⚠️ admin key 仅此一处出现（请求头）；任何日志/错误都不带它。
          authorization: `Bearer ${cred.adminKey}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      const env =
        parsed !== null && typeof parsed === 'object'
          ? (parsed as { code?: unknown; message?: unknown; data?: unknown })
          : null;

      if (res.status === 401 || env?.code === 401) {
        this.logger?.warn('attribution proxy rejected admin key (401)', { path });
        return fail<T>(401, ATTRIBUTION_PROXY_ERRORS.unauthorized);
      }
      if (!env || typeof env.code !== 'number') {
        this.logger?.warn('attribution proxy returned non-envelope response', { path, status: res.status });
        return fail<T>(502, ATTRIBUTION_PROXY_ERRORS.protocolError);
      }
      if (env.code === 0) {
        return { code: 0, message: 'ok', data: (env.data ?? null) as T | null };
      }
      // 业务错误：原始 message **只进日志**，响应给稳定码；**结构化 data 透传**
      // （77 · S7-d：如 400 的 `current_status`——"原因"必须是可机读字段，不是藏在文本里）。
      this.logger?.warn('attribution proxy business error', {
        path,
        code: env.code,
        proxyMessage: typeof env.message === 'string' ? env.message : '',
      });
      return {
        code: mapBusinessCode(env.code),
        message: mapBusinessError(env.code),
        data: (env.data ?? null) as T | null,
      };
    } catch (err) {
      // 网络错 / 超时 / abort：明确"上游不可达"（空态三因之一，不与"无数据"混同）。
      this.logger?.warn('attribution proxy unreachable', {
        path,
        err: err instanceof Error ? err.message : String(err),
      });
      return fail<T>(502, ATTRIBUTION_PROXY_ERRORS.unreachable);
    } finally {
      clearTimeout(timer);
    }
  }
}

function mapBusinessCode(code: number): number {
  if (code === 400) return 400;
  if (code === 404) return 404;
  if (code === 503) return 503;
  return 502;
}

function mapBusinessError(code: number): string {
  if (code === 400) return ATTRIBUTION_PROXY_ERRORS.badRequest;
  if (code === 404) return ATTRIBUTION_PROXY_ERRORS.notFound;
  if (code === 503) return ATTRIBUTION_PROXY_ERRORS.unavailable;
  return ATTRIBUTION_PROXY_ERRORS.protocolError;
}
