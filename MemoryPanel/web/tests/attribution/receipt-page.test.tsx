// @vitest-environment jsdom
/**
 * 84 · D1：归因回执页组件渲染测试（jsdom，per-file；全局环境仍是 node）。
 *
 * 落位说明：放 `web/tests/**` ⇒ 直接复用 web 包已装好的 react/react-dom/tea-component 等
 * 运行时（零新运行依赖）；`jsdom` 装在 MemoryPanel 根（vitest 环境解析）。
 * 断言**用户可见行为**（文案/可见态）；数据层用 `vi.spyOn(attributionApi)` 假掉
 * （零网络、零真库、不启动服务）。视图逻辑不重复测（已在 view-model.test.ts）。
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { changeLanguage } from '@/i18n/index';
import { attributionApi, type ReceiptDto, type SessionSummary } from '@/lib/api/attribution';
import { AttributionReceiptPage } from '@/pages/AttributionReceiptPage';

// React 18 的手写测试（无 @testing-library）须显式声明 act 环境，否则 act() 退化为 no-op 并刷警告。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function renderAndFlush(node: ReactNode): Promise<{ container: HTMLElement; cleanup: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  // 多轮 flush：sessions 加载 → setSelected → receipt 加载 → setState（两次 effect 链）。
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

function mkSession(): SessionSummary {
  return {
    session_key: 'sess-render-1',
    space_id: '_default',
    first_event_at: 1000,
    last_event_at: 1200,
    counts: { units: 1, units_with_created_event: 1, judged: 1, unconfirmed: 0, used: 1, corrected: 0, pending: 0, failed: 0 },
  };
}

function mkReceipt(): ReceiptDto {
  return {
    session: {
      session_key: 'sess-render-1',
      space_id: '_default',
      first_event_at: 1000,
      last_event_at: 1200,
      assets: [],
    },
    counts: { units: 1, units_with_created_event: 1, judged: 1, unconfirmed: 0, used: 1, corrected: 0, pending: 0, failed: 0 },
    overflow: { pending: 0, note: '' },
    units: [
      {
        unit_id: 'du_render_1',
        kind: 'decision_unit',
        unit_type: 'code_change',
        turn_seq: 1,
        msg_seq: 16,
        created_at: 1000,
        judgement: {
          judgement_id: 'jd_render_1',
          verdict: 'confirmed',
          round: 0,
          asset_id: 'asset-1',
          asset_type: 'skill',
          evidence_source_type: null,
          judge_impl: 'mock:v1',
          prompt_sha256: 'sha',
          detail: { rationaleRef: 'r' },
        },
        status_events: [],
        missing: [],
      },
    ],
    truncated: false,
  };
}

/** 120 · 验收互锁用参数化工厂：总额/有事件额/行列表长度/truncated 均可覆写。
 *  缺省 units_with_created_event = units（相等态 ⇒ 不渲染标注，既有格不受影响）。 */
function mkReceiptWith(over: { units?: number; uwce?: number; rows?: number; truncated?: boolean }): ReceiptDto {
  const base = mkReceipt();
  const units = over.units ?? 1;
  const rows = over.rows ?? 1;
  const row0 = base.units[0]!;
  return {
    ...base,
    counts: { ...base.counts, units, units_with_created_event: over.uwce ?? units },
    units: Array.from({ length: rows }, (_, i) => ({ ...row0, unit_id: `du_render_${i + 1}` })),
    truncated: over.truncated ?? false,
  };
}

