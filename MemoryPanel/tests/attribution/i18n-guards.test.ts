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


describe('131 · C2 全命名空间 key 集合相等（126·C4 的同型升级）', () => {
  it('差集两侧都为空 + 下限断言（防两边同时清空式假绿）', () => {
    const zh = Object.keys(zhCN as unknown as Record<string, unknown>);
    const en = Object.keys(enUS as unknown as Record<string, unknown>);
    // 131 · C2 / #15：集合相等挡不住"两侧同时删同一个键"（差集仍空）⇒ 用"贴实测的下限"把"双边同删"变成红。
    // 下限 = 2026-09-13 实测值（现取后必须等于此表；不等 ⇒ 停下报告，不许自行改数）。
    const FLOORS: Array<[string, number]> = [
      ['', 1547], // 全命名空间总量
      ['attribution.', 52],
      ['memory.detail.', 36],
      ['memory.notify.', 18],
      ['memory.', 97],
    ];
    for (const [prefix, min] of FLOORS) {
      const label = prefix === '' ? '全命名空间' : `${prefix} 族`;
      expect(zh.filter((k) => k.startsWith(prefix)).length, `${label} 下限`).toBeGreaterThanOrEqual(min);
      expect(en.filter((k) => k.startsWith(prefix)).length, `${label} 下限（en）`).toBeGreaterThanOrEqual(min);
    }
    const onlyZh = zh.filter((k) => !en.includes(k));
    const onlyEn = en.filter((k) => !zh.includes(k));
    expect({ onlyZh, onlyEn }).toEqual({ onlyZh: [], onlyEn: [] });
  });
});

describe('144 · C1 映射表单一落点（源级；R3 钉）', () => {
  const TECH_CLASSES = ['skill', 'code_graph', 'llm_wiki', 'chat_memory'] as const;

  it('技术类→语义类映射只在 semantic-type.ts；页面其余文件不得再写一份', () => {
    const read = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
    const mapBody = stripComments(read('web/src/pages/AttributionReceiptPage/utils/semantic-type.ts'));
    for (const tech of TECH_CLASSES) {
      expect(mapBody.includes(`${tech}:`), `映射表（唯一落点）应含 ${tech}`).toBe(true);
    }
    // 第二份表的指纹 = 页面其余文件里出现**技术类名**（映射关系的输入侧）⇒ 红。
    for (const rel of [
      'web/src/pages/AttributionReceiptPage/utils/view-model.ts',
      'web/src/pages/AttributionReceiptPage/index.tsx',
    ]) {
      const body = stripComments(read(rel));
      const hits = TECH_CLASSES.filter((t) => body.includes(t));
      expect(hits, `${rel} 不得出现第二份映射表（命中：${hits.join(',')}）`).toEqual([]);
    }
  });
});

describe('131 · C3 补键占位符一致（同名同数；运行时字符串）', () => {
  const KEYS_131 = [
    'memory.detail.cancel',
    'memory.detail.save',
    'memory.detail.editTitle',
    'memory.detail.modeBrowse',
    'memory.detail.modeSearch',
    'memory.detail.search',
    'memory.detail.clearSearch',
    'memory.detail.searchEmpty',
    'memory.detail.searchPlaceholderL0',
    'memory.detail.searchPlaceholderL1',
    'memory.detail.searchPrompt',
    'memory.detail.searchResultCount',
    'memory.detail.searchScore',
    'memory.notify.editSuccess',
    'memory.notify.editFailed',
    'memory.notify.searchFailed',
  ] as const;

  it('每个键的 {{var}} 集合两侧相等（不少也不多）', () => {
    const holders = (v: unknown): string[] => (String(v).match(/\{\{(\w+)\}\}/g) ?? []).sort();
    const zh = zhCN as unknown as Record<string, unknown>;
    const en = enUS as unknown as Record<string, unknown>;
    for (const k of KEYS_131) {
      expect(typeof zh[k], `${k}: zh 侧应存在`).toBe('string');
      expect(typeof en[k], `${k}: en 侧应存在`).toBe('string');
      expect(holders(en[k]), `${k}: 占位符集合须与 zh 一致`).toEqual(holders(zh[k]));
    }
  });
});
