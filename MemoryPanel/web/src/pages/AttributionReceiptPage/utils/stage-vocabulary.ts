/**
 * `146 · C1`：**阶段词表（显名层）** —— 阶段 ↔ **既有载体** 的**唯一定义处**。
 *
 * 三条纪律（`146 · C1`；`130 §0` 方向 = 一处定义、其余引用）：
 * 1. **只映射、不新增事件类型**：右侧全是**既有载体**（判定 `detail_json` 字段 / 既有事件型）——
 *    **不得**新增 `asset_recalled` / `asset_selected` 这类同名事件（避免"多处独立断言同一事实"）。
 * 2. `validated` **不登记**：无生产者且被制度性禁写（`asset_validated` fail-closed，红线二）——
 *    `143` 落地前**不得**出现在词表（`R1`：提前映射 ⇒ 红）。
 * 3. `contributed` 属**任务六**：接口登记见 `70 spec`（**不进**本表；本线不实现、不造事件，`R3`）。
 *
 * 消费面：`view-model.ts` 的 `stageLine()`（口径行）+ 状态事件列（"显名"后缀）。
 */
export const STAGES = [
  { id: 'recalled', labelKey: 'attribution.receipt.stage.recalled', carrier: 'detail_json.shortlist / citationMetrics[]' },
  { id: 'selected', labelKey: 'attribution.receipt.stage.selected', carrier: 'detail_json.shortlist' },
  { id: 'injected', labelKey: 'attribution.receipt.stage.injected', carrier: 'injection.hook.done' },
  { id: 'used', labelKey: 'attribution.receipt.stage.used', carrier: 'asset_used' },
  { id: 'corrected', labelKey: 'attribution.receipt.stage.corrected', carrier: 'asset_corrected' },
] as const;

export type StageId = (typeof STAGES)[number]['id'];

/** 事件型 → 阶段（"显名"用；无对应 ⇒ `null`，**不猜**）。 */
const EVENT_TYPE_TO_STAGE: Readonly<Record<string, StageId>> = {
  'injection.hook.done': 'injected',
  asset_used: 'used',
  asset_corrected: 'corrected',
};

export function stageOfEventType(eventType: string): StageId | null {
  return EVENT_TYPE_TO_STAGE[eventType] ?? null;
}

/** 阶段标签的 i18n key（`attribution.receipt.stage.*`；zh/en 双侧同批）。 */
export function stageLabelKey(stage: StageId): string {
  return `attribution.receipt.stage.${stage}`;
}
