/**
 * 76 · S7-c：视图模型纯函数测试（T6/T7/T8）——68 D1 / 溢出 / tombstone / 迁移表。
 * 直接 import web 源码（`@` alias → web/src）；node 环境、零 jsdom。
 */
import { describe, expect, it } from 'vitest';

import {
  DETECTED_SNAPSHOT_LABEL,
  TOMBSTONE_RATIONALE_REF,
  overflowText,
  toReceiptView,
  toUnitView,
} from '@/pages/AttributionReceiptPage/utils/view-model';
import {
  allowedTransitions,
  canSubmit,
  currentStatusOf,
  reconcileStatusFromServer,
  toPoolItemView,
  toPoolView,
} from '@/pages/AuditPoolPage/utils/view-model';
import type { ReceiptDto, ReceiptUnit } from '@/lib/api/attribution';

function mkUnit(over: Partial<ReceiptUnit> = {}): ReceiptUnit {
  return {
    unit_id: 'du_t6',
    kind: 'decision_unit',
    unit_type: 'code_change',
    turn_seq: 1,
    msg_seq: 16,
    created_at: 1000,
    judgement: {
      judgement_id: 'jd_t6',
      verdict: 'confirmed',
      round: 0,
      asset_id: 'asset-1',
      asset_type: 'skill',
      evidence_source_type: null,
      judge_impl: 'mock:v1',
      prompt_sha256: 'sha',
      detail: { rationaleRef: 'r', shortlist: { k: 1, total: 1, overflowCount: 0, overflowAssetIds: [] }, citationMetrics: [{ coverage: 0.9 }] },
    },
    status_events: [
      {
        status_id: 'se_used',
        event_type: 'asset_used',
        asset_id: 'asset-1',
        asset_type: 'skill',
        round: 0,
        outcome: null,
        created_at: 1100,
        payload: { judgement_id: 'jd_t6' },
      },
      {
        status_id: 'se_corr',
        event_type: 'asset_corrected',
        asset_id: 'asset-1',
        asset_type: 'skill',
        round: 0,
        outcome: null,
        created_at: 1200,
        route: 'version_drift',
        detected_at: 1200,
        snapshot: { anchored_version: 1, latest_version: 2, semantics: 'detected_at_snapshot' },
        payload: { judgement_id: 'jd_t6', correction_route: 'version_drift', anchored_version: 1, latest_version: 2 },
      },
    ],
    missing: [],
    ...over,
  };
}

function mkDto(unit: ReceiptUnit, pending = 0): ReceiptDto {
  return {
    session: {
      session_key: 'sess-t6',
      space_id: '_default',
      first_event_at: 1000,
      last_event_at: 1200,
      assets: [{ asset_id: 'asset-1', asset_type: 'skill', first_seen_version: 1, last_seen_version: 2, observed_versions: [1, 2] }],
    },
    counts: { units: 1, judged: 1, unconfirmed: 0, used: 1, corrected: 1, pending, failed: 0 },
    overflow: { pending, note: '' },
    units: [unit],
    truncated: false,
  };
}

describe('76 · T6 68 D1：corrected 显示检测时间 + "检测时快照"；禁止"当前版本"', () => {
  it('corrected 视图：detected_at 透传、含标注、全输出不含"当前版本"', () => {
    const view = toReceiptView(mkDto(mkUnit()));
    const text = JSON.stringify(view);
    const corrected = view.units[0]!.status_events.find((e) => e.corrected)!.corrected!;
    console.log(`T6 → detected_at=${corrected.detected_at} note=${corrected.note}；含"当前版本"=${text.includes('当前版本')}`);
    expect(corrected.detected_at).toBe(1200);
    expect(corrected.note).toContain(DETECTED_SNAPSHOT_LABEL);
    expect(text).not.toContain('当前版本'); // 68 D1 硬断言
    // 版本字段只作为**快照**出现（anchored/latest 都在 snapshot 语义里）
    expect(corrected.anchored_version).toBe(1);
    expect(corrected.latest_version).toBe(2);
  });

  it('K2：turn/msg 原样透传（turnLabel 只是文案，不改变粒度字段）', () => {
    const u = toUnitView(mkUnit({ turn_seq: 7, msg_seq: 112 }));
    console.log(`T6b → turn=${u.turn_seq} msg=${u.msg_seq} label=${u.turnLabel}`);
    expect(u.turn_seq).toBe(7);
    expect(u.msg_seq).toBe(112);
  });
});

