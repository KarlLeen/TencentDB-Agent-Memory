/**
 * 126 · C3①/C4 机械守卫（纯 node；零 jsdom）。
 *
 * - **C3① 源级**：`AttributionReceiptPage` / `AttributionPoolPage` 两页目录内**非注释行**不得含
 *   CJK 字面量（注释里可保留中文；JSX `{/* … *\/}` 视作注释）。
 * - **C4 key 对齐**：`attribution.*` 的 zh/en key **集合相等**（防"只加一边"）。
 *
 * 渲染级双向守卫（zh 无英文词表 / en 无 CJK）在 `receipt-page.test.tsx` / `pool-page.test.tsx`
 * （需要 jsdom + 组件，照 120 · C3-en 格风格；词表按页分置 —— 回执页用 `_helpers/labels.ts`
 * 导出的 `EN_UI_WORDS`，池页用页内 `POOL_WORDS`（两表不相交）；本文件不导出词表）。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { enUS } from '@/i18n/en-US';
import { zhCN } from '@/i18n/zh-CN';

const PAGES = [
  'web/src/pages/AttributionReceiptPage/index.tsx',
  'web/src/pages/AttributionReceiptPage/utils/view-model.ts',
  'web/src/pages/AuditPoolPage/index.tsx',
];

/** 剥掉块注释（含 JSX `{/* … *\/}`）与 `//` 行注释（**含行内** —— 两页注释习惯写行内中文）。 */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => {
      const i = l.indexOf('//');
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join('\n');

const CJK = /[\u4e00-\u9fff]/;

describe('126 · C3① 源级：两页目录非注释行不得含 CJK', () => {
  for (const rel of PAGES) {
    it(`${rel} —— 无 CJK 字面量`, () => {
      const src = readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
      const stripped = stripComments(src);
      const lineNo = stripped.split('\n').findIndex((l) => CJK.test(l));
      const offending = lineNo >= 0 ? stripped.split('\n')[lineNo]!.trim().slice(0, 80) : null;
      expect(CJK.test(stripped), `首个 CJK 命中：${offending}`).toBe(false);
    });
  }
});

describe('126 · C4 key 对齐：attribution.* 的 zh/en key 集合相等', () => {
  const attKeys = (res: Record<string, unknown>): string[] =>
    Object.keys(res)
      .filter((k) => k.startsWith('attribution.'))
      .sort();

  it('集合相等（只加一边 ⇒ 红）', () => {
    const zh = attKeys(zhCN as unknown as Record<string, unknown>);
    const en = attKeys(enUS as unknown as Record<string, unknown>);
    const onlyZh = zh.filter((k) => !en.includes(k));
    const onlyEn = en.filter((k) => !zh.includes(k));
    expect({ onlyZh, onlyEn }).toEqual({ onlyZh: [], onlyEn: [] });
    expect(zh.length).toBeGreaterThan(40); // 现状面（41+13 新增≥54）——防"两边同时清空"式假绿
  });
});
