/**
 * `149 · C2/C3/C4`：**变更 / 结果锚定记录** —— 从 extractor 的 canonical 消息面**直接派生**
 * （**不依赖档②**；依据 `149 · C1` 成因结论：档② 只归档"有可见文本"的行，纯 `tool_use` 的
 * 助手轮 fp 为空 ⇒ 不入档 ⇒ 档② 拿不到工具名）。
 *
 * 三条纪律（`149` 契约）：
 * 1. **C3 payload 逐字限定 6 键**：`tool` / `kind` / `path_ext` / `path_sha16` / `exit_status` /
 *    `units` —— 不得多、不得少。**命令原文 / 路径原文 / diff / 工具入参出参一律不落**
 *    （路径只留 `path_sha16`（sha256 前 16）+ 扩展名；`kind` 是**枚举**；`exit_status` 只取
 *    配对 `tool_result` 的 `is_error` 归一值，**不解析原始退出码**）。
 * 2. **C4 对齐**：单位 = 该工具调用所在的 `(turn_seq, msg_seq)`（`msg_seq = anchor×16 + 事件位`，
 *    与决策单元同一编码）⇒ 与 `decision_unit` 逐字对齐；**同一 unit 多变更 ⇒ 多条事件**；
 *    **锚不到 ⇒ `units: []`**（不强行挂）；**只读类工具不产**（`R2`）。
 * 3. **幂等**：变更行用**独立槽位带** `TOOL_CHANGE_SEQ_BASE + anchor×16 + 事件位` —— 与决策单元
 *    槽位（无偏移）**不相交**（`anchor < 625_000` 时），且复用 `idx_ae_unit_dedupe`
 *    （同请求重放 / 进程重启回看 ⇒ 唯一索引把重复行静默冲突，幂等免费继承）。
 *
 * ⚠️ `other` 是枚举**保留位、本线不产**：没有"确定属变更但无法归类"的工具被启用
 * ⇒ **不得**把它当变更计数（`R4`）。
 */
import { createHash } from "node:crypto";

import { deriveSegmentTurnSeqs } from "./message-increment-archive.js";
import { DECISION_SLOTS_PER_MESSAGE, type Protocol } from "./types.js";
import { normalizeMessages } from "./decision-unit-extractor.js";

/** `149` 新增事件型（复用 `attribution_events`，**不新建表**）。 */
export const EVENT_TYPE_AGENT_TOOL_CHANGE = "agent.tool.change";

/** 变更/结果类别（枚举；`other` 保留未启用 —— 见文件头注）。 */
export type ToolChangeKind = "edit" | "write" | "run_tests" | "lint" | "build" | "other";

/** 变更行槽位带基数（与决策单元槽位不交；`anchor < 625_000` 时两族 key 必不相等）。 */
export const TOOL_CHANGE_SEQ_BASE = 10_000_000;

// ── kind 映射（**唯一落点**；防两处各写一份）──────────────────────────────────────

/** 文件类工具（直接按工具名归类）。 */
const FILE_TOOL_KINDS: Readonly<Record<string, ToolChangeKind>> = {
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Write: "write",
};

/** shell 类工具名（命令串只在**内存里**匹配，原文不落任何地方）。 */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(["Bash", "Shell", "shell", "run_command"]);

/** 命令模式表（顺序即优先级：先测"跑测试"，再 lint，再 build）。 */
const COMMAND_KIND_PATTERNS: ReadonlyArray<{ kind: ToolChangeKind; re: RegExp }> = [
  {
    kind: "run_tests",
    re: /(^|[\s;&|])(npm|pnpm|yarn)\s+(run\s+)?(test|vitest|jest)\b|(^|[\s;&|])(vitest|jest|pytest|go\s+test|cargo\s+test|phpunit|rspec)\b/i,
  },
  {
    kind: "lint",
    re: /(^|[\s;&|])(eslint|ruff|flake8|pylint|golangci-lint|stylelint)\b|(^|[\s;&|])(npm|pnpm|yarn)\s+(run\s+)?lint\b|cargo\s+clippy\b/i,
  },
  {
    kind: "build",
    re: /(^|[\s;&|])(npm|pnpm|yarn)\s+(run\s+)?build\b|(^|[\s;&|])(tsc|vite\s+build|webpack|rollup|esbuild|make|cargo\s+build|go\s+build|gradle|mvn)\b/i,
  },
];

/**
 * 工具调用 → 变更/结果类别。**只读类 / 未知 / 无法归类 ⇒ `null`（不产）**：
 * `Read` / `Glob` / `Grep` / `WebFetch` / `Task` / … 一律不产（`R2`：只读类不得算变更）。
 */
export function classifyToolChange(toolName: string, args: Record<string, unknown>): ToolChangeKind | null {
  const direct = FILE_TOOL_KINDS[toolName];
  if (direct !== undefined) return direct;
  if (!SHELL_TOOL_NAMES.has(toolName)) return null;
  const command = typeof args.command === "string" ? args.command : "";
  if (command.length === 0) return null;
  for (const { kind, re } of COMMAND_KIND_PATTERNS) {
    if (re.test(command)) return kind;
  }
  return null; // 其它 shell 命令 ⇒ 不产（`other` 保留未启用）
}

