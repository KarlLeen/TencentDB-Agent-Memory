/**
 * 76 · S7-c：归因 BFF 四端点测试（T1–T5 + 空态三因；fake 适配器，不打真网络）。
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { registerAttributionRoutes } from '../../src/panel/http/routes/attribution/index.js';
import { makeDeps, makeFakeProxy, postJson, type FakeProxy } from '../helpers/make-deps.js';

function makeApp(opts: { adminKey?: string } = {}): { app: Hono; fake: FakeProxy } {
  const fake = makeFakeProxy();
  const deps = makeDeps({ proxy: fake.port, ...opts });
  const app = new Hono();
  registerAttributionRoutes(app, deps);
  return { app, fake };
}

interface Envelope<T = unknown> {
  code: number;
  message: string;
  request_id: string;
  data: T | null;
}

describe('76 · T1 BFF 四端点：请求/响应形状逐字段（fake 适配器）', () => {
  it('sessions / receipt / pool / review 四格：路径·query·body·信封', async () => {
    const { app, fake } = makeApp();
    fake.queue.push({ code: 0, message: 'ok', data: { sessions: [{ session_key: 's1' }], truncated: false } });
    const r1 = await postJson(app, '/attribution/sessions', { limit: 10 });
    const e1 = (await r1.json()) as Envelope<{ sessions: unknown[]; truncated: boolean }>;
    console.log(`T1 → sessions: ${JSON.stringify({ status: r1.status, code: e1.code, call: fake.calls[0] })}`);
    expect(r1.status).toBe(200);
    expect(e1.code).toBe(0);
    expect(e1.message).toBe('ok');
    expect(typeof e1.request_id).toBe('string');
    expect(e1.data).toEqual({ sessions: [{ session_key: 's1' }], truncated: false });
    expect(fake.calls[0]).toMatchObject({
      method: 'GET',
      path: '/v3/admin/attribution/sessions',
      query: { limit: 10 },
      cred: { baseUrl: 'http://proxy.test:8096', adminKey: 'admin-secret-76', timeoutMs: 1000 },
    });

    fake.queue.push({ code: 0, message: 'ok', data: { session: { session_key: 's1' }, units: [] } });
    await postJson(app, '/attribution/receipt', { session_key: 's1', limit: 5 });
    expect(fake.calls[1]).toMatchObject({
      method: 'GET',
      path: '/v3/admin/attribution/sessions/s1',
      query: { limit: 5 },
    });

    fake.queue.push({ code: 0, message: 'ok', data: { items: [], counts_by_category: {}, truncated: false } });
    await postJson(app, '/attribution/pool', { category: 'suspect:truncated', limit: 20 });
    expect(fake.calls[2]).toMatchObject({
      method: 'GET',
      path: '/v3/admin/attribution/audit-pool',
      query: { category: 'suspect:truncated', limit: 20 },
    });

    // 77 · S7-d：`review_status` 原样透传（服务端过滤）
    fake.queue.push({ code: 0, message: 'ok', data: { items: [], counts_by_category: {}, truncated: false } });
    await postJson(app, '/attribution/pool', { review_status: 'unreviewed', limit: 20 });
    expect(fake.calls[3]).toMatchObject({
      method: 'GET',
      path: '/v3/admin/attribution/audit-pool',
      query: { review_status: 'unreviewed', limit: 20 },
    });

    fake.queue.push({ code: 0, message: 'ok', data: { review_id: 'ar_x', status: 'confirmed', prev_status: 'unreviewed', kind: 'inserted' } });
    const r4 = await postJson(app, '/attribution/review', {
      audit_key: 'ak_1',
      prev_status: 'unreviewed',
      status: 'confirmed',
      note: 'n',
    });
    const e4 = (await r4.json()) as Envelope;
    expect(fake.calls[4]!.method).toBe('POST');
    expect(fake.calls[4]!.path).toBe('/v3/admin/attribution/audit-reviews');
    expect(fake.calls[4]!.body).toMatchObject({ audit_key: 'ak_1', prev_status: 'unreviewed', status: 'confirmed' });
    expect(e4.code).toBe(0);
  });
});

describe('76 · T2 空态三因：未配置 / 不可达 / 无数据（不许混同）', () => {
  it('fake 侧：三因各自码/文案路径', async () => {
    const { app, fake } = makeApp();
    // 未配置（等价真 adapter 的 fail-closed 形状）
    fake.queue.push({ code: 503, message: 'ATTRIBUTION_PROXY_NOT_CONFIGURED', data: null });
    const r1 = (await (await postJson(app, '/attribution/sessions', { limit: 1 })).json()) as Envelope;
    // 不可达
    fake.queue.push({ code: 502, message: 'ATTRIBUTION_PROXY_UNREACHABLE', data: null });
    const r2 = (await (await postJson(app, '/attribution/sessions', { limit: 1 })).json()) as Envelope;
    // 无数据（成功但空）
    fake.queue.push({ code: 0, message: 'ok', data: { sessions: [], truncated: false } });
    const r3 = (await (await postJson(app, '/attribution/sessions', { limit: 1 })).json()) as Envelope;
    console.log(`T2 → 三因码=${r1.code}/${r1.message} | ${r2.code}/${r2.message} | ${r3.code}（空数据）`);
    expect([r1.code, r1.message]).toEqual([503, 'ATTRIBUTION_PROXY_NOT_CONFIGURED']);
    expect([r2.code, r2.message]).toEqual([502, 'ATTRIBUTION_PROXY_UNREACHABLE']);
    expect(r3.code).toBe(0);
    expect((r3.data as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it('真 adapter 在 BFF 里的 fail-closed（adminKey 空）：503 + 明确码', async () => {
    const { FetchAttributionProxyAdapter } = await import('../../src/panel/kernel/adapters/fetch-attribution-proxy-adapter.js');
    const adapter = new FetchAttributionProxyAdapter();
    const app = new Hono();
    registerAttributionRoutes(app, makeDeps({ proxy: adapter, adminKey: '' }));
    const r = (await (await postJson(app, '/attribution/sessions', { limit: 1 })).json()) as Envelope;
    console.log(`T2b → ${JSON.stringify({ status: r.code, message: r.message })}`);
    expect(r.code).toBe(503);
    expect(r.message).toBe('ATTRIBUTION_PROXY_NOT_CONFIGURED');
    // key 三重约束之一：响应里**不得**出现 key（这里根本没配）
    expect(JSON.stringify(r)).not.toContain('admin-secret');
  });
});

describe('76 · T3 actor 服务端注入 / T4 无 key 400 / T5 无界拒绝', () => {
  it('T3：body 里的 actor 被忽略，透传给 proxy 的 actor = 会话用户', async () => {
    const { app, fake } = makeApp();
    fake.queue.push({ code: 0, message: 'ok', data: { review_id: 'ar_y', status: 'dismissed', prev_status: 'unreviewed', kind: 'inserted' } });
    await postJson(app, '/attribution/review', {
      audit_key: 'ak_2',
      prev_status: 'unreviewed',
      status: 'dismissed',
      actor: 'spoof',
    });
    const forwarded = fake.calls[0]!.body as Record<string, unknown>;
    console.log(`T3 → forwarded.actor=${String(forwarded.actor)}；含 spoof=${JSON.stringify(forwarded).includes('spoof')}`);
    expect(forwarded.actor).toBe('user-42');
    expect(JSON.stringify(forwarded)).not.toContain('spoof');
  });

  it('T4：无 user key（且无 IdP 会话）⇒ 400 MISSING_USER_KEY、零转发（不匿名）', async () => {
    const { app, fake } = makeApp();
    const res = await app.request('/attribution/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'inst-1' },
      body: JSON.stringify({ audit_key: 'ak_3', prev_status: 'unreviewed', status: 'confirmed' }),
    });
    const env = (await res.json()) as Envelope;
    console.log(`T4 → status=${res.status} message=${env.message} 转发数=${fake.calls.length}`);
    expect(res.status).toBe(400);
    expect(env.message).toBe('MISSING_USER_KEY');
    expect(fake.calls.length).toBe(0);
  });

  it('T5：receipt 缺 session_key ⇒ 400；sessions 缺 limit/since ⇒ 400（均零转发）', async () => {
    const { app, fake } = makeApp();
    const r1 = (await (await postJson(app, '/attribution/receipt', {})).json()) as Envelope;
    const r2 = (await (await postJson(app, '/attribution/sessions', {})).json()) as Envelope;
    console.log(`T5 → ${r1.message} / ${r2.message}；转发数=${fake.calls.length}`);
    expect([r1.code, r1.message]).toEqual([400, 'MISSING_SESSION_KEY']);
    expect([r2.code, r2.message]).toEqual([400, 'UNBOUNDED_QUERY_REJECTED']);
    expect(fake.calls.length).toBe(0);
  });
});
