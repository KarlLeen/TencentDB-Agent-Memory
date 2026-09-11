/**
 * Session key resolution & conversation freshness check.
 *
 * Shared between handler.ts and anthropicHandler.ts.
 */
import type { Context } from "hono";

/** Extract conversation ID from request headers. Returns null if no valid ID found. */
export function resolveConversationId(c: Context): string | null {
  return resolveConversationIdFromHeaders((name) => c.req.header(name));
}

/**
 * 会话头解析的**唯一真相**（53 起名单只此一份）：`resolveConversationId` 是本函数的 Hono 取头薄包装，
 * `identity.ts` 的调试日志同调本函数 —— 任何"另一份名单"都是漂移源。
 *
 * 契约：`get` **大小写不敏感**；空串按"未提供"处理（归 `null`）。
 * 两处输入域语义变更（53 收敛时显式声明，生产调用点均不受影响，见 53 报告 §语义变更）：
 * 大小写混合键由"取不到"→"命中"；空串由 `""` → `null`。
 */
export function resolveConversationIdFromHeaders(
  get: (name: string) => string | undefined,
): string | null {
  const id =
    get("x-conversation-id") ??
    get("x-session-id") ??
    get("x-claude-code-session-id") ?? // Claude Code CLI sends this
    get("x-deepseek-harness-session-id") ?? // dsh (deepseek-harness) CLI/web sends this
    get("x-chat-id") ??
    get("x-thread-id") ??
    null;
  return id && id.length > 0 ? id : null;
}

/** Check whether the messages look like a fresh conversation (at most 1 user message, no assistant/tool). */
export function isFreshConversation(
  messages: Array<{ role?: string }>,
): boolean {
  let userCount = 0;
  for (const m of messages) {
    const role = m.role ?? "";
    if (role === "assistant" || role === "tool") return false;
    if (role === "user") userCount++;
    if (userCount > 1) return false;
  }
  return userCount <= 1;
}
