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
  /**
   * 既有历史差异（76 实测：en 缺 17 个键——`memory.detail.*` ×14 + `memory.notify.*` ×3，
   * 属 S7 之前的遗留，**本单不修**、只登记为白名单，防"再新增差异"）。
   */
  const KNOWN_ONLY_ZH = new Set([
    'memory.detail.cancel',
    'memory.detail.clearSearch',
    'memory.detail.editTitle',
    'memory.detail.modeBrowse',
    'memory.detail.modeSearch',
    'memory.detail.save',
    'memory.detail.search',
    'memory.detail.searchEmpty',
    'memory.detail.searchPlaceholder',
    'memory.detail.searchPlaceholderL0',
    'memory.detail.searchPlaceholderL1',
    'memory.detail.searchPrompt',
    'memory.detail.searchResultCount',
    'memory.detail.searchScore',
    'memory.notify.editFailed',
    'memory.notify.editSuccess',
    'memory.notify.searchFailed',
  ]);

  it('两字典键差异 ⊆ 已登记白名单（不新增差异；本单新键必两侧齐）', () => {
    const zh = Object.keys(zhCN).sort();
    const en = Object.keys(enUS).sort();
    const onlyZh = zh.filter((k) => !en.includes(k));
    const onlyEn = en.filter((k) => !zh.includes(k));
    const unexplainedZh = onlyZh.filter((k) => !KNOWN_ONLY_ZH.has(k));
    console.log(`T9 → zh=${zh.length} en=${en.length}；未解释差异（zh 独有）=${JSON.stringify(unexplainedZh)}；en 独有=${JSON.stringify(onlyEn)}`);
    expect(unexplainedZh, 'zh 独有键必须 ⊆ 白名单').toEqual([]);
    expect(onlyEn, 'en 独有键不允许（新增键必须两侧同批）').toEqual([]);
  });

  it('本单新增键两侧均存在且非空', () => {
    const missingZh = NEW_KEYS.filter((k) => !(k in zhCN) || String((zhCN as Record<string, string>)[k] ?? '').trim() === '');
    const missingEn = NEW_KEYS.filter((k) => !(k in enUS) || String((enUS as Record<string, string>)[k] ?? '').trim() === '');
    console.log(`T9b → 新键 ${NEW_KEYS.length}；zh 缺=${JSON.stringify(missingZh)}；en 缺=${JSON.stringify(missingEn)}`);
    expect(missingZh).toEqual([]);
    expect(missingEn).toEqual([]);
  });
});
