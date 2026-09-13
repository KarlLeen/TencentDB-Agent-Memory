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
  ReceiptAsset,
  ReceiptDto,
  ReceiptStatusEvent,
  ReceiptUnit,
} from '@/lib/api/attribution';

import { semanticTypeKey, semanticTypeOf, type SemanticType } from './semantic-type';

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

/**
 * `144 · C2` 资产展开层（**新增并列字段**；`observed_versions` 语义不变）。
 *
 * 缺值一律 `null` / `[]` ⇒ 渲染层用"未知"（`—` + tooltip），**不得**用 `0` / 空串冒充（`R4`）。
 * `usageLocations`/`changes` 两格依赖 `142`（变更锚定）⇒ 本单**只留列位 + 空态文案**（`C4`）。
 */
export interface AssetView {
  asset_id: string;
  /** 版本链（60 spec §3：本会话 fetched 窗口内的观测；未 fetched ⇒ `[]`）。 */
  versions: number[];
  /** 名称（BFF 只读富化；缺 ⇒ `null`）。 */
  name: string | null;
  /** 技术类原值（**不得**改写；行内缺 ⇒ 用元数据兜底）。 */
  assetType: string | null;
  /** 语义类（`./semantic-type` 映射结果；映射不到 ⇒ `other`，**不猜**）。 */
  semanticType: SemanticType;
  /** 语义类标签（i18n 已译）。 */
  semanticLabel: string;
  /** 版本展示串（`observed_versions.join('→')`；空 ⇒ `null`）。 */
  version: string | null;
  /** 元数据更新时间（ms；缺 ⇒ `null`）。 */
  updatedAt: number | null;
  /** 验证状态：`143` 未落地 ⇒ 固定 `pending`（未定义验证器）；**不得**拿 meta.status 冒充。 */
  verificationStatus: 'pending';
  /** 来源：当前无数据源 ⇒ `null`（渲染"未知"；不臆造文档/代码位置）。 */
  source: string | null;
  /** 本次使用位置：依赖 `142` ⇒ 恒 `[]`（留列位 + 空态文案）。 */
  usageLocations: string[];
  /** 风险：当前唯一可诚实派生 = 版本漂移（`corrected` ⇒ 一条）；其余待 `142`/`143`。 */
  risks: string[];
  /** 三态（与摘要层**同一事实源** = DTO 旗标）。 */
  injected: boolean;
  used: boolean;
  corrected: boolean;
}

/** 资产风险文案（i18n key；当前唯一可派生项 = 版本漂移）。 */
const RISK_VERSION_DRIFT_KEY = 'attribution.receipt.risk.versionDrift';

export function toAssetView(a: ReceiptAsset, t: TranslateFn): AssetView {
  const assetType = a.asset_type ?? a.meta?.asset_type ?? null;
  const semanticType = semanticTypeOf(assetType);
  return {
    asset_id: a.asset_id,
    versions: [...a.observed_versions],
    name: a.meta?.name ?? null,
    assetType,
    semanticType,
    semanticLabel: t(semanticTypeKey(semanticType)),
    version: a.observed_versions.length > 0 ? a.observed_versions.join('→') : null,
    updatedAt: a.meta?.updated_at_ms ?? null,
    verificationStatus: 'pending',
    source: null,
    usageLocations: [],
    risks: a.corrected ? [t(RISK_VERSION_DRIFT_KEY)] : [],
    injected: a.injected,
    used: a.used,
    corrected: a.corrected,
  };
}

export interface ReceiptView {
  session_key: string;
  space_id: string;
  assets: AssetView[];
  counts: ReceiptDto['counts'];
  overflow: OverflowView;
  /** `145`：摘要层（卡片式，位于计数行之上）。 */
  summary: AppliedSummaryView;
  units: UnitView[];
  truncated: boolean;
}

/** `145 · C2` 三档效果状态（**互斥**；"已验证"档不存在——`143` 未落地前禁写，红线二）。 */
export type EffectTier = 'used' | 'corrected' | 'pending';

/** 摘要层单项："语义类：用途短语"。 */
export interface SummaryItemView {
  asset_id: string;
  semanticType: SemanticType;
  /** 语义类标签（i18n 已译；映射见 `./semantic-type`）。 */
  label: string;
  /** 用途短语（**规则模板生成**、非 LLM —— 可复现、可测试）。 */
  purpose: string;
  tier: EffectTier;
}

/** 三档效果状态（计数 + 文案）。 */
export interface EffectStatusView {
  used: number;
  corrected: number;
  pending: number;
  /** = used + corrected + pending（**结构性自洽**；`C3`）。 */
  total: number;
  /** 非零档才出现；全零 ⇒ 中性句。 */
  text: string;
}

/** `145 · C1` 摘要层视图。 */
export interface AppliedSummaryView {
  /** "本次应用 N 项团队资产"。 */
  title: string;
  items: SummaryItemView[];
  effect: EffectStatusView;
  /** 红线 3：总是写明的"效果评测见任务五"。 */
  effectNote: string;
}

