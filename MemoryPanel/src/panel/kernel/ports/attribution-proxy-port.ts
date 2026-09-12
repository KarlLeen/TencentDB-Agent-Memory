/**
 * 76 · S7-c：context-proxy 归因 admin 面（只读 + 状态写口）访问端口。
 *
 * 语义边界（**独立于内核凭证**）：
 *   - 本端口的凭证 = **服务端静态 admin key**（`ATTRIBUTION_PROXY_ADMIN_KEY`）；
 *   - **不用** `toKernelCredentials`（那是内核 instance+api_key+user_key 语义）；
 *   - **不复用** `knowledgeLlmBinding.proxyBaseUrl`（那块是"知识库 LLM 记账"）。
 *
 * fail-closed：`adminKey` 缺失 ⇒ 返回 `503 / ATTRIBUTION_PROXY_NOT_CONFIGURED`
 * （**不是** 200 空列表——不许把"未配置"渲染成"无数据"）。
 */
export interface AttributionProxyCredentials {
  baseUrl: string;
  /** ⚠️ 只在服务端流转：不下发浏览器、不进日志/错误文案。 */
  adminKey: string;
  timeoutMs: number;
}

/** proxy 侧信封（S7-a/b 的 `{code, message, data}`）；面板路由层再补 `request_id`。 */
export interface ProxyEnvelope<T> {
  code: number;
  message: string;
  data: T | null;
}

/** 面板侧稳定错误码（前端按此分支；不泄漏 proxy 原始 message/栈）。 */
export const ATTRIBUTION_PROXY_ERRORS = {
  notConfigured: 'ATTRIBUTION_PROXY_NOT_CONFIGURED',
  unauthorized: 'ATTRIBUTION_PROXY_UNAUTHORIZED',
  badRequest: 'ATTRIBUTION_PROXY_BAD_REQUEST',
  notFound: 'ATTRIBUTION_PROXY_NOT_FOUND',
  unavailable: 'ATTRIBUTION_PROXY_UNAVAILABLE',
  unreachable: 'ATTRIBUTION_PROXY_UNREACHABLE',
  protocolError: 'ATTRIBUTION_PROXY_PROTOCOL_ERROR',
} as const;

export interface AttributionProxyPort {
  /** GET proxy 路径（query 逐项拼接；`undefined` 项省略）。 */
  getEnvelope<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    cred: AttributionProxyCredentials,
  ): Promise<ProxyEnvelope<T>>;
  /** POST proxy 路径（JSON body）。 */
  postEnvelope<T>(
    path: string,
    body: unknown,
    cred: AttributionProxyCredentials,
  ): Promise<ProxyEnvelope<T>>;
}
