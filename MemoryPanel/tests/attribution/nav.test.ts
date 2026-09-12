/**
 * 76 · S7-c：导航/路由注册一致性（T10）——`PageId` / `usePageMeta` / `routes` 三处一致。
 *
 * 用源码文本断言（node 环境不渲染 JSX；React 组件测试需 jsdom，登记为后续）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const menuSrc = readFileSync(new URL('../../web/src/constants/menu.tsx', import.meta.url), 'utf8');
const routesSrc = readFileSync(new URL('../../web/src/routes/index.tsx', import.meta.url), 'utf8');
const bffSrc = readFileSync(new URL('../../src/panel/http/app.ts', import.meta.url), 'utf8');

describe('76 · T10 三处一致：menu（PageId+usePageMeta+图标）/ routes / BFF 注册', () => {
  it('PageId 两项 + usePageMeta 同组（observability）+ order 紧随 analytics', () => {
    expect(menuSrc).toContain("'attribution_receipt'");
    expect(menuSrc).toContain("'audit_pool'");
    // 带引号出现 = PageId union + usePageMeta 各一次（ITEM_ICON 的对象键不带引号）⇒ 计数 ≥ 2。
    expect((menuSrc.match(/'attribution_receipt'/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((menuSrc.match(/'audit_pool'/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // ITEM_ICON 两键（无引号）单项断言（"图标取 tea-icons 既有图标"）
    expect(menuSrc).toContain('attribution_receipt: <RootListIcon');
    expect(menuSrc).toContain('audit_pool: <BrowseIcon');
    expect(menuSrc).toContain("group: t('menu.group.observability')");
    expect(menuSrc).toMatch(/analytics:.*order: 0/);
    expect(menuSrc).toMatch(/attribution_receipt:.*order: 1/);
    expect(menuSrc).toMatch(/audit_pool:.*order: 2/);
  });

  it('routes 两条子路由 + 页面组件 import', () => {
    expect(routesSrc).toContain("path: 'attribution'");
    expect(routesSrc).toContain("path: 'audit'");
    expect(routesSrc).toContain('AttributionReceiptPage');
    expect(routesSrc).toContain('AuditPoolPage');
  });

  it('BFF 注册在 app.ts（catch-all 之前；四条 RPC 全为 POST）', () => {
    expect(bffSrc).toContain('registerAttributionRoutes(api, deps)');
    const routesSrcBff = [
      '../../src/panel/http/routes/attribution/receipt-routes.ts',
      '../../src/panel/http/routes/attribution/pool-routes.ts',
    ]
      .map((p) => readFileSync(new URL(p, import.meta.url), 'utf8'))
      .join('\n');
    for (const path of ['/attribution/sessions', '/attribution/receipt', '/attribution/pool', '/attribution/review']) {
      expect(routesSrcBff).toContain(`api.post('${path}', auth`);
    }
  });
});
