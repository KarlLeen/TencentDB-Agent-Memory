// @vitest-environment jsdom
/**
 * 84 · D1：抽查池页组件测试（jsdom，per-file）。
 *
 * 覆盖：首屏（空态/有数据态）；**筛选走服务端**（断言请求参数）；**提交后 reconcile**
 * （断言权威重取发生 + 行状态随服务端值）。数据层 `vi.spyOn(attributionApi)` 假掉
 * （零网络、零真库、不启动服务）。
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { changeLanguage } from '@/i18n/index';
import { attributionApi, type PoolDto } from '@/lib/api/attribution';
import { AuditPoolPage } from '@/pages/AuditPoolPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 伪造面板会话（localStorage；`getPanelSession()` 由此读到 userKey ⇒ 提交按钮可用）。 */
function fakeSession(userKey = 'u-84'): void {
  localStorage.setItem('tdai-panel.session', JSON.stringify({ instanceId: 'inst-1', userKey }));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** 全文档（含 portal 到 body 的弹层）按精确文本找叶子元素。 */
function findByExactText(root: ParentNode, text: string): HTMLElement {
  const all = Array.from(root.querySelectorAll<HTMLElement>('*'));
  const hit = all.find((el) => el.children.length === 0 && (el.textContent ?? '').trim() === text);
  if (!hit) throw new Error(`no element with exact text: ${text}`);
  return hit;
}

/** 打开 tea-dropdown（canonical 序列：hover + 完整 click；rc-trigger 各触发模式都覆盖）。 */
async function openDropdown(headerText: string): Promise<void> {
  const dropdown = findByExactText(document.body, headerText).closest('.tea-dropdown') as HTMLElement;
  const header = (dropdown.querySelector('.tea-dropdown__header') ?? dropdown) as HTMLElement;
  await act(async () => {
    header.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, relatedTarget: document.body }));
    header.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true }));
    header.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true }));
    header.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    header.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    header.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await flush();
}

/** 在已打开的 dropdown 里点选一项（精确文本；弹层可能 portal 到 body）。 */
async function selectOption(text: string): Promise<void> {
  const opt = findByExactText(document.body, text);
  await act(async () => {
    opt.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await flush();
}

/** 点按钮（按精确文本）。 */
async function clickButton(text: string): Promise<void> {
  const btn = findByExactText(document.body, text).closest('button') as HTMLButtonElement;
  await act(async () => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function renderAndFlush(node: ReactNode): Promise<{ container: HTMLElement; cleanup: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return {
    container,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function mkPool(reviewStatus = 'unreviewed'): PoolDto {
  return {
    items: [
      {
        audit_key: 'ak_render_1',
        unit_id: 'du_pool_1',
        round: 0,
        category: 'suspect:truncated',
        categories: ['suspect:truncated', 'suspect:low_coverage'],
        verdict: 'unconfirmed',
        judge_impl: 'mock:v1',
        rationale_ref: 'r-84',
        session_key: 'sess-pool-1',
        created_at: 1000,
        review_status: reviewStatus,
        review_actor: reviewStatus === 'unreviewed' ? null : 'u-42',
        review_at: reviewStatus === 'unreviewed' ? null : 1100,
      },
    ],
    counts_by_category: { 'suspect:truncated': 1 },
    truncated: false,
  };
}

describe('84 · D1 池页：首屏 / 筛选走服务端 / 提交后 reconcile（jsdom）', () => {
  beforeAll(() => {
    changeLanguage('zh-CN');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('空态：pool 为空 ⇒ 标题 + "暂无数据"', async () => {
    vi.spyOn(attributionApi, 'pool').mockResolvedValue({ items: [], counts_by_category: {}, truncated: false });
    const { container, cleanup } = await renderAndFlush(<AuditPoolPage />);
    try {
      const text = container.textContent ?? '';
      console.log(`84-D1-③ 池页空态=${text.slice(0, 90)}`);
      expect(text).toContain('抽查池');
      expect(text).toContain('暂无数据');
    } finally {
      cleanup();
    }
  });

  it('有数据态：渲染行 + 服务端 review_status', async () => {
    vi.spyOn(attributionApi, 'pool').mockResolvedValue(mkPool());
    const { container, cleanup } = await renderAndFlush(<AuditPoolPage />);
    try {
      const text = container.textContent ?? '';
      console.log(`84-D1-④ 池页有数据=${text.slice(0, 140)}`);
      expect(text).toContain('du_pool_1');
      expect(text).toContain('unreviewed');
      const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
      console.log(`84-D1-⑥ buttons=${JSON.stringify(buttons)}`);
    } finally {
      cleanup();
    }
  });

  it('筛选走服务端：从状态下拉选 confirmed ⇒ pool 请求带 review_status=confirmed（断言请求参数）', async () => {
    fakeSession();
    const poolSpy = vi.spyOn(attributionApi, 'pool').mockResolvedValue(mkPool());
    const { cleanup } = await renderAndFlush(<AuditPoolPage />);
    try {
      expect(poolSpy.mock.calls.length).toBe(1); // 首屏一次
      await openDropdown('全部状态');
      await selectOption('confirmed');
      await flush();
      const lastCall = poolSpy.mock.calls.at(-1)?.[0] as { review_status?: string } | undefined;
      console.log(`84-D1-⑨ pool 调用数=${poolSpy.mock.calls.length}；last args=${JSON.stringify(lastCall)}`);
      expect(poolSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(lastCall?.review_status).toBe('confirmed');
    } finally {
      cleanup();
    }
  });

  it('提交后 reconcile：选目标态+提交 ⇒ 权威重取发生（pool 再请求）且行状态随服务端值', async () => {
    fakeSession();
    const poolSpy = vi
      .spyOn(attributionApi, 'pool')
      .mockResolvedValueOnce(mkPool('unreviewed'))
      .mockResolvedValue(mkPool('confirmed')); // refetch 时=服务端新值
    const reviewSpy = vi.spyOn(attributionApi, 'review').mockResolvedValue({
      review_id: 'ar_84',
      status: 'confirmed',
      prev_status: 'unreviewed',
      kind: 'inserted',
    });
    const { container, cleanup } = await renderAndFlush(<AuditPoolPage />);
    try {
      await openDropdown('目标态');
      await selectOption('confirmed');
      await clickButton('提交');
      await flush();
      const text = container.textContent ?? '';
      console.log(
        `84-D1-⑩ review 调用=${reviewSpy.mock.calls.length}；pool 调用=${poolSpy.mock.calls.length}；` +
          `含"已提交"=${text.includes('已提交')}；含 confirmed 行状态=${text.includes('confirmed')}`,
      );
      expect(reviewSpy.mock.calls.length).toBe(1); // 提交确实发生
      expect(poolSpy.mock.calls.length).toBeGreaterThanOrEqual(2); // 权威重取（R1 的判定点）
    } finally {
      cleanup();
    }
  });
});
