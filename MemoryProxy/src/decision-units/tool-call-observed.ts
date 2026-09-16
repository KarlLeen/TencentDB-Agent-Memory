/**
 * `163`：**工具调用素材** —— 同 turn 内「非 key 决策单元」的 shell 工具调用，作为判官
 * 背景材料（`tool_call.observed`），**不判定、不进队列、不进 `asset_used`**。
 *
 * 与 `149` 的 `agent.tool.change`（变更/结果锚定）是**两个正交事件**：
 *   - `agent.tool.change`：`classifyToolChange`（edit/write/run_tests/lint/build），
 *     记 `kind`/`path_sha16`/`exit_status`，只读类**不产**（`R2`）；
 *   - `tool_call.observed`：`commandSurfaceTextOf` 非空**且** `matchKeyToolFirst` 未命中
 *     （即 grep/diff/sort/cat/wc/ls 等**非 key** 的 shell 命令），记命令原文 + exit_status。
 *
 * 三条纪律（对齐 `149` 契约、`163` 设计）：
 * 1. **复用现成遍历 + `commandSurfaceTextOf`**：命令面提取零新增逻辑；只把「记录对象」
 *    从「匹配 key_tool 的」扩展到「非 key 的 shell 命令」。key_tool 命中的命令**已**是
 *    决策单元（`decision_unit.created`），这里**不重复记录**（`continue` 跳过）。
 * 2. **capture 层要宽**：`command_surface` 落库**不截断**（仅由上层 `TEXT_SNIPPET_MAX`
 *    防极端超长）；截断只在 consume 层（worker 组装）发生，且先用宽松值、回看真实分布收紧。
 * 3. **幂等**：独立槽位带 `TOOL_CALL_OBSERVED_SEQ_BASE`（与单元槽位、`TOOL_CHANGE_SEQ_BASE`
 *    均不相交）⇒ 复用 `idx_ae_unit_dedupe`（`(session_key, turn_seq, msg_seq)`），
 *    同请求重放 / 进程重启回看静默冲突，幂等免费继承。
 */
import { deriveSegmentTurnSeqs } from "./message-increment-archive.js";
import { DECISION_SLOTS_PER_MESSAGE, type Protocol } from "./types.js";
import { normalizeMessages } from "./decision-unit-extractor.js";
import { commandSurfaceTextOf, matchKeyToolFirst } from "./vocab.js";
import type { UnitAnchorRef } from "./tool-change-records.js";

/** `163` 新增事件型（复用 `attribution_events`，**不新建表**）。 */
export const EVENT_TYPE_TOOL_CALL_OBSERVED = "tool_call.observed";

/** 工具调用素材槽位带基数（与单元槽位、`TOOL_CHANGE_SEQ_BASE=10_000_000` 不交）。 */
export const TOOL_CALL_OBSERVED_SEQ_BASE = 20_000_000;

export type ToolCallObservedExitStatus = "ok" | "error" | null;

export interface ToolCallObservedRecord {
  toolName: string;
  /** 命令原文（**落库不截断**；截断只在 consume 层发生）。 */
  commandSurface: string;
  /** 复用 `tool-change-records` 同一 `resultIsError` 信号（不新建第二份判断）。 */
  exitStatus: ToolCallObservedExitStatus;
  toolUseId: string;
  anchorMessageIndex: number;
  eventPos: number;
  turnSeq: number;
  /** 存储锚（带偏移；幂等键）。 */
  msgSeq: number;
  /** 与决策单元对齐用的槽位（`anchor×16 + 事件位`）。 */
  unitSlotSeq: number;
  /** 可锚到的 `unit_id` 列表（锚不到 ⇒ `[]`）。 */
  units: string[];
}

/**
 * 从消息面派生工具调用素材（纯函数；零 IO）。
 *
 * 与 `deriveToolChangeRecords` 同款：增量下界 `minIndex`（一次回看）、窗口末条不落
 * （结果在途 ⇒ 不落半成品）。只收 `commandSurfaceTextOf` 非空**且** key 未命中的 shell 调用。
 */
export function deriveToolCallObserved(
  messages: unknown[],
  protocol: Protocol,
  units: readonly UnitAnchorRef[] = [],
  opts: { minIndex?: number } = {},
): ToolCallObservedRecord[] {
  const msgs = normalizeMessages(messages, protocol);
  const turnSeqs = deriveSegmentTurnSeqs(messages, 0, protocol);

  // tool_result 配对（tool_use_id ⇒ is_error）：只用于 `exit_status` 归一，不留结果正文。
  const resultIsError = new Map<string, boolean | undefined>();
  for (const m of msgs) {
    for (const r of m.toolResults) {
      if (r.toolUseId.length > 0) resultIsError.set(r.toolUseId, r.isError);
    }
  }

  const unitsBySlot = new Map<string, string[]>();
  for (const u of units) {
    const key = `${u.turnSeq}\u0000${u.msgSeq}`;
    const arr = unitsBySlot.get(key);
    if (arr) arr.push(u.unitId);
    else unitsBySlot.set(key, [u.unitId]);
  }

  const out: ToolCallObservedRecord[] = [];
  const lastMessageIndex = messages.length - 1;
  const minIndex = opts.minIndex ?? 0;
  for (const m of msgs) {
    if (m.index < minIndex) continue; // 增量下界（同单元的水位语义；重放仍有幂等键兜底）
    for (const ev of m.events) {
      if (ev.kind !== "tool_use") continue;
      const surface = commandSurfaceTextOf(ev.tool.name, ev.tool.args);
      if (!surface) continue; // 非命令面（Read/Glob 等）⇒ 不产
      // key_tool 命中的命令已是决策单元（decision_unit.created）⇒ 不重复记录。
      if (matchKeyToolFirst(surface)) continue;
      // "窗口末条不落"（与 key_tool_call 同款纪律：结果在途 ⇒ 不落半成品）。
      if (m.index >= lastMessageIndex) continue;

      const turnSeq = turnSeqs[m.index] ?? 0;
      const unitSlotSeq = m.index * DECISION_SLOTS_PER_MESSAGE + ev.eventPos;
      const isErr = ev.tool.id.length > 0 ? resultIsError.get(ev.tool.id) : undefined;

      out.push({
        toolName: ev.tool.name,
        commandSurface: surface,
        exitStatus: isErr === undefined ? null : isErr ? "error" : "ok",
        toolUseId: ev.tool.id,
        anchorMessageIndex: m.index,
        eventPos: ev.eventPos,
        turnSeq,
        msgSeq: TOOL_CALL_OBSERVED_SEQ_BASE + unitSlotSeq,
        unitSlotSeq,
        units: unitsBySlot.get(`${turnSeq}\u0000${unitSlotSeq}`) ?? [],
      });
    }
  }
  return out;
}

/** `163`：payload（`toolUseId` 供 worker 去重；`command_surface` 落库不截断）。 */
export function toolCallObservedPayload(r: ToolCallObservedRecord): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    tool: r.toolName,
    command_surface: r.commandSurface,
    toolUseId: r.toolUseId,
  };
  if (r.exitStatus !== null) payload.exit_status = r.exitStatus;
  payload.units = r.units;
  return payload;
}
