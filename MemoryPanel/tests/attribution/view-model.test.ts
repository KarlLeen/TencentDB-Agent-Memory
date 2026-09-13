/**
 * 76 · S7-c：视图模型纯函数测试（T6/T7/T8）——68 D1 / 溢出 / tombstone / 迁移表。
 * 直接 import web 源码（`@` alias → web/src）；node 环境、零 jsdom。
 */
import { describe, expect, it } from 'vitest';

import {
  DETECTED_SNAPSHOT_KEY,
  TOMBSTONE_RATIONALE_REF,
  overflowText,
  toAppliedSummary,
  toReceiptView,
  toUnitView,
} from '@/pages/AttributionReceiptPage/utils/view-model';
import { semanticTypeOf } from '@/pages/AttributionReceiptPage/utils/semantic-type';
import { tEn, tZh } from './_helpers/i18n-stub';
import {
  allowedTransitions,
  canSubmit,
  currentStatusOf,
  reconcileStatusFromServer,
  toPoolItemView,
  toPoolView,
} from '@/pages/AuditPoolPage/utils/view-model';
import type { ReceiptAsset, ReceiptDto, ReceiptUnit } from '@/lib/api/attribution';

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
      assets: [
        {
          asset_id: 'asset-1',
          asset_type: 'skill',
          first_seen_version: 1,
          last_seen_version: 2,
          observed_versions: [1, 2],
          injected: true, // 145：三态旗标（既有格：asset-1 被 used + corrected ⇒ 摘要 tier=corrected，不破坏既有断言）
          used: true,
          corrected: true,
        },
      ],
    },
    counts: { units: 1, judged: 1, unconfirmed: 0, used: 1, corrected: 1, pending, failed: 0 },
    overflow: { pending, note: '' },
    units: [unit],
    truncated: false,
  };
}

describe('76 · T6 68 D1：corrected 显示检测时间 + "检测时快照"；禁止"当前版本"', () => {
  it('corrected 视图：detected_at 透传、含标注、全输出不含"当前版本"', () => {
    const view = toReceiptView(mkDto(mkUnit()), tZh);
    const text = JSON.stringify(view);
    const corrected = view.units[0]!.status_events.find((e) => e.corrected)!.corrected!;
    console.log(`T6 → detected_at=${corrected.detected_at} note=${corrected.note}；含"当前版本"=${text.includes('当前版本')}`);
    expect(corrected.detected_at).toBe(1200);
    expect(corrected.note).toContain(tZh(DETECTED_SNAPSHOT_KEY));
    expect(text).not.toContain('当前版本'); // 68 D1 硬断言
    // 版本字段只作为**快照**出现（anchored/latest 都在 snapshot 语义里）
    expect(corrected.anchored_version).toBe(1);
    expect(corrected.latest_version).toBe(2);
  });

  it('K2：turn/msg 原样透传（turnLabel 只是文案，不改变粒度字段）', () => {
    const u = toUnitView(mkUnit({ turn_seq: 7, msg_seq: 112 }), tZh);
    console.log(`T6b → turn=${u.turn_seq} msg=${u.msg_seq} label=${u.turnLabel}`);
    expect(u.turn_seq).toBe(7);
    expect(u.msg_seq).toBe(112);
  });
});

