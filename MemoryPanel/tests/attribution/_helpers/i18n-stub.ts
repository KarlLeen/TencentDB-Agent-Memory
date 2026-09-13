/**
 * 126 · 纯函数层 `t` 桩（D1 (i) 的配套）——从**真资源**取值 + 最小 `{{var}}` 插值。
 *
 * 为什么从真资源取：view-model 的契约断言（"检测时快照"、溢出原文、轮 Label）要钉在
 * **真实文案**上，而不是再造一份假词表（那会变成第二份理解）。纯 node 可用（零 DOM）。
 */
import { enUS } from '@/i18n/en-US';
import { zhCN } from '@/i18n/zh-CN';
import type { TranslateFn } from '@/pages/AttributionReceiptPage/utils/view-model';

const interp = (s: string, o?: Record<string, string | number>): string =>
  s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(o?.[k] ?? ''));

function makeT(res: Record<string, unknown>): TranslateFn {
  return (key, opts) => {
    const v = res[key];
    return interp(typeof v === 'string' ? v : key, opts);
  };
}

export const tZh = makeT(zhCN as unknown as Record<string, unknown>);
export const tEn = makeT(enUS as unknown as Record<string, unknown>);
