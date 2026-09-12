/**
 * 76 · S7-c 测试装置：最小 `PanelDeps` stub（只满足归因 BFF 路由所需字段）。
 *
 * 设计：测试**不走 buildPanelApp 全装配**（避免拉起全部域路由的依赖），直接
 * `new Hono()` + `registerAttributionRoutes(app, deps)`——聚焦 BFF 路由层；
 * `app.ts` 的注册行为由静态断言（nav.test）与代码评审覆盖。
 */
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import type {
  AttributionProxyCredentials,
  AttributionProxyPort,
  ProxyEnvelope,
} from '../../src/panel/kernel/ports/attribution-proxy-port.js';

export interface ProxyCall {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  cred: AttributionProxyCredentials;
}

export interface FakeProxy {
  port: AttributionProxyPort;
  calls: ProxyCall[];
  /** 逐次响应队列（缺省 ⇒ 全 0 空数据）。 */
  queue: Array<ProxyEnvelope<unknown> | ((call: ProxyCall) => ProxyEnvelope<unknown>)>;
}

export function makeFakeProxy(): FakeProxy {
  const calls: ProxyCall[] = [];
  const queue: FakeProxy['queue'] = [];
  const next = (call: ProxyCall): ProxyEnvelope<unknown> => {
    const item = queue.shift();
    if (!item) return { code: 0, message: 'ok', data: null };
    return typeof item === 'function' ? item(call) : item;
  };
  const port: AttributionProxyPort = {
    async getEnvelope(path, query, cred) {
      const call: ProxyCall = { method: 'GET', path, query, cred };
      calls.push(call);
      return next(call);
    },
    async postEnvelope(path, body, cred) {
      const call: ProxyCall = { method: 'POST', path, body, cred };
      calls.push(call);
      return next(call);
    },
  };
  return { port, calls, queue };
}

export interface MakeDepsOptions {
  proxy: AttributionProxyPort;
  /** 供断言"key 不在响应里"等场景。 */
  adminKey?: string;
  /** instanceRegistry.resolve 会拒绝的 id（缺省接受任意非空 id）。 */
  rejectInstance?: string;
  /** resolveSession 返回（缺省 null）。 */
  sessionUserKey?: string;
}

export function makeDeps(opts: MakeDepsOptions): PanelDeps {
  const stub = {
    config: {
      server: { host: '127.0.0.1', port: 0 },
      metadataInstancesConfig: '',
      metadataRemoteTimeoutMs: 1000,
      ui: { distDir: '/tmp/does-not-exist' },
      log: { level: 'error', format: 'pretty' },
      knowledge: { baseUrl: '', authToken: '', timeoutMs: 1 },
      knowledgeLlmBinding: { sync: false, proxyBaseUrl: '' },
      attribution: {
        proxyBaseUrl: 'http://proxy.test:8096',
        proxyAdminKey: opts.adminKey ?? 'admin-secret-76',
        timeoutMs: 1000,
      },
      agentTemplateDir: '/tmp',
      featureAnalyticsEnabled: false,
      clickhouse: {},
      auth: { sessionCookieName: 'tdai_session' },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this as never; } },
    instanceRegistry: {
      resolve(id: string) {
        if (opts.rejectInstance && id === opts.rejectInstance) {
          throw new Error('INVALID_INSTANCE');
        }
        return { instance_id: id, gateway_endpoint: 'http://kernel.test', api_key: 'gateway-key' };
      },
    },
    auth: {
      resolveSession() {
        return opts.sessionUserKey ? { userKey: opts.sessionUserKey, coreUserId: 'u-core' } : null;
      },
      listHeaderInjectedProviders() {
        return [];
      },
    },
    apiCallTelemetry: { record() {} },
    userIdResolver: { resolve() { return undefined; } },
    kernelHttp: {},
    metaKernel: {},
    skillKernel: {},
    analyticsKernel: {},
    attributionProxy: opts.proxy,
    knowledgeClientFactory: () => ({}),
    knowledgeTaskRegistry: {},
    ingestProgressStore: {},
  };
  return stub as unknown as PanelDeps;
}

/** 便捷请求：POST JSON + 三头。 */
export function postJson(
  app: { request: (input: string, init?: RequestInit) => Promise<Response> },
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': 'inst-1',
      'x-tdai-user-key': 'user-42',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