describe('76 · T7 溢出文案 + tombstone 单列不进 suspect', () => {
  it('overflow：30 spec 原文口径逐字', () => {
    const view = toReceiptView(mkDto(mkUnit(), 3), tZh);
    console.log(`T7 → ${view.overflow.text}`);
    expect(view.overflow.text).toContain('另有 3 个次要决策未逐一归因');
    expect(overflowText(0, tZh)).toBe('另有 0 个次要决策未逐一归因（top-N 闸门；保持 pending，下轮 FIFO 优先）');
  });

  it('tombstone ⇒ unexecuted=true 且 suspectFlags 空', () => {
    const tomb = mkUnit({
      unit_id: 'du_tomb',
      judgement: { ...mkUnit().judgement!, verdict: 'unconfirmed', detail: { rationaleRef: TOMBSTONE_RATIONALE_REF } },
      status_events: [],
    });
    const view = toReceiptView(mkDto(tomb), tZh);
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

describe('145 · 摘要层 + 三档效果状态（C1/C2/C3；红线一/二）', () => {
  function mkAsset(over: Partial<ReceiptAsset> & { asset_id: string }): ReceiptAsset {
    return {
      asset_type: 'skill',
      first_seen_version: null,
      last_seen_version: null,
      observed_versions: [],
      injected: true,
      used: false,
      corrected: false,
      ...over,
    };
  }

  function mkCitedUnit(unitId: string, unitKind: string, assetId: string): ReceiptUnit {
    const base = mkUnit();
    return {
      ...base,
      unit_id: unitId,
      unit_type: unitKind,
      judgement: { ...base.judgement!, asset_id: assetId, detail: { rationaleRef: 'r-145', unitKind } },
      status_events: [{ ...base.status_events[0]!, status_id: `se_${unitId}`, asset_id: assetId }],
    };
  }

  function mkDtoWith(assets: ReceiptAsset[], units: ReceiptUnit[] = []): ReceiptDto {
    const base = mkDto(mkUnit());
    return { ...base, session: { ...base.session, assets }, units };
  }

  it('C1/C2/C3：三档互斥（已校正 > 已采用 > 待验证）+ N = 三类之和 + 文案逐字；仅 fetched 不算应用', () => {
    const dto = mkDtoWith(
      [
        // A：used + corrected ⇒ 已校正（优先级最高）
        mkAsset({ asset_id: 'asset-A', asset_type: 'skill', injected: true, used: true, corrected: true }),
        // B：used ⇒ 已采用
        mkAsset({ asset_id: 'asset-B', asset_type: 'chat_memory', injected: true, used: true }),
        // C：仅 injected ⇒ 待验证
        mkAsset({ asset_id: 'asset-C', asset_type: 'code_graph', injected: true }),
        // D：仅 fetched（未进上下文）⇒ **不算应用**，不进摘要
        mkAsset({ asset_id: 'asset-D', asset_type: 'llm_wiki', injected: false, used: false, corrected: false }),
      ],
      [
        mkCitedUnit('u-A', 'key_tool_call', 'asset-A'),
        mkCitedUnit('u-B', 'restraint', 'asset-B'),
      ],
    );
    const s = toAppliedSummary(dto, tZh);
    console.log(`145-C1 → ${s.title}；items=${JSON.stringify(s.items.map((i) => [i.label, i.purpose, i.tier]))}；effect=${s.effect.text}；note=${s.effectNote}`);
    expect(s.title).toBe('本次应用 3 项团队资产');
    expect(s.items.map((i) => i.asset_id)).toEqual(['asset-A', 'asset-B', 'asset-C']); // D 不进
    expect(s.items.map((i) => i.tier)).toEqual(['corrected', 'used', 'pending']);
    expect(s.effect).toMatchObject({ used: 1, corrected: 1, pending: 1, total: 3 });
    expect(s.effect.total).toBe(s.effect.used + s.effect.corrected + s.effect.pending); // C3 自洽
    expect(s.effect.text).toBe('1 项已采用；1 项已校正（检测时快照）；1 项仅作为背景参考，效果待验证');
    expect(s.effectNote).toBe('效果评测（对照实验）见任务五');
    // 用途短语（规则模板）：A 由 key_tool_call unit 引用；B 由 restraint unit 引用；C 仅注入 ⇒ 背景参考
    expect(s.items[0]!.purpose).toBe('用于关键工具调用处的决策依据');
    expect(s.items[1]!.purpose).toBe('用于风险克制处的决策依据');
    expect(s.items[2]!.purpose).toBe('作为背景参考（未检测到确认引用）');
  });

  it('C1 兜底：无引用 unit（或 kind 未登记）⇒ generic；不得凭空断言用途', () => {
    const dto = mkDtoWith([mkAsset({ asset_id: 'asset-X', injected: true, used: true })], []);
    const s = toAppliedSummary(dto, tZh);
    console.log(`145-b → purpose=${s.items[0]!.purpose}`);
    expect(s.items[0]!.purpose).toBe('用于本会话的决策依据');
  });

  it('红线一/二（R1/R4 钉）：全档文案与摘要**不含**"已验证 / 已生效 / 有效 / 收益"类效果陈述', () => {
    const s = toAppliedSummary(
      mkDtoWith([mkAsset({ asset_id: 'asset-1', injected: true }), mkAsset({ asset_id: 'asset-2', injected: true, used: true })]),
      tZh,
    );
    const text = JSON.stringify(s);
    console.log(`145-红线 → ${s.effect.text}；含"已验证"=${text.includes('已验证')}`);
    for (const w of ['已验证', '已生效', '有效', '带来收益', '产生了效果']) {
      expect(text.includes(w), `不得出现 "${w}"`).toBe(false);
    }
    expect(s.effect.text).toContain('效果待验证');
    expect(s.effect.text).not.toContain('已验证');
  });

  it('C1 映射（144 · C1 单一落点）：四个技术类各有落点；未知/空 ⇒ other（不猜）', () => {
    expect(semanticTypeOf('skill')).toBe('skill');
    expect(semanticTypeOf('code_graph')).toBe('codeKnowledge');
    expect(semanticTypeOf('llm_wiki')).toBe('productKnowledge');
    expect(semanticTypeOf('chat_memory')).toBe('historicalPlan');
    expect(semanticTypeOf('bogus')).toBe('other');
    expect(semanticTypeOf(null)).toBe('other');
    expect(semanticTypeOf(undefined)).toBe('other');
    const s = toAppliedSummary(
      mkDtoWith([
        mkAsset({ asset_id: 'a', asset_type: 'llm_wiki', injected: true }),
        mkAsset({ asset_id: 'b', asset_type: null, injected: true }),
      ]),
      tZh,
    );
    console.log(`145-映射 → ${JSON.stringify(s.items.map((i) => i.label))}`);
    expect(s.items.map((i) => i.label)).toEqual(['产品知识', '其他']);
  });

  it('en 侧逐字（键不缺）：title / 三档文案 / note', () => {
    const s = toAppliedSummary(
      mkDtoWith([mkAsset({ asset_id: 'asset-1', injected: true, used: true }), mkAsset({ asset_id: 'asset-2', injected: true })]),
      tEn,
    );
    console.log(`145-en → ${s.title}；${s.effect.text}；${s.effectNote}`);
    expect(s.title).toBe('2 team assets applied in this session');
    expect(s.effect.text).toBe('1 used; 1 background only, effect pending verification');
    expect(s.effectNote).toBe('Effect evaluation (controlled comparison) is covered by Task 5');
  });
});
