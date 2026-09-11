/**
 * Bridge-side tool-call 埋点 helper（memory-bridge + skill-bridge 共用）。
 *
 * 设计：每次 upstream fetch 完成（成功或失败）都发一条 kind='bridge_call'。
 *      调用方负责把 body 脱敏到 <= 512 字节（本函数不再清洗），只做透传。
 *
 * 硬约束（§7.-1）：
 *   - 同步返回 void
 *   - sink 异常静默吞掉
 *   - body/sub 已由调用方准备好，绝不额外读 session store
 */
import { writeToolCallRow, type ToolCallLogInput } from "../clickhouse.js";

export interface BridgeCallTelemetryInput {
  sessionKey: string;
  turnSeq?: number;
  spaceId?: string;
  userId?: string;
  teamId?: string;
  agentId?: string;
  /** "claude-code" | "codebuddy" | "unknown" — 从 sessionKey 前缀反解 */
  agentSource: string;
  /** "memory-bridge" | "skill-bridge" */
  bridgeSource: string;
  /** 具体 sub 字符串（"atomic/search" / "skill/get" 等） */
  executedEndpoint: string;
  /** 已脱敏、已截断的 outbound body（<= 512 字节） */
  requestBody: string;
  /** upstream HTTP status（网络失败可传 0 或 502） */
  upstreamStatus: number;
  /** upstream 耗时毫秒 */
  elapsedMs: number;
  /**
   * 前置校验失败原因。空/未传 = 请求打到了上游（成功或 4xx/5xx）。
   * 非空 = proxy 前置早退，没到 fetcher。见 clickhouse.ts ToolCallLogInput 注释。
   */
  rejectReason?: string;
  /**
   * S4（P5）: LLM 原始请求体（**未脱敏、未截断**的已 parse 对象引用）。
   *
   * **仅供 sink 提取；绝不入 CH row、绝不落库、绝不打印** —— 见 BridgeFetchContext。
   * 为什么不能用 `requestBody`：那一列已被 `slice(0,512)`（F3），长 body 会静默
   * 取不到靠后的 `skill_id`，把"硬档"变成"假档"。
   */
  inboundBody?: Record<string, unknown>;
  /**
   * S4（P5）: 上游响应体**原文**（未截断）。fetch 失败 / 未响应时不传。
   *
   * **仅供 sink 提取；绝不入 CH row、绝不落库、绝不打印**。
   */
  responseText?: string;
  /**
   * S4（P5）: **归因域**会话键（bare，如 `conv-abc`）—— 由调用点用
   * `resolveConversationId(c)` 取值，与 `decision_unit.created` 同域。
   *
   * 与 `sessionKey` 的区别：`sessionKey` 是**埋点域**契约（composite
   * `claude-code:conv-abc`，与 `session_init_logs` 对齐，不能动）；本字段是
   * **归因域**裸键，供 S4 sink 落 `attribution_events.session_key`。两者不可混用，
   * 裁决见 `51-anchoring-decision-brief.md` §7.1。
   *
   * **仅供 sink 提取；绝不入 CH row、绝不落库、绝不打印** —— 见 BridgeFetchContext。
   */
  attributionSessionKey?: string;
}

/**
 * S4 提取上下文（P5 拍板）—— **只给 sink 用**。
 *
 * 为什么不挂在 `row` 上：`row`（`ToolCallLogInput`）是 ClickHouse 的契约输入
 * 对象，任何 sink 都可能整体持有它。把未脱敏的请求/响应原文塞进 `row`，等于把
 * 敏感原文混进 CH 契约（虽实测全仓无 `JSON.stringify(row)` / `console.log(row)`，
 * 但契约不干净、易被后人一行日志泄漏）⇒ 用**独立第 2 参**显式隔离（R9）：
 * 想泄漏必须显式写出来。
 *
 * 边界：ctx 只在 sink 内**当次**提取、用后即弃；脱敏/截断是 CH row 的义务，
 * 不是 ctx 的。绝不落库、绝不打印。
 */
export interface BridgeFetchContext {
  /** LLM 原始请求体（已 parse 的对象引用，未脱敏未截断） */
  inboundBody?: Record<string, unknown>;
  /** 上游响应体原文（未截断）；fetch 失败/未响应时为 undefined */
  responseText?: string;
  /**
   * **归因域**会话键（bare，如 `conv-abc`），与 `decision_unit.created` 同域。
   * 供 S4 sink 落 `attribution_events.session_key`；未传 = 逐字回退 `row.sessionKey`
   * （埋点域 composite）。**仅供 sink 提取；绝不落库、绝不打印。**
   */
  attributionSessionKey?: string;
}

/** S4 sink 签名：`(row, ctx)`。`ctx` 是独立第 2 参，**不进 row**（F14）。 */
export type BridgeTelemetrySink = (
  row: ToolCallLogInput,
  ctx: BridgeFetchContext,
) => void;

/**
 * S4：叠加式 sink 链（模块级）。
 *
 * 为什么是模块级而不是复用 emit 的第 2 参：`emitBridgeRejectTelemetry`
 * （17 处 reject 调用点）**不透传 sink**（F9/F16）⇒ 想在 reject 路径上也落行，
 * 只能挂模块级链。缺省不注册 = 零行为差异（toggle off 语义）。
 *
 * 顺序契约：默认 CH sink 先行，随后**依次**调链上各 sink；每个各自 try/catch
 * 吞异常 —— 一个 sink 抛不影响另一个，也绝不 throw 回业务。
 */