/** 30 spec 原文口径（zh 资源逐字保留；126 起经注入的 `t` 取值）。 */
export function overflowText(pending: number, t: TranslateFn): string {
  return t('attribution.receipt.overflow', { pending });
}

export function toOverflowView(pending: number, t: TranslateFn): OverflowView {
  return { pending, text: overflowText(pending, t) };
}

/** 用途短语规则表（`145 · C1`，**逐字写死**）：unitKind → i18n key。
 *  取值来源 = 判定 `detail.unitKind`（优先）⇒ `unit.unit_type`（缺省）⇒ generic。 */
const PURPOSE_BY_UNIT_KIND: Readonly<Record<string, string>> = {
  code_change: 'attribution.receipt.purpose.codeChange',
  key_tool_call: 'attribution.receipt.purpose.keyToolCall',
  restraint: 'attribution.receipt.purpose.restraint',
};
const PURPOSE_GENERIC_KEY = 'attribution.receipt.purpose.generic';
/** 待验证（仅 injected、无 used）：**不得**写"已生效 / 已被引用"类措辞。 */
const PURPOSE_BACKGROUND_KEY = 'attribution.receipt.purpose.background';

/** 最早引用该资产的 unit 的 unitKind（判据 = 该 unit 的 status_events 含此资产的 used/corrected 行）。 */
function citedUnitKind(assetId: string, units: readonly ReceiptUnit[]): string {
  for (const u of units) {
    const cited = u.status_events.some(
      (e) => e.asset_id === assetId && (e.event_type === 'asset_used' || e.event_type === 'asset_corrected'),
    );
    if (!cited) continue;
    const kind = u.judgement?.detail?.unitKind;
    if (typeof kind === 'string' && kind.length > 0) return kind;
    return u.unit_type ?? '';
  }
  return '';
}

function purposeOf(assetId: string, tier: EffectTier, units: readonly ReceiptUnit[], t: TranslateFn): string {
  if (tier === 'pending') return t(PURPOSE_BACKGROUND_KEY);
  const kind = citedUnitKind(assetId, units);
  return t(PURPOSE_BY_UNIT_KIND[kind] ?? PURPOSE_GENERIC_KEY);
}

/** 资产级三档判据（`145 · C2`，**互斥**，优先级：已校正 > 已采用 > 待验证＝仅 injected、无 used）。 */
export function effectTierOf(a: ReceiptAsset): EffectTier {
  if (a.corrected) return 'corrected';
  if (a.used) return 'used';
  return 'pending';
}

/** 三档文案（非零档才出现；全零 ⇒ 中性句；**永不**出现"已验证"）。 */
export function effectText(used: number, corrected: number, pending: number, t: TranslateFn): string {
  const parts: string[] = [];
  if (used > 0) parts.push(t('attribution.receipt.effect.used', { n: used }));
  if (corrected > 0) parts.push(t('attribution.receipt.effect.corrected', { n: corrected }));
  if (pending > 0) parts.push(t('attribution.receipt.effect.pending', { n: pending }));
  return parts.length > 0 ? parts.join(t('attribution.receipt.effect.separator')) : t('attribution.receipt.effect.none');
}

/** `145 · C1/C3`：摘要层 —— 口径 = **应用过的资产**（injected ∪ used ∪ corrected）；
 *  "仅 fetched（看过但没进上下文）"**不算应用**，不进摘要（但仍留在资产区）。 */
export function toAppliedSummary(dto: ReceiptDto, t: TranslateFn): AppliedSummaryView {
  const applied = dto.session.assets.filter((a) => a.injected || a.used || a.corrected);
  const items: SummaryItemView[] = applied.map((a) => {
    const tier = effectTierOf(a);
    const semanticType = semanticTypeOf(a.asset_type);
    return {
      asset_id: a.asset_id,
      semanticType,
      label: t(semanticTypeKey(semanticType)),
      purpose: purposeOf(a.asset_id, tier, dto.units, t),
      tier,
    };
  });
  const used = items.filter((i) => i.tier === 'used').length;
  const corrected = items.filter((i) => i.tier === 'corrected').length;
  const pending = items.filter((i) => i.tier === 'pending').length;
  return {
    title: t('attribution.receipt.summary.title', { n: items.length }),
    items,
    effect: {
      used,
      corrected,
      pending,
      total: items.length, // C3：三类互斥且覆盖 items ⇒ N ≡ used + corrected + pending
      text: effectText(used, corrected, pending, t),
    },
    effectNote: t('attribution.receipt.effect.note'),
  };
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
    assets: dto.session.assets.map((a) => toAssetView(a, t)), // 144 · C2：展开层字段（并列新增）
    counts: dto.counts,
    overflow: toOverflowView(dto.overflow.pending, t),
    summary: toAppliedSummary(dto, t), // 145 · C1：摘要层（计数行之上）
    units: dto.units.map((u) => toUnitView(u, t)),
    truncated: dto.truncated,
  };
}
