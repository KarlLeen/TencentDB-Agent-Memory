/**
 * S3 决策单元抽取器 —— 纯函数核心（零 IO、零 session 状态）。
 * docs/implementation/30-decision-unit-extractor.md §4 / §5.1 的实现。
 *
 * 设计要点（与 spec 的 2026-09-08 澄清一致）：
 *  - 全量消息推导 + `minIndex` 边界过滤：code/key 单元以"末次 edit / tool_use 所在
 *    消息下标"，restraint 以"链闭合的人类消息下标"作为密封边界；只回吐密封边界
 *    `>= minIndex` 的单元（水位线语义 = 上轮末消息 index 起一轮 lookback）。跨窗口
 *    连续 code run（锚点可能在窗口外）因此不会被漏。
 *  - restraint 的"链内 risky 执行未发生"用与 key_tool_call 推导**同一个**
 *    `findPairedResult` helper 数据扫描（单一配对结论源，跨轮 pending 不漂移），
 *    再交给 `classifyRestraint`（B3 的 API 契约不变，只看列表里有没有 success）。
 */
import { createHash } from "node:crypto";

import { countHumanTurns, isHumanUserContent } from "../turnSeq.js";
import {
  commandSurfaceTextOf,
  isFileEditTool,
  matchHumanSeeds,
  matchKeyToolFirst,
  matchRiskyToolLabels,
} from "./vocab.js";
import {
  DECISION_SLOTS_PER_MESSAGE,
  DECISION_UNIT_VERSION,
  TEXT_SNIPPET_MAX,
  TEXT_TOTAL_MAX,
} from "./types.js";
import type {
  CodeEditSnippet,
  DecisionUnitPayload,
  KeyToolResultStatus,
  Protocol,
  SealedDecisionUnit,
} from "./types.js";

// ── Canonical 消息模型 ─────────────────────────────────────────────────────────

export interface CanonicalToolUse {
  id: string;
  name: string;
  args: Record<string, unknown>;
  argsText: string; // JSON.stringify(args)，匹配面
}

export interface CanonicalToolResult {
  toolUseId: string;
  isError: boolean | undefined;
  text: string;
}

export type CanonicalEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; eventPos: number; tool: CanonicalToolUse }
  | { kind: "tool_result"; result: CanonicalToolResult };

export interface CanonicalMessage {
  index: number; // 原始 messages[] 下标
  role: string;
  isHuman: boolean; // user 且含非 system-reminder 文本
  events: CanonicalEvent[];
  toolUses: CanonicalToolUse[];
  toolResults: CanonicalToolResult[];
  /** assistant 文本（同消息多段拼接），供 rationaleText / 证据文本。 */
  assistantText: string;
  /** 人类输入原文（user human 文本拼接，restraint 候选面）。 */
  humanText: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = asRecord(block);
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      // content 也可能是嵌套 {text} 结构（tool_result 内容块里再包一层）
      else if (b.text !== undefined && typeof b.text === "string") parts.push(b.text);
    }
    return parts.join("\n");
  }
  return "";
}

function isTextBlock(block: unknown): block is { type: "text"; text?: unknown } {
  const b = asRecord(block);
  return b.type === "text";
}

function isToolUseBlock(block: unknown): block is { type: "tool_use"; id?: unknown; name?: unknown; input?: unknown } {
  const b = asRecord(block);
  return b.type === "tool_use";
}

function isToolResultBlock(block: unknown): block is { type: "tool_result"; tool_use_id?: unknown; is_error?: unknown; content?: unknown } {
  const b = asRecord(block);
  return b.type === "tool_result";
}

function toolUseFromBlock(block: { type: "tool_use"; id?: unknown; name?: unknown; input?: unknown }): CanonicalToolUse {
  const args = asRecord(block.input);
  const id = typeof block.id === "string" ? block.id : "";
  const name = typeof block.name === "string" ? block.name : "";
  return { id, name, args, argsText: JSON.stringify(args) };
}