const _sinks: BridgeTelemetrySink[] = [];

/** 注册一个**叠加**sink（不是替换 CH）。toggle off ⇒ 不注册 ⇒ 零新行。 */
export function addBridgeTelemetrySink(sink: BridgeTelemetrySink): void {
  _sinks.push(sink);
}

/** 清空 sink 链（生产不用；测试 / 热重载用）。 */
export function clearBridgeTelemetrySinks(): void {
  _sinks.length = 0;
}

/** 重置 sink 链为初始态 —— 测试专用（照 visibleTextRepo/attributionEventRepo 惯例）。 */
export function __resetBridgeTelemetrySinksForTests(): void {
  clearBridgeTelemetrySinks();
}

/**
 * 发一条 bridge_call 埋点。sink 默认走 clickhouse.writeToolCallRow（CH 通路保留，
 * 叠加不是替换）；随后依次调模块级链上各 sink。内部自吞异常，绝不 throw。
 */
export function emitBridgeToolCallTelemetry(
  input: BridgeCallTelemetryInput,
  sink: BridgeTelemetrySink = writeToolCallRow,
): void {
  try {
    // row 逐字段显式赋值 —— ctx **不在其中**（F14：CH 逐字段不变的构造性来源）。
    const row: ToolCallLogInput = {
      timestamp: new Date().toISOString(),
      sessionKey: input.sessionKey,
      turnSeq: input.turnSeq,
      spaceId: input.spaceId,
      userId: input.userId,
      teamId: input.teamId,
      agentId: input.agentId,
      agentSource: input.agentSource,
      kind: "bridge_call",
      bridgeSource: input.bridgeSource,
      initiatedTool: "",
      executedEndpoint: input.executedEndpoint,
      requestBody: input.requestBody,
      upstreamStatus: input.upstreamStatus,
      elapsedMs: input.elapsedMs,
      rejectReason: input.rejectReason,
    };
    // ctx：**只取已传的键**（未传的键不出现）⇒ 不透传 ctx 的 reject 路径
    // 得到的 ctx 逐键等价于 `{}`（§3.6）。一个 2 字段对象，零拷贝、用后即弃。
    const ctx: BridgeFetchContext = {};
    if (input.inboundBody !== undefined) ctx.inboundBody = input.inboundBody;
    if (input.responseText !== undefined) ctx.responseText = input.responseText;
    if (input.attributionSessionKey !== undefined) ctx.attributionSessionKey = input.attributionSessionKey;

    try {
      sink(row, ctx);
    } catch {
      // sink 抛 → 埋点绝不阻塞业务
    }
    for (const extra of _sinks) {
      try {
        extra(row, ctx);
      } catch {
        // 链上单个 sink 抛 → 不影响其它 sink，也绝不阻塞业务
      }
    }
  } catch {
    // input 构造异常也吞掉
  }
}

/**
 * 从 proxy session-key 反解 agentSource。
 *   "claude-code:conv-abc" → "claude-code"
 *   "codebuddy:conv-abc"   → "codebuddy"
 *   "conv-abc"（无前缀）    → "unknown"
 */
export function agentSourceFromSessionKey(sessionKey: string): string {
  const idx = sessionKey.indexOf(":");
  if (idx <= 0) return "unknown";
  return sessionKey.slice(0, idx);
}

/**
 * 前置校验失败埋点 helper —— proxy 层拒绝了请求, 没能打到上游 fetcher。
 *
 * 前置早退大部分连 session ids 都还没解析出来 (missing header / bad content-type /
 * invalid json ...), 能拿到的稳定字段有限。剩下的字段按可选透传。
 *
 * 内部套 emitBridgeToolCallTelemetry, kind 仍是 'bridge_call', 通过 rejectReason
 * 非空来区分。老 dashboard 全部 kind='bridge_call' 的 SQL 一字不动仍能跑,
 * 新增维度靠 `WHERE reject_reason != ''` 反查。
 *
 * 硬约束: 同步返回 void, 埋点绝不阻塞业务; sessionKey 允许空串。
 */
export interface BridgeRejectTelemetryInput {
  /** derive 出来就填, 前置阶段 (missing header) 派生不了填 "" */
  sessionKey: string;
  bridgeSource: "memory-bridge" | "skill-bridge";
  /** 稳定枚举值, 供 GROUP BY —— 详见 tool_call_logs.reject_reason 注释 */
  rejectReason: string;
  /** proxy 返给客户端的 HTTP status (401/415/400/...); 存到 upstream_status 列 */
  httpStatus: number;
  /** subpath 若已能算出就填, 否则 "" */
  executedEndpoint?: string;
  /** body 若已解析可填 (调用方负责 <=512 截断), 否则 "" */
  requestBody?: string;
  spaceId?: string;
  userId?: string;
  teamId?: string;
  agentId?: string;
  agentSource?: string;
}

export function emitBridgeRejectTelemetry(input: BridgeRejectTelemetryInput): void {
  emitBridgeToolCallTelemetry({
    sessionKey: input.sessionKey,
    spaceId: input.spaceId,
    userId: input.userId,
    teamId: input.teamId,
    agentId: input.agentId,
    agentSource: input.agentSource
      ?? (input.sessionKey ? agentSourceFromSessionKey(input.sessionKey) : "unknown"),
    bridgeSource: input.bridgeSource,
    executedEndpoint: input.executedEndpoint ?? "",
    requestBody: input.requestBody ?? "",
    upstreamStatus: input.httpStatus,
    elapsedMs: 0,
    rejectReason: input.rejectReason,
  });
}
