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
    counts: { units: 1, judged: 1, unconfirmed: 0, used: 1, corrected: 0, pending: 0, failed: 0 },
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
    counts: { units: 1, judged: 1, unconfirmed: 0, used: 1, corrected: 0, pending: 0, failed: 0 },
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
