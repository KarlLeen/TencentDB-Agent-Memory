/**
 * 76 · S7-c：`FetchAttributionProxyAdapter` 单测（T2 真适配器半 + 不入日志/响应）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FetchAttributionProxyAdapter } from '../../src/panel/kernel/adapters/fetch-attribution-proxy-adapter.js';

const CRED = { baseUrl: 'http://proxy.test:8096', adminKey: 'admin-secret-76', timeoutMs: 1000 };
const EMPTY_CRED = { ...CRED, adminKey: '' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('76 · adapter：fail-closed 与错误映射', () => {
  it('adminKey 空 ⇒ 503 NOT_CONFIGURED（不碰网络）', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const env = await new FetchAttributionProxyAdapter().getEnvelope('/x', {}, EMPTY_CRED);
    console.log(`A1 → ${JSON.stringify(env)}；fetch 调用=${fetchSpy.mock.calls.length}`);
    expect(env).toEqual({ code: 503, message: 'ATTRIBUTION_PROXY_NOT_CONFIGURED', data: null });
    expect(fetchSpy.mock.calls.length).toBe(0);
  });

  it('proxy 401 ⇒ 401 UNAUTHORIZED（可操作）；响应不含 key', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"code":401,"message":"Unauthorized: invalid token"}', { status: 401 }));
    const env = await new FetchAttributionProxyAdapter().getEnvelope('/x', {}, CRED);
    console.log(`A2 → ${JSON.stringify(env)}`);
    expect(env.code).toBe(401);
    expect(env.message).toBe('ATTRIBUTION_PROXY_UNAUTHORIZED');
    expect(JSON.stringify(env)).not.toContain('admin-secret-76');
  });

  it('网络错/超时 ⇒ 502 UNREACHABLE；业务 400/404 映射稳定码且不回显 proxy 原文', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const env = await new FetchAttributionProxyAdapter().getEnvelope('/x', {}, CRED);
    expect([env.code, env.message]).toEqual([502, 'ATTRIBUTION_PROXY_UNREACHABLE']);

    vi.stubGlobal('fetch', async () => new Response('{"code":400,"message":"invalid limit: \\"abc\\""}', { status: 400 }));
    const env400 = await new FetchAttributionProxyAdapter().getEnvelope('/x', {}, CRED);
    console.log(`A3 → ${JSON.stringify(env400)}`);
    expect([env400.code, env400.message]).toEqual([400, 'ATTRIBUTION_PROXY_BAD_REQUEST']);
    expect(JSON.stringify(env400)).not.toContain('invalid limit');
  });

  it('成功：code 0 原样返回 data；Authorization 头携带 key（仅在请求头）', async () => {
    let seenAuth = '';
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      seenAuth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
      return new Response('{"code":0,"message":"ok","data":{"v":1}}', { status: 200 });
    });
    const env = await new FetchAttributionProxyAdapter().getEnvelope<{ v: number }>('/x', { limit: 3 }, CRED);
    expect(env).toEqual({ code: 0, message: 'ok', data: { v: 1 } });
    expect(seenAuth).toBe('Bearer admin-secret-76');
  });
});