/** 把任一消息归一化为 canonical（protocol 只影响 countHumanTurns 语义，解析形状两协议通用）。 */
export function normalizeMessages(messages: unknown[], _protocol: Protocol): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = asRecord(messages[i]);
    const role = typeof m.role === "string" ? m.role : "";
    const entry: CanonicalMessage = {
      index: i,
      role,
      isHuman: false,
      events: [],
      toolUses: [],
      toolResults: [],
      assistantText: "",
      humanText: "",
    };
    const content = m.content;
    const contentIsString = typeof content === "string";

    if (role === "assistant") {
      // anthropic: content blocks；openai: content string + 顶层 tool_calls
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isTextBlock(block)) {
            entry.events.push({ kind: "text", text: contentToText(block.text) });
          } else if (isToolUseBlock(block)) {
            const tool = toolUseFromBlock(block);
            entry.events.push({ kind: "tool_use", eventPos: entry.events.length, tool });
            entry.toolUses.push(tool);
          }
        }
      } else if (contentIsString && content.length > 0) {
        entry.events.push({ kind: "text", text: content as string });
      }
      // openai tool_calls（content 常为 null + 顶层 tool_calls）
      if (Array.isArray(m.tool_calls)) {
        for (const call of m.tool_calls) {
          const c = asRecord(call);
          const fn = asRecord(c.function);
          const id = typeof c.id === "string" ? c.id : "";
          const name = typeof fn.name === "string" ? fn.name : "";
          let args: Record<string, unknown> = {};
          if (typeof fn.arguments === "string") {
            try {
              const parsed = JSON.parse(fn.arguments) as unknown;
              args = asRecord(parsed);
            } catch {
              args = { raw: fn.arguments };
            }
          } else {
            args = asRecord(fn.arguments);
          }
          const tool: CanonicalToolUse = { id, name, args, argsText: JSON.stringify(args) };
          entry.events.push({ kind: "tool_use", eventPos: entry.events.length, tool });
          entry.toolUses.push(tool);
        }
      }
      entry.assistantText = entry.events
        .filter((e): e is { kind: "text"; text: string } => e.kind === "text")
        .map((e) => e.text)
        .join("\n");
      out.push(entry);
      continue;
    }

    if (role === "user") {
      entry.isHuman = isHumanUserContent(content);
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isTextBlock(block)) {
            const text = contentToText(block.text);
            entry.events.push({ kind: "text", text });
            if (!text.startsWith("<system-reminder>")) entry.humanText += text;
          } else if (isToolResultBlock(block)) {
            const result: CanonicalToolResult = {
              toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
              isError: block.is_error === true ? true : block.is_error === false ? false : undefined,
              text: contentToText(block.content),
            };
            entry.events.push({ kind: "tool_result", result });
            entry.toolResults.push(result);
          }
        }
      } else if (contentIsString) {
        const text = content as string;
        entry.events.push({ kind: "text", text });
        if (entry.isHuman) entry.humanText = text;
      }
      out.push(entry);
      continue;
    }

    if (role === "tool") {
      // openai 工具结果：独立 role=tool 消息
      const result: CanonicalToolResult = {
        toolUseId: typeof m.tool_call_id === "string" ? m.tool_call_id : "",
        isError: undefined,
        text: contentToText(content),
      };
      entry.events.push({ kind: "tool_result", result });
      entry.toolResults.push(result);
      out.push(entry);
      continue;
    }

    // system / developer / 未知 role：不进任何推导面
    out.push(entry);
  }
  return out;
}

// ── 结果配对与状态（单一数据源）───────────────────────────────────────────────

/** 在 index > afterIndex 的后续消息里找首个配对 tool_result（保持消息序）。 */
export function findPairedResult(
  messages: CanonicalMessage[],
  afterIndex: number,
  toolUseId: string,
): CanonicalToolResult | undefined {
  if (!toolUseId) return undefined;
  for (const msg of messages) {
    if (msg.index <= afterIndex) continue;
    for (const r of msg.toolResults) {
      if (r.toolUseId === toolUseId) return r;
    }
  }
  return undefined;
}

function truncate(text: string, max = TEXT_SNIPPET_MAX): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

