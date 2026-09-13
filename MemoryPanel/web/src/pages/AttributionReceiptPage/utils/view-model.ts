/**
 * 76 · S7-c 回执页：DTO → 视图模型（**纯函数**）。
 *
 * ⚠️ 本文件必须保持 **零 React / 零 DOM** 依赖——三条展示硬约束在此钉死、由 node
 * 环境单测直接断言（`tests/attribution/view-model.test.ts`）：
 *   1. **68 D1**：corrected 行显示**检测时间**（`detected_at`）并标注"检测时快照"；
 *      **禁止**出现"当前版本"字样（`latest_version` 只是快照，不是当前值）；
 *   2. **K2**：粒度 = **轮**——`turn_seq`/`msg_seq` 原样透传，不合成更细粒度字段；
 *   3. **溢出**：必须能显示"另有 N 个次要决策未逐一归因"（30 spec 原文口径）。
 *
 * tombstone（`tombstone:result_missing`）= "未执行"类：**单列、不进 suspect 标记**。
 *
 * **126（D1 (i)）**：文案走 i18n —— 本文件**注入 `t`**（`TranslateFn` 参数）而**保持纯函数**
 * （给定输入 + 给定 t ⇒ 确定输出；三条硬约束仍可在纯 node 层直接断言，不依赖 jsdom）。
 */
import type {
  ReceiptDto,
  ReceiptStatusEvent,
  ReceiptUnit,
} from '@/lib/api/attribution';

/** 126 · D1 (i)：翻译函数注入面（i18next `t` 的最小子集；`{{var}}` 插值由 t 侧完成）。 */
export type TranslateFn = (key: string, opts?: Record<string, string | number>) => string;

/** 68 D1 的展示标注（**文案是契约的一部分**；126 起 = i18n key，值在 zh/en 资源）。 */
export const DETECTED_SNAPSHOT_KEY = 'attribution.receipt.detectedSnapshot';
/** tombstone 的 rationaleRef（与 S7-b 硬排除一致）。 */
export const TOMBSTONE_RATIONALE_REF = 'tombstone:result_missing';

export interface CorrectedView {
  detected_at: number;
  anchored_version: number | null;
  latest_version: number | null;
  /** 例："检测时快照（候选 1 → 现 2）"——只描述**检测时**的观测。 */
  note: string;
}

export interface StatusEventView {
  status_id: string;
  event_type: string;
  asset_id: string | null;
  created_at: number;
  /** corrected 才有。 */
  corrected?: CorrectedView;
}

export interface UnitView {
  unit_id: string;
  unit_type: string | null;
  /** K2：轮粒度（原样透传，不合成）。 */
  turn_seq: number;
  msg_seq: number;
  turnLabel: string;
  verdict: string | null;
  judge_impl: string | null;
  rationale_ref: string | null;
  /** suspect 标记（**tombstone 不进**）。 */
  suspectFlags: string[];
  /** "未执行"标记（tombstone 单列）。 */
  unexecuted: boolean;
  status_events: StatusEventView[];
  missing: string[];
}

export interface OverflowView {
  pending: number;
  /** 30 spec 原文口径（逐字）。 */
  text: string;
}

export interface ReceiptView {
  session_key: string;
  space_id: string;
  assets: Array<{ asset_id: string; versions: number[] }>;
  counts: ReceiptDto['counts'];
  overflow: OverflowView;
  units: UnitView[];
  truncated: boolean;
}

/** 30 spec 原文口径（zh 资源逐字保留；126 起经注入的 `t` 取值）。 */
export function overflowText(pending: number, t: TranslateFn): string {
  return t('attribution.receipt.overflow', { pending });
}

export function toOverflowView(pending: number, t: TranslateFn): OverflowView {
  return { pending, text: overflowText(pending, t) };
}

/** corrected 事件 → 展示视图（68 D1：只暴露检测时快照 + 检测时间）。 */
export function toCorrectedView(ev: ReceiptStatusEvent, t: TranslateFn): CorrectedView | null {
  if (ev.event_type !== 'asset_corrected') return null;
  const anchored = ev.snapshot?.anchored_version ?? null;
  const latest = ev.snapshot?.latest_version ?? null;
  const a = anchored ?? '?';
  const l = latest ?? '?';
  return {
    detected_at: ev.detected_at ?? ev.created_at,
    anchored_version: anchored,
    latest_version: latest,
    note: t('attribution.receipt.detectedNote', { label: t(DETECTED_SNAPSHOT_KEY), a, l }),
  };
}

function toStatusEventView(ev: ReceiptStatusEvent, t: TranslateFn): StatusEventView {
  const corrected = toCorrectedView(ev, t);
  const base: StatusEventView = {
    status_id: ev.status_id,
    event_type: ev.event_type,
    asset_id: ev.asset_id,
    created_at: ev.created_at,
  };
  if (corrected) base.corrected = corrected;
  return base;
}

/** suspect 标记（receipt 页现状面）：**tombstone 不并入**。 */
function suspectFlagsOf(unit: ReceiptUnit): string[] {
  const flags: string[] = [];
  const ref = typeof unit.judgement?.detail?.rationaleRef === 'string'
    ? (unit.judgement.detail.rationaleRef as string)
    : null;
  if (ref === TOMBSTONE_RATIONALE_REF) return flags; // 硬排除
  if (unit.judgement?.verdict === 'unconfirmed') flags.push('unconfirmed');
  if (!unit.judgement) flags.push('unjudged');
  return flags;
}

export function toUnitView(unit: ReceiptUnit, t: TranslateFn): UnitView {
  const ref = typeof unit.judgement?.detail?.rationaleRef === 'string'
    ? (unit.judgement.detail.rationaleRef as string)
    : null;
  return {
    unit_id: unit.unit_id,
    unit_type: unit.unit_type,
    turn_seq: unit.turn_seq, // K2：原样
    msg_seq: unit.msg_seq, // K2：原样
    turnLabel: t('attribution.receipt.turnLabel', { turn: unit.turn_seq, msg: unit.msg_seq }), // 展示层唯一合成 = 文案（不改粒度）
    verdict: unit.judgement?.verdict ?? null,
    judge_impl: unit.judgement?.judge_impl ?? null,
    rationale_ref: ref,
    suspectFlags: suspectFlagsOf(unit),
    unexecuted: ref === TOMBSTONE_RATIONALE_REF,
    status_events: unit.status_events.map((ev) => toStatusEventView(ev, t)),
    missing: [...unit.missing],
  };
}

export function toReceiptView(dto: ReceiptDto, t: TranslateFn): ReceiptView {
  return {
    session_key: dto.session.session_key,
    space_id: dto.session.space_id,
    assets: dto.session.assets.map((a) => ({ asset_id: a.asset_id, versions: a.observed_versions })),
    counts: dto.counts,
    overflow: toOverflowView(dto.overflow.pending, t),
    units: dto.units.map((u) => toUnitView(u, t)),
    truncated: dto.truncated,
  };
}