describe('84 · D1 回执页：首屏空态 / 有数据态（jsdom）', () => {
  beforeAll(() => {
    changeLanguage('zh-CN');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('空态：sessions 为空 ⇒ 页面标题 + "暂无数据"', async () => {
    vi.spyOn(attributionApi, 'sessions').mockResolvedValue({ sessions: [], truncated: false });
    const { container, cleanup } = await renderAndFlush(<AttributionReceiptPage />);
    try {
      const text = container.textContent ?? '';
      console.log(`84-D1-① 空态文案=${text.slice(0, 90)}`);
      expect(text).toContain('归因回执');
      expect(text).toContain('暂无数据');
    } finally {
      cleanup();
    }
  });

  it('有数据态：sessions+receipt ⇒ 单元行（轮/消息）+ 溢出文案', async () => {
    vi.spyOn(attributionApi, 'sessions').mockResolvedValue({ sessions: [mkSession()], truncated: false });
    vi.spyOn(attributionApi, 'receipt').mockResolvedValue(mkReceipt());
    const { container, cleanup } = await renderAndFlush(<AttributionReceiptPage />);
    try {
      const text = container.textContent ?? '';
      console.log(`84-D1-② 有数据文案=${text.slice(0, 160)}`);
      expect(text).toContain('轮 1 · 消息 16');
      expect(text).toContain('另有 0 个次要决策未逐一归因');
      expect(text).toContain('du_render_1');
    } finally {
      cleanup();
    }
  });
});

describe('120 · 回执页 Units 口径差标注（差值态 / 相等态 / 分页态 / en 双语）', () => {
  beforeAll(() => {
    changeLanguage('zh-CN');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    changeLanguage('zh-CN'); // en 格后复位
  });

  it('C3① 差额态：units=3 / uwce=2 ⇒ 渲染标注且数字 = 1，且**单处**（恰好一次）', async () => {
    vi.spyOn(attributionApi, 'sessions').mockResolvedValue({ sessions: [mkSession()], truncated: false });
    vi.spyOn(attributionApi, 'receipt').mockResolvedValue(mkReceiptWith({ units: 3, uwce: 2, rows: 2 }));
    const { container, cleanup } = await renderAndFlush(<AttributionReceiptPage />);
    try {
      const text = container.textContent ?? '';
      console.log(`120-C3① 差额态片段=${text.slice(text.indexOf('单元'), text.indexOf('单元') + 60)}`);
      expect(text).toContain('（其中 1 个仅见于队列/判定，无可展示事件）');
      expect((text.match(/仅见于队列\/判定/g) ?? []).length).toBe(1); // R5 钉"单处"
    } finally {
      cleanup();
    }
  });

  it('C3② 相等态：units=2 / uwce=2 ⇒ 不渲染任何标注（零噪声）', async () => {
    vi.spyOn(attributionApi, 'sessions').mockResolvedValue({ sessions: [mkSession()], truncated: false });
    vi.spyOn(attributionApi, 'receipt').mockResolvedValue(mkReceiptWith({ units: 2, uwce: 2, rows: 2 }));
    const { container, cleanup } = await renderAndFlush(<AttributionReceiptPage />);
    try {
      const text = container.textContent ?? '';
      expect(text).not.toContain('仅见于队列/判定');
    } finally {
      cleanup();
    }
  });

  it('C3③ 分页态：units=3 / uwce=2 / 本页仅 1 行 + truncated=true ⇒ 标注数字**不变 = 1**（不许用行数做减法）', async () => {
    vi.spyOn(attributionApi, 'sessions').mockResolvedValue({ sessions: [mkSession()], truncated: false });
    vi.spyOn(attributionApi, 'receipt').mockResolvedValue(mkReceiptWith({ units: 3, uwce: 2, rows: 1, truncated: true }));
    const { container, cleanup } = await renderAndFlush(<AttributionReceiptPage />);
    try {
      const text = container.textContent ?? '';
      // 用"本页行数"算差会得到 3−1=2 ⇒ 与本断言（1）冲突 ⇒ 红。
      expect(text).toContain('（其中 1 个仅见于队列/判定，无可展示事件）');
      expect(text).not.toContain('（其中 2 个仅见于队列/判定，无可展示事件）');
    } finally {
      cleanup();
    }
  });

  it('C3-en 双语：切 en-US ⇒ 英文文案（键不缺、无中文残留）', async () => {
    changeLanguage('en-US');
    vi.spyOn(attributionApi, 'sessions').mockResolvedValue({ sessions: [mkSession()], truncated: false });
    vi.spyOn(attributionApi, 'receipt').mockResolvedValue(mkReceiptWith({ units: 3, uwce: 2, rows: 2 }));
    const { container, cleanup } = await renderAndFlush(<AttributionReceiptPage />);
    try {
      const text = container.textContent ?? '';
      console.log(`120-C3-en 片段=${text.slice(text.indexOf('Units'), text.indexOf('Units') + 80)}`);
      expect(text).toContain('(1 of them appear only in the queue/judgement, with no displayable event)');
      expect(text).not.toContain('仅见于队列');
    } finally {
      cleanup();
    }
  });
});