describe('76 · T7 溢出文案 + tombstone 单列不进 suspect', () => {
  it('overflow：30 spec 原文口径逐字', () => {
    const view = toReceiptView(mkDto(mkUnit(), 3));
    console.log(`T7 → ${view.overflow.text}`);
    expect(view.overflow.text).toContain('另有 3 个次要决策未逐一归因');
    expect(overflowText(0)).toBe('另有 0 个次要决策未逐一归因（top-N 闸门；保持 pending，下轮 FIFO 优先）');
  });

  it('tombstone ⇒ unexecuted=true 且 suspectFlags 空', () => {
    const tomb = mkUnit({
      unit_id: 'du_tomb',
      judgement: { ...mkUnit().judgement!, verdict: 'unconfirmed', detail: { rationaleRef: TOMBSTONE_RATIONALE_REF } },
      status_events: [],
    });
    const view = toReceiptView(mkDto(tomb));
    const u = view.units[0]!;
    console.log(`T7b → unexecuted=${u.unexecuted} suspectFlags=${JSON.stringify(u.suspectFlags)}`);
    expect(u.unexecuted).toBe(true);
    expect(u.suspectFlags).toEqual([]);
  });
});

describe('76 · T8 池页迁移表：仅合法目标态；自迁移被阻断', () => {
  it('迁移表与自迁移禁', () => {
    console.log(`T8 → unreviewed=${JSON.stringify(allowedTransitions('unreviewed'))}；canSubmit(confirmed→confirmed)=${canSubmit('confirmed', 'confirmed')}`);
    expect(allowedTransitions('unreviewed')).toEqual(['confirmed', 'dismissed', 'needs_fix']);
    expect(allowedTransitions('confirmed')).toEqual(['needs_fix', 'dismissed']);
    expect(canSubmit('confirmed', 'confirmed')).toBe(false); // 自迁移禁
    expect(canSubmit('dismissed', 'needs_fix')).toBe(true);
    expect(canSubmit('needs_fix', 'confirmed')).toBe(true);
    expect(allowedTransitions('bogus')).toEqual([]); // 未知状态 ⇒ 无可选项（服务端仍 400 兜底）
  });

  it('toPoolView：多命中 categories 全列 + 七类顺序', () => {
    const view = toPoolView({
      items: [
        {
          audit_key: 'ak_a',
          unit_id: 'u',
          round: 0,
          category: 'suspect:truncated',
          categories: ['suspect:low_coverage', 'suspect:truncated'],
          verdict: 'unconfirmed',
          judge_impl: 'mock:v1',
          rationale_ref: 'r',
          session_key: 's',
          created_at: 1,
          review_status: 'unreviewed',
          review_actor: null,
          review_at: null,
        },
      ],
      counts_by_category: { 'suspect:truncated': 1 },
      truncated: false,
    });
    expect(view.items[0]!.categories).toEqual(['suspect:low_coverage', 'suspect:truncated']);
    expect(view.categoryOrder[0]).toBe('suspect:truncated');
    expect(view.categoryOrder.length).toBe(7);
  });
});

describe('77 · T5/T6 池页：服务端状态是唯一真相 + 提交后 reconcile', () => {
  const mkItem = (reviewStatus: string) => ({
    audit_key: 'ak_77',
    unit_id: 'u-77',
    round: 0,
    category: 'suspect:truncated',
    categories: ['suspect:truncated'],
    verdict: 'unconfirmed',
    judge_impl: 'mock:v1',
    rationale_ref: 'r',
    session_key: 's-77',
    created_at: 1,
    review_status: reviewStatus,
    review_actor: reviewStatus === 'unreviewed' ? null : 'u-42',
    review_at: reviewStatus === 'unreviewed' ? null : 1234,
  });

  it('T5：BFF 返回 confirmed ⇒ 初始当前状态 = confirmed（不是 unreviewed）', () => {
    const view = toPoolItemView(mkItem('confirmed'));
    const current = currentStatusOf(view);
    console.log(`77-T5 → currentStatus=${current}（source=review_status）`);
    expect(current).toBe('confirmed');
    // 服务端 unreviewed ⇒ unreviewed（另一格：防止"默认硬编码 confirmed"的假绿）
    expect(currentStatusOf(toPoolItemView(mkItem('unreviewed')))).toBe('unreviewed');
  });

  it('T6：提交后 reconcile ⇒ 服务端值优先（乐观值不覆盖服务端结果）', () => {
    const reconciled = reconcileStatusFromServer('confirmed'); // 服务端返回值
    console.log(`77-T6 → reconciled=${reconciled}（optimistic=dismissed 被服务端覆盖）`);
    expect(reconciled).toBe('confirmed');
    expect(reconciled).not.toBe('dismissed');
  });
});