/** 只按配对结果的 is_error / 粗字段判状态，不看语义（spec §4.7）。 */
function resultStatusOf(result: CanonicalToolResult): KeyToolResultStatus {
  let isError = result.isError;
  if (isError === undefined) {
    const trimmed = result.text.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length <= 4096) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const isErr = asRecord(parsed).is_error;
        if (typeof isErr === "boolean") isError = isErr;
      } catch {
        // 非 JSON 一律视为无错误信号 → success（文中有内容）
      }
    }
  }
  if (isError === true) return "error";
  return result.text.length > 0 ? "success" : "unknown";
}

// ── 文件 run 合并（code_change）───────────────────────────────────────────────

interface FileEditRun {
  filePath: string;
  edits: Array<{ messageIndex: number; tool: CanonicalToolUse; paramKey: string; text: string; eventPos: number }>;
  anchorMessageIndex: number;
  tailMessageIndex: number;
  /** 尾 edit 是否是该消息的最后一个事件（true 且消息为窗口最后一条 ⇒ 尚未密封）。 */
  tailIsMessageEnd: boolean;
  /** run 首次出现的 eventPos（同锚点排序用）。 */
  firstEventPos: number;
}

function filePathOf(args: Record<string, unknown>): string | undefined {
  for (const key of ["file_path", "path", "filePath", "filename", "file"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return undefined;
}

function editParamOf(args: Record<string, unknown>): { paramKey: string; text: string } {
  for (const key of ["content", "text", "new_string", "old_string"]) {
    const v = args[key];
    if (typeof v === "string") return { paramKey: key, text: v };
  }
  // MultiEdit 的 edits[] 形式
  if (Array.isArray(args.edits) && (args.edits as unknown[]).length > 0) {
    const first = asRecord((args.edits as unknown[])[0]);
    for (const key of ["new_string", "old_string"]) {
      const v = first[key];
      if (typeof v === "string") return { paramKey: key, text: v };
    }
  }
  return { paramKey: "args", text: JSON.stringify(args) };
}

function isFileEditToolWithPath(tool: CanonicalToolUse): { filePath: string; paramKey: string; text: string } | null {
  if (!isFileEditTool(tool.name)) return null;
  const filePath = filePathOf(tool.args);
  if (!filePath) return null;
  const { paramKey, text } = editParamOf(tool.args);
  return { filePath, paramKey, text };
}

function closeFileRuns(
  runs: FileEditRun[],
  cur: { filePath: string; edits: FileEditRun["edits"]; firstEventPos: number } | null,
): void {
  if (!cur) return;
  const last = cur.edits[cur.edits.length - 1];
  runs.push({
    filePath: cur.filePath,
    edits: cur.edits,
    anchorMessageIndex: cur.edits[0].messageIndex,
    tailMessageIndex: last.messageIndex,
    tailIsMessageEnd: false, // 兜底：合并结束后统一由消息事件数重算
    firstEventPos: cur.firstEventPos,
  });
}

/** 每条 assistant 消息内按"非编辑工具中断"切出的连续文件 streak。 */
function computeMessageStreaks(msg: CanonicalMessage): Array<{ filePath: string; edits: FileEditRun["edits"] }> {
  const streaks: Array<{ filePath: string; edits: FileEditRun["edits"] }> = [];
  let cur: { filePath: string; edits: FileEditRun["edits"] } | null = null;
  for (const ev of msg.events) {
    if (ev.kind !== "tool_use") continue;
    const parsed = isFileEditToolWithPath(ev.tool);
    if (!parsed) {
      cur = null; // 非文件编辑工具 → 中断连续
      continue;
    }
    const item = { messageIndex: msg.index, tool: ev.tool, paramKey: parsed.paramKey, text: parsed.text, eventPos: ev.eventPos };
    if (cur && cur.filePath === parsed.filePath) {
      cur.edits.push(item);
    } else {
      cur = { filePath: parsed.filePath, edits: [item] };
      streaks.push(cur);
    }
  }
  return streaks;
}

/**
 * 同窗口内把连续同文件 file-run 合并：
 *   - 同一条 assistant 消息内：中间没有被非文件编辑工具/不同文件打断的 edit 属于同一 run；
 *   - 跨相邻 assistant 消息（中间没有任何 user/tool/system 消息）：同文件延续合并。
 * 返回的 run 不含"是否密封"判断（seal 由 derive 阶段结合窗口尾部计算）。
 */
export function mergeFileRuns(messages: CanonicalMessage[]): FileEditRun[] {
  const runs: FileEditRun[] = [];
  let cur: { filePath: string; edits: FileEditRun["edits"]; firstEventPos: number } | null = null;

  const messagesByIndex = new Map(messages.map((m) => [m.index, m]));

  for (const msg of messages) {
    const streaks = computeMessageStreaks(msg);
    let cursor = 0;

    // 跨相邻 assistant 消息延续：cur 尾消息恰为 msg 前一条 & 无中间消息（严格 index+1）
    if (cur) {
      const curTailMsg = messagesByIndex.get(cur.edits[cur.edits.length - 1].messageIndex);
      const tailIsMessageEnd =
        !!curTailMsg &&
        cur.edits[cur.edits.length - 1].eventPos === curTailMsg.events.length - 1;
      const canExtend =
        msg.role === "assistant" &&
        msg.index === cur.edits[cur.edits.length - 1].messageIndex + 1 &&
        tailIsMessageEnd &&
        streaks.length > 0 &&
        streaks[0].filePath === cur.filePath;
      if (canExtend) {
        cur.edits.push(...streaks[0].edits);
        cursor = 1;
      } else {
        closeFileRuns(runs, cur);
        cur = null;
      }
    }

    for (let s = cursor; s < streaks.length; s += 1) {
      const streak = streaks[s];
      if (!cur) {
        cur = { filePath: streak.filePath, edits: [...streak.edits], firstEventPos: streak.edits[0]?.eventPos ?? 0 };
      } else {
        closeFileRuns(runs, cur);
        cur = { filePath: streak.filePath, edits: [...streak.edits], firstEventPos: streak.edits[0]?.eventPos ?? 0 };
      }
    }
    // 若本消息是非 assistant 角色消息，cur 不再可跨出（但保留在 runs 中由下一轮检查自然关闭）
  }
  closeFileRuns(runs, cur);

  // 重算每个 run 的 tailIsMessageEnd（跨消息合并后由实际尾 edit 所在消息决定）
  for (const run of runs) {
    const last = run.edits[run.edits.length - 1];
    const tailMsg = messagesByIndex.get(last.messageIndex);
    run.tailIsMessageEnd = !!tailMsg && last.eventPos === tailMsg.events.length - 1;
  }
  return runs;
}

// ── 文本证据 helper ───────────────────────────────────────────────────────────

/** run 首个 edit 前最近的 assistant 文本（先看锚点消息内，再看往前最近的 assistant 文本）。 */
function rationaleOf(run: FileEditRun, messages: CanonicalMessage[]): string | undefined {
  const first = run.edits[0];
  const anchorMsg = messages.find((m) => m.index === first.messageIndex);
  if (anchorMsg) {
    for (const ev of anchorMsg.events.slice(0, first.eventPos).reverse()) {
      if (ev.kind === "text" && ev.text.trim().length > 0) return truncate(ev.text.trim());
    }
  }
  // 往前找最近的 assistant 文本（含同一条消息里 edit 之后的 text 不算）
  for (let i = anchorMsg ? messages.indexOf(anchorMsg) - 1 : messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === "assistant" && m.assistantText.trim().length > 0) {
      return truncate(m.assistantText.trim());
    }
  }
  return undefined;
}

function truncatedTextsOf(items: string[]): { texts: string[]; truncatedTotal: boolean } {
  const texts: string[] = [];
  let total = 0;
  let truncatedTotal = false;
  for (const item of items) {
    if (total >= TEXT_TOTAL_MAX) {
      truncatedTotal = true;
      break;
    }
    const remaining = Math.max(0, TEXT_TOTAL_MAX - total);
    const t = truncate(item).slice(0, Math.min(item.length, remaining));
    total += t.length;
    texts.push(t);
    // 单段被 4000 钳制，或多段合计被 16000 截断 → 诚实标注 truncatedTotal。
    if (item.length > t.length) truncatedTotal = true;
  }
  return { texts, truncatedTotal };
}

// ── restraint 判定（B3 API）───────────────────────────────────────────────────

export interface RestraintCandidate {
  anchorMessageIndex: number;
  rawText: string; // 原始人类消息文本（匹配面，未截断）
  matchedSeeds: string[];
  matchedCommands: string[];
}

export interface RestraintVerdict {
  kind: "restraint";
  responseEvidence: {
    rationaleText?: string;
    clarifyingQuestion: boolean;
    safeAlternativeTools: string[];
  };
}

/**
 * B3：restraint 链内 risky 执行判定直接以入参 `sealedRiskyKeyToolCalls` 是否含
 * `resultStatus="success"` 条目为准（不做二次扫描）。error / unknown 不算已执行成功。
 * 只返回"未发生成功执行"时的证据（有 success 则返回 null）。
 */
export function classifyRestraint(
  _candidate: RestraintCandidate,
  chain: CanonicalMessage[],
  sealedRiskyKeyToolCalls: Array<{ toolUseId: string; resultStatus: KeyToolResultStatus }>,
): RestraintVerdict | null {
  if (sealedRiskyKeyToolCalls.some((r) => r.resultStatus === "success")) return null;

  const assistantTexts = chain
    .filter((m) => m.role === "assistant" && m.assistantText.trim().length > 0)
    .map((m) => m.assistantText.trim());
  const { texts } = truncatedTextsOf(assistantTexts);
  const rationaleText = texts.length > 0 ? texts[0] : undefined;
  const joined = texts.join("\n");

  const tail = texts[texts.length - 1] ?? "";
  const clarifyingQuestion =
    tail.length > 0 &&
    (/[?？]\s*$/.test(tail) ||
      /确认|批准|审核|approve|confirm|可以吗|要不要/.test(tail) ||
      /\b(?:shall|should|may) i\b/i.test(tail));

  const safeAlternativeTools: string[] = [];
  for (const m of chain) {
    if (m.role !== "assistant") continue;
    for (const tool of m.toolUses) {
      // 命令面门控 + 解码串判定：非命令面工具（Edit/Write/Read…）不算 risky 执行，
      // 而是"链内实际采取的安全替代手段"。
      const surface = commandSurfaceTextOf(tool.name, tool.args);
      const risky = surface ? matchRiskyToolLabels(surface) : [];
      if (risky.length === 0 && tool.name.trim().length > 0) {
        if (!safeAlternativeTools.includes(tool.name)) safeAlternativeTools.push(tool.name);
      }
    }
  }

  return {
    kind: "restraint",
    responseEvidence: {
      ...(rationaleText !== undefined ? { rationaleText: truncate(rationaleText) } : {}),
      clarifyingQuestion,
      safeAlternativeTools,
    },
  };
}

// ── unit_id（§4.6 内容哈希）───────────────────────────────────────────────────

export function computeUnitId(kind: string, essenceParts: unknown[]): string {
  const hex = createHash("sha1").update(JSON.stringify([kind, ...essenceParts])).digest("hex");
  return `du_${hex.slice(0, 12)}`;
}

// ── 顶层推导 ──────────────────────────────────────────────────────────────────

export interface DeriveDecisionUnitOptions {
  /** 密封边界过滤：只回吐 sealMessageIndex >= minIndex 的单元（水位线 lookback 语义）。默认 0。 */
  minIndex?: number;
}

function buildCodeSnippets(run: FileEditRun): CodeEditSnippet[] {
  const snippets: CodeEditSnippet[] = [];
  let total = 0;
  for (const edit of run.edits) {
    // 单段 4000 与合计 16000 双钳制；但**每次 edit 的 tool_use 身份都要保留**（§4.3）：
    // 超预算后的 edit 以 text:"" + chars=原文长度 的"身份痕迹"入列，绝不整段丢弃
    // （F2：原实现对合计超限即 break，后续 tool_use.id 从 payload 消失，unit essence
    // 与 payload 证据脱钩）。text.length < chars 即"被钳制的诚实标注"。
    const budget = Math.max(0, TEXT_TOTAL_MAX - total);
    const text = budget > 0 ? edit.text.slice(0, Math.min(TEXT_SNIPPET_MAX, budget)) : "";
    total += text.length;
    snippets.push({
      toolUseId: edit.tool.id,
      toolName: edit.tool.name,
      paramKey: edit.paramKey,
      text,
      chars: edit.text.length,
    });
  }
  return snippets;
}

interface UnitSeed {
  kind: "code_change" | "key_tool_call";
  anchorMessageIndex: number;
  kindRank: number; // 0 code, 1 key —— 同锚点先 code 后 key
  seq: number; // 消息内出现序（排序确定）
  sealMessageIndex: number;
  payloadParts: () => { payload: DecisionUnitPayload; essence: unknown[] };
}

function isRunSealed(run: FileEditRun, lastMessageIndex: number): boolean {
  // run 尾 edit 在"窗口最后一条消息的末尾"才可能被后续轮延长 → 不算密封
  if (run.tailMessageIndex === lastMessageIndex && run.tailIsMessageEnd) return false;
  return true;
}

/**
 * 主入口：推导当前消息窗口内**密封**的决策单元。
 * 内部保持确定性：同锚点消息内排序 = code_change（file-run 出现序）→ key_tool_call（tool_use 出现序）。
 */
export function deriveDecisionUnits(
  rawMessages: unknown[],
  protocol: Protocol,
  options: DeriveDecisionUnitOptions = {},
): SealedDecisionUnit[] {
  const minIndex = Math.max(0, Math.floor(options.minIndex ?? 0));
  const messages = normalizeMessages(rawMessages, protocol);
  const lastMessageIndex = messages.length > 0 ? messages[messages.length - 1].index : -1;

  // 1) code_change（密封的 run）
  const codeSeeds: UnitSeed[] = [];
  for (const run of mergeFileRuns(messages)) {
    if (!isRunSealed(run, lastMessageIndex)) continue;
    const anchor = run.anchorMessageIndex;
    const snippets = buildCodeSnippets(run);
    if (snippets.length === 0) continue;
    const rationale = rationaleOf(run, messages);
    codeSeeds.push({
      kind: "code_change",
      anchorMessageIndex: anchor,
      kindRank: 0,
      seq: run.firstEventPos,
      sealMessageIndex: run.tailMessageIndex,
      payloadParts: () => {
        const essence = [
          "code_change",
          run.filePath,
          ...run.edits.map((e) => [e.tool.id, e.tool.name, e.paramKey, truncate(e.text)]),
        ];
        return {
          essence,
          payload: {
            version: DECISION_UNIT_VERSION,
            unitType: "code_change",
            unitId: "",
            protocol,
            anchorMessageIndex: anchor,
            turnSeq: 0,
            filePath: run.filePath,
            ...(rationale !== undefined ? { rationaleText: rationale } : {}),
            edits: snippets,
          } as DecisionUnitPayload,
        };
      },
    });
  }

  // 2) key_tool_call（配对结果已出现的才密封；候选面 = 命令面，见 vocab.commandSurfaceTextOf）
  const keySeeds: UnitSeed[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const ev of msg.events) {
      if (ev.kind !== "tool_use") continue;
      const tool = ev.tool;
      // N1 门控：Edit/Write/Read 等非命令面工具的内容/读面整段不进 key 候选
      // （文件里写 "git push origin main" 不是"push 已执行"）。
      const surface = commandSurfaceTextOf(tool.name, tool.args);
      if (!surface) continue;
      // N2：在解码后的命令串上匹配（真换行），不在 JSON 转义串上做 \b 正则。
      const matchedBy = matchKeyToolFirst(surface);
      if (!matchedBy) continue;
      const paired = findPairedResult(messages, msg.index, tool.id);
      if (!paired) continue; // 结果未到 → 未密封（宁缺不伪造，spec §9 开放问题 5）
      const status = resultStatusOf(paired);
      const toolParam = truncate(surface);
      const resultSnippet = truncate(paired.text, 2000);
      keySeeds.push({
        kind: "key_tool_call",
        anchorMessageIndex: msg.index,
        kindRank: 1,
        seq: ev.eventPos,
        sealMessageIndex: msg.index,
        payloadParts: () => {
          const essence = ["key_tool_call", tool.id, tool.name, matchedBy, toolParam];
          return {
            essence,
            payload: {
              version: DECISION_UNIT_VERSION,
              unitType: "key_tool_call",
              unitId: "",
              protocol,
              anchorMessageIndex: msg.index,
              turnSeq: 0,
              toolUseId: tool.id,
              toolName: tool.name,
              toolParamText: toolParam,
              chars: surface.length,
              matchedBy,
              resultStatus: status,
              ...(resultSnippet.length > 0 ? { resultSnippet } : {}),
            } as DecisionUnitPayload,
          };
        },
      });
    }
  }

  // 3) restraint（链闭合 + 链内无 risky success 才密封）
  const restraintSeeds: Array<{
    candidate: RestraintCandidate;
    closureIndex: number;
    chain: CanonicalMessage[];
    verdict: RestraintVerdict;
  }> = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!(msg.role === "user" && msg.isHuman)) continue;
    const matchedSeeds = matchHumanSeeds(msg.humanText);
    const matchedCommands = matchRiskyToolLabels(msg.humanText);
    if (matchedSeeds.length === 0 && matchedCommands.length === 0) continue;

    // 找到下一条人类消息（链闭合点）
    let closureIdx = -1;
    for (let j = i + 1; j < messages.length; j += 1) {
      if (messages[j].role === "user" && messages[j].isHuman) {
        closureIdx = messages[j].index;
        break;
      }
    }
    if (closureIdx < 0) continue; // 未闭合 → 本窗口不产（后续窗口自动补）

    const chain = messages.slice(i + 1, messages.findIndex((m) => m.index === closureIdx));
    if (chain.length === 0) continue; // 响应链为空（候选即窗口最后内容）→ 不成立
    // 链内 risky 工具的成功执行状态 —— 用与 key 推导同一 findPairedResult（B3 单源），
    // 且链扫同样只认命令面工具（N1：把命令写进文件不是"已执行"）。
    const sealedRiskyInChain: Array<{ toolUseId: string; resultStatus: KeyToolResultStatus }> = [];
    let chainTorn = false;
    for (const cm of chain) {
      if (cm.role !== "assistant") continue;
      for (const tool of cm.toolUses) {
        const surface = commandSurfaceTextOf(tool.name, tool.args);
        if (!surface) continue;
        if (matchRiskyToolLabels(surface).length === 0) continue;
        const paired = findPairedResult(messages, cm.index, tool.id);
        if (paired) {
          sealedRiskyInChain.push({ toolUseId: tool.id, resultStatus: resultStatusOf(paired) });
        } else {
          // N3：链内 risky 工具出现但其结果缺失/未达（撕裂窗口）→ 无法证明"未执行"，
          // 本轮不产 restraint（与 key 侧"宁缺不伪造"同一口径，宁可等结果补上由
          // key_tool_call 记录真实执行）。
          chainTorn = true;
        }
      }
    }
    if (chainTorn) continue;
    const candidate: RestraintCandidate = {
      anchorMessageIndex: msg.index,
      rawText: msg.humanText,
      matchedSeeds,
      matchedCommands,
    };
    const verdict = classifyRestraint(candidate, chain, sealedRiskyInChain);
    if (!verdict) continue;
    restraintSeeds.push({ candidate, closureIndex: closureIdx, chain, verdict });
  }

  // 4) 组装：同锚点排序（code 先于 key）+ slot 分配 + 16 钳制 + 密封边界过滤
  const byAnchor = new Map<number, UnitSeed[]>();
  for (const seed of [...codeSeeds, ...keySeeds]) {
    const list = byAnchor.get(seed.anchorMessageIndex) ?? [];
    list.push(seed);
    byAnchor.set(seed.anchorMessageIndex, list);
  }

  const sealed: SealedDecisionUnit[] = [];
  const turnMemo = new Map<number, number>();
  const turnSeqOf = (anchor: number): number => {
    const existing = turnMemo.get(anchor);
    if (existing !== undefined) return existing;
    const count = countHumanTurns(rawMessages.slice(0, anchor + 1), protocol);
    turnMemo.set(anchor, count);
    return count;
  };

  for (const [anchor, list] of byAnchor) {
    // 排序：code（rank 0）→ key（rank 1），同 rank 按出现序
    list.sort((a, b) => (a.kindRank !== b.kindRank ? a.kindRank - b.kindRank : a.seq - b.seq));
    const kept = list.slice(0, DECISION_SLOTS_PER_MESSAGE);
    const overflowed = list.length > DECISION_SLOTS_PER_MESSAGE;
    kept.forEach((seed, slot) => {
      if (seed.sealMessageIndex < minIndex) return;
      const { payload, essence } = seed.payloadParts();
      const unitId = computeUnitId(seed.kind, essence);
      const built: DecisionUnitPayload = {
        ...payload,
        unitId,
        turnSeq: turnSeqOf(anchor),
        ...(overflowed && slot === DECISION_SLOTS_PER_MESSAGE - 1 ? { overflowed: true } : {}),
      } as DecisionUnitPayload;
      sealed.push({
        kind: seed.kind,
        unitId,
        anchorMessageIndex: anchor,
        unitSlot: slot,
        msgSeq: anchor * DECISION_SLOTS_PER_MESSAGE + slot,
        turnSeq: turnSeqOf(anchor),
        sealMessageIndex: seed.sealMessageIndex,
        overflowed,
        payload: built,
      });
    });
    if (overflowed) {
      console.warn(
        `[decision-unit] anchor message ${anchor} produced ${list.length} units — keeping first ${DECISION_SLOTS_PER_MESSAGE} (spec §4.5 clamp)`,
      );
    }
  }

  // restraint：slot 恒 0（锚定人类消息，天然不冲突）
  // 密封边界 = 链闭合消息必须在本轮**新到达**（>= 水位线）。runner 只给 minIndex =
  // watermark-1，故闭合判定用 minIndex+1 —— 否则上一轮末消息闭合的 restraint 会在
  // 后续每轮被误判为新密封而重复落库（code/key 无此问题：tail 必须轮后才可密封）。
  for (const { candidate, closureIndex, verdict } of restraintSeeds) {
    if (closureIndex < minIndex + 1) continue;
    const anchor = candidate.anchorMessageIndex;
    const essence = ["restraint", ...candidate.matchedSeeds, ...candidate.matchedCommands, truncate(candidate.rawText)];
    const unitId = computeUnitId("restraint", essence);
    const payload: DecisionUnitPayload = {
      version: DECISION_UNIT_VERSION,
      unitType: "restraint",
      unitId,
      protocol,
      anchorMessageIndex: anchor,
      turnSeq: turnSeqOf(anchor),
      matchedSeeds: candidate.matchedSeeds,
      matchedCommands: candidate.matchedCommands,
      riskyCandidateText: truncate(candidate.rawText),
      responseEvidence: {
        ...(verdict.responseEvidence.rationaleText !== undefined
          ? { rationaleText: verdict.responseEvidence.rationaleText }
          : {}),
        clarifyingQuestion: verdict.responseEvidence.clarifyingQuestion,
        safeAlternativeTools: verdict.responseEvidence.safeAlternativeTools,
        riskyExecuted: false,
      },
    };
    sealed.push({
      kind: "restraint",
      unitId,
      anchorMessageIndex: anchor,
      unitSlot: 0,
      msgSeq: anchor * DECISION_SLOTS_PER_MESSAGE + 0,
      turnSeq: turnSeqOf(anchor),
      sealMessageIndex: closureIndex,
      overflowed: false,
      payload,
    });
  }

  return sealed;
}