/** 文件类工具的路径参数（`Edit`/`Write` 用 `file_path`；`NotebookEdit` 用 `notebook_path`）。 */
function pathArgOf(toolName: string, args: Record<string, unknown>): string | null {
  const key = toolName === "NotebookEdit" ? "notebook_path" : "file_path";
  const v = args[key] ?? args["file_path"];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** 扩展名（小写、去点；无扩展名 ⇒ `null`）。 */
export function pathExtOf(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? "";
  const i = base.lastIndexOf(".");
  if (i <= 0 || i === base.length - 1) return null;
  return base.slice(i + 1).toLowerCase();
}

// ── 记录派生 ──────────────────────────────────────────────────────────────────────

/** 决策单元锚点（与 `decision-unit-runner` 写入的 `(turnSeq, msgSeq)` 同源）。 */
export interface UnitAnchorRef {
  unitId: string;
  turnSeq: number;
  msgSeq: number;
}

export interface ToolChangeRecord {
  toolName: string;
  kind: ToolChangeKind;
  pathExt: string | null;
  pathSha16: string | null;
  exitStatus: "ok" | "error" | null;
  anchorMessageIndex: number;
  eventPos: number;
  turnSeq: number;
  /** 存储用锚（带偏移；幂等键）。 */
  msgSeq: number;
  /** 与决策单元对齐用的槽位（`anchor×16 + 事件位`）。 */
  unitSlotSeq: number;
  /** 可锚到的 `unit_id` 列表（按 `(turnSeq, unitSlotSeq)` 对齐；锚不到 ⇒ `[]`）。 */
  units: string[];
}

/**
 * 从消息面派生变更/结果记录（纯函数；零 IO）。
 *
 * @param units 本轮**已密封**的决策单元锚点（用于 `units` 列表；缺省 `[]` ⇒ 全部锚不到）。
 * @param opts.minIndex 增量下界（与 `deriveDecisionUnits` 同款水位语义：`max(0, watermark-1)`
 *   的一次回看）；低于该下界的工具调用不重复派生（重放靠幂等键兜底，不靠它）。
 */
export function deriveToolChangeRecords(
  messages: unknown[],
  protocol: Protocol,
  units: readonly UnitAnchorRef[] = [],
  opts: { minIndex?: number } = {},
): ToolChangeRecord[] {
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

  const out: ToolChangeRecord[] = [];
  const lastMessageIndex = messages.length - 1;
  const minIndex = opts.minIndex ?? 0;
  for (const m of msgs) {
    if (m.index < minIndex) continue; // 增量下界（同单元的水位语义；重放仍有幂等键兜底）
    for (const ev of m.events) {
      if (ev.kind !== "tool_use") continue;
      const kind = classifyToolChange(ev.tool.name, ev.tool.args);
      if (kind === null) continue;
      // "窗口末条不落"（与 `key_tool_call` 同款纪律：结果在途 ⇒ 不落半成品）：
      // 末条工具调用要么尚未密封（无 unit 可锚）、要么可能在本请求之后才密封 ⇒ 等到"有下一条消息"
      // 的那次请求再落 —— 否则会先落一条 `units: []`，随后单元密封却因幂等键冲突**永远学不到锚**。
      if (m.index >= lastMessageIndex) continue;

      const turnSeq = turnSeqs[m.index] ?? 0;
      const unitSlotSeq = m.index * DECISION_SLOTS_PER_MESSAGE + ev.eventPos;
      const path = pathArgOf(ev.tool.name, ev.tool.args);
      const isErr = ev.tool.id.length > 0 ? resultIsError.get(ev.tool.id) : undefined;

      out.push({
        toolName: ev.tool.name,
        kind,
        pathExt: path === null ? null : pathExtOf(path),
        pathSha16: path === null ? null : sha16(path),
        exitStatus: isErr === undefined ? null : isErr ? "error" : "ok",
        anchorMessageIndex: m.index,
        eventPos: ev.eventPos,
        turnSeq,
        msgSeq: TOOL_CHANGE_SEQ_BASE + unitSlotSeq,
        unitSlotSeq,
        units: unitsBySlot.get(`${turnSeq}\u0000${unitSlotSeq}`) ?? [],
      });
    }
  }
  return out;
}

/** sha256(utf8(text)) 前 16 位（路径只以此形态落库；原文不落）。 */
function sha16(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** `149 · C3`：payload **逐字限定 6 键**（缺值省略可选键；顺序 = 契约书写序）。 */
export function toolChangePayload(r: ToolChangeRecord): Record<string, unknown> {
  const payload: Record<string, unknown> = { tool: r.toolName, kind: r.kind };
  if (r.pathExt !== null) payload.path_ext = r.pathExt;
  if (r.pathSha16 !== null) payload.path_sha16 = r.pathSha16;
  if (r.exitStatus !== null) payload.exit_status = r.exitStatus;
  payload.units = r.units;
  return payload;
}
