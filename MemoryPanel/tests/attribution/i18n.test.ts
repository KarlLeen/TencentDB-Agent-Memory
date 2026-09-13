/**
 * 76 · S7-c：i18n 键齐全性（T9）——中英键集合必须**完全对等**；本单新增键逐条点名。
 */
import { describe, expect, it } from 'vitest';

import { enUS } from '@/i18n/en-US';
import { zhCN } from '@/i18n/zh-CN';

const NEW_KEYS = [
  'menu.attribution_receipt',
  'menu.audit_pool',
  'menu.desc.attribution_receipt',
  'menu.desc.audit_pool',
  'attribution.refresh',
  'attribution.receipt.title',
  'attribution.receipt.subtitle',
  'attribution.receipt.selectSession',
  'attribution.receipt.units',
  'attribution.receipt.judged',
  'attribution.receipt.turn',
  'attribution.receipt.markers',
  'attribution.receipt.events',
  'attribution.receipt.assets',
  'attribution.receipt.truncated',
  'attribution.pool.title',
  'attribution.pool.subtitle',
  'attribution.pool.category',
  'attribution.pool.allCategories',
  'attribution.pool.unit',
  'attribution.pool.categories',
  'attribution.pool.verdict',
  'attribution.pool.reviewTitle',
  'attribution.pool.target',
  'attribution.pool.note',
  'attribution.pool.submit',
  'attribution.pool.submitOk',
  'attribution.pool.noUserKey',
  'attribution.pool.stateLocalHint',
  'attribution.pool.reviewFilter',
  'attribution.pool.allStatuses',
  'attribution.pool.stale',
  'attribution.marker.unexecuted',
  'attribution.empty.noData',
  'attribution.empty.notConfigured',
  'attribution.empty.unreachable',
  'attribution.error.ATTRIBUTION_PROXY_NOT_CONFIGURED',
  'attribution.error.ATTRIBUTION_PROXY_UNAUTHORIZED',
  'attribution.error.ATTRIBUTION_PROXY_UNREACHABLE',
  'attribution.error.ATTRIBUTION_PROXY_UNAVAILABLE',
  'attribution.error.ATTRIBUTION_PROXY_BAD_REQUEST',
  'attribution.error.ATTRIBUTION_PROXY_NOT_FOUND',
  'attribution.error.ATTRIBUTION_PROXY_PROTOCOL_ERROR',
  'attribution.error.ATTRIBUTION_UNKNOWN_ERROR',
] as const;

describe('76 · T9 i18n：中英键对等 + 本单新键齐全', () => {
  // 131 · C2：两侧键集合相等（全命名空间）由 tests/attribution/i18n-guards.test.ts 统一守卫
  // —— 单一出处；本文件不再各自断言同一事实（130 方向）。

  it('本单新增键两侧均存在且非空', () => {
    const missingZh = NEW_KEYS.filter((k) => !(k in zhCN) || String((zhCN as Record<string, string>)[k] ?? '').trim() === '');
    const missingEn = NEW_KEYS.filter((k) => !(k in enUS) || String((enUS as Record<string, string>)[k] ?? '').trim() === '');
    console.log(`T9b → 新键 ${NEW_KEYS.length}；zh 缺=${JSON.stringify(missingZh)}；en 缺=${JSON.stringify(missingEn)}`);
    expect(missingZh).toEqual([]);
    expect(missingEn).toEqual([]);
  });
});
