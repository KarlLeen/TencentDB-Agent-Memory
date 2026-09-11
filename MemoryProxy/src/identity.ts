/**
 * Client Identity Extraction — extracts user ID, session ID, and other
 * identifiers from intercepted CodeBuddy requests.
 *
 * CodeBuddy sends requests to this proxy with:
 * 1. Authorization header: `Bearer ck_<user_token>.<secret>` — API key
 * 2. Various HTTP headers that may contain user/session metadata
 * 3. System prompt content with `<user_info>` that embeds workspace info
 *
 * This module:
 * - Extracts all available identity signals from headers and body
 * - Provides a stable `userId` derived from the API key structure
 *
 * 会话键唯一真相 = `session/session-key.ts` 的 `resolveConversationId`（52 起；本模块不再自带名单）。
 */

import { createHash } from "node:crypto";
import { resolveConversationIdFromHeaders } from "./session/session-key.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ClientIdentity {
  /** Derived user ID from API key prefix (e.g. "ck_fovj16r9s5j4") */
  userId: string | null;
  /** Full API key hash (first 8 hex chars of SHA-256) */
  keyId: string;
  /** Raw API key prefix (everything before the first dot) — user-level token */
  apiKeyPrefix: string | null;
  /** Session/conversation ID if found in headers or body */
  sessionId: string | null;
  /** Enterprise WeChat (企微) ID if found in headers */
  wechatWorkId: string | null;
  /** Any x-request-id or trace ID from headers */
  requestId: string | null;
  /** User-Agent header value */
  userAgent: string | null;
  /** All custom x- headers (for discovery) */
  customHeaders: Record<string, string>;
  /** Extracted from system prompt <user_info> if present */
  userInfo: UserInfoFromPrompt | null;
  /** Agent source name from URL path (e.g. "codebuddy", "claude-code"). */
  agentSource: string;
  /** Proxy-issued user token from `X-Tdai-User-Token` header (panel-generated). */
  proxyToken: string | null;
}

export interface UserInfoFromPrompt {
  /** OS Version extracted from prompt */
  osVersion: string | null;
  /** Shell type */
  shell: string | null;
  /** Workspace folder path */
  workspaceFolder: string | null;
  /** Username extracted from workspace path (e.g. /data/home/demo-user → demo-user) */
  usernameFromPath: string | null;
  /** Current time if present */
  currentTime: string | null;
  /** Any session/conversation ID found in the prompt content */
  sessionIdFromPrompt: string | null;
  /** Plan ID if present in additional_data */
  planId: string | null;
}

// ── Identity extraction from headers ───────────────────────────────────────────

/**
 * Extract client identity from request headers.
 *
 * CodeBuddy API key format: `ck_<user_token>.<secret_key>`
 * The prefix before the dot is a user-level identifier.
 */
export function extractClientIdentity(
  headers: Record<string, string>,
  body?: Record<string, unknown>,
  agentSource = "claude-code",
): ClientIdentity {
  // Extract API key
  const authHeader = headers["authorization"] ?? headers["Authorization"] ?? "";
  const apiKey = extractBearer(authHeader);

  // Parse API key structure: prefix.secret
  let apiKeyPrefix: string | null = null;
  let userId: string | null = null;
  if (apiKey) {
    const dotIndex = apiKey.indexOf(".");
    if (dotIndex > 0) {
      apiKeyPrefix = apiKey.slice(0, dotIndex);
      // The prefix IS the user-level identifier (e.g. "ck_fovj16r9s5j4")
      userId = apiKeyPrefix;
    }
  }

  const keyId = apiKey
    ? createHash("sha256").update(apiKey).digest("hex").slice(0, 8)
    : "unknown";

  // Enterprise WeChat ID
  let wechatWorkId: string | null =
    headers["x-wechat-work-id"] ??
    headers["x-wecom-id"] ??
    headers["x-user-id"] ??
    headers["x-cb-user-id"] ??
    headers["x-codebuddy-user-id"] ??
    null;

  // Request trace ID
  const requestId =
    headers["x-request-id"] ??
    headers["x-trace-id"] ??
    headers["x-correlation-id"] ??
    headers["traceparent"] ??
    null;

  // User-Agent
  const userAgent = headers["user-agent"] ?? null;

  // Proxy-issued user token (panel-generated). Header is case-insensitive;
  // Hono normalizes header names to lowercase, but accept both for safety.
  const proxyToken =
    headers["x-tdai-user-token"] ??
    headers["X-Tdai-User-Token"] ??
    null;

  // Collect ALL custom x- headers for discovery, plus a lowercased view for the
  // session-key resolver（唯一真相在 session/session-key.ts；53 起本模块不再自带名单）。
  const customHeaders: Record<string, string> = {};
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    lowerHeaders[lower] = v;
    if (lower.startsWith("x-") || lower.startsWith("cb-") || lower.startsWith("codebuddy-")) {
      customHeaders[k] = v;
    }
  }

  // Session/conversation ID —— 取值器大小写不敏感：`headers` 可能是 Headers 的小写视图，
  // 也可能是调用方给的原始 map（见 53 报告 §语义变更 A2′）。
  let sessionId: string | null = resolveConversationIdFromHeaders((name) => lowerHeaders[name]);

  // Extract user info from system prompt
  let userInfo: UserInfoFromPrompt | null = null;
  if (body) {
    userInfo = extractUserInfoFromBody(body);
  }

  // If session ID wasn't found in headers, check if prompt has one
  if (!sessionId && userInfo?.sessionIdFromPrompt) {
    sessionId = userInfo.sessionIdFromPrompt;
  }

  // If wechat/work ID wasn't found in headers, try username from workspace path
  if (!wechatWorkId && userInfo?.usernameFromPath) {
    wechatWorkId = userInfo.usernameFromPath;
  }

  return {
    userId,
    keyId,
    apiKeyPrefix,
    sessionId,
    wechatWorkId,
    requestId,
    userAgent,
    customHeaders,
    userInfo,
    agentSource,
    proxyToken,
  };
}

// ── Extract user info from body/system prompt ──────────────────────────────────

/**
 * Extract identity information from the request body.
 *
 * CodeBuddy injects `<user_info>` blocks into the system prompt with:
 * - OS Version
 * - Shell type
 * - Workspace Folder path (contains username)
 * - Current time
 *
 * Also, the system prompt may contain `<additional_data>` with more context.
 */
function extractUserInfoFromBody(body: Record<string, unknown>): UserInfoFromPrompt | null {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  // Get system prompt content
  const systemMsg = messages.find(
    (m: unknown) => (m as Record<string, unknown>).role === "system",
  ) as Record<string, unknown> | undefined;

  if (!systemMsg) return null;

  let systemContent = "";
  if (typeof systemMsg.content === "string") {
    systemContent = systemMsg.content;
  } else if (Array.isArray(systemMsg.content)) {
    systemContent = (systemMsg.content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }

  if (!systemContent) return null;

  // Extract from <user_info> block
  const userInfoMatch = systemContent.match(/<user_info>([\s\S]*?)<\/user_info>/);
  let osVersion: string | null = null;
  let shell: string | null = null;
  let workspaceFolder: string | null = null;
  let currentTime: string | null = null;

  if (userInfoMatch) {
    const userInfoText = userInfoMatch[1];

    // Parse individual fields
    osVersion = extractField(userInfoText, /OS Version:\s*(.+)/i);
    shell = extractField(userInfoText, /Shell:\s*(.+)/i);
    workspaceFolder = extractField(userInfoText, /Workspace Folder:\s*(.+)/i);
    currentTime = extractField(userInfoText, /(?:current_time|Note):\s*(.+)/i);
  }

  // Extract username from workspace path (e.g. /data/home/user/... → demo-user)
  let usernameFromPath: string | null = null;
  if (workspaceFolder) {
    // Common patterns: /data/home/<user>/, /home/<user>/, /Users/<user>/
    const pathMatch = workspaceFolder.match(/\/(?:data\/)?home\/([^/]+)/i) ??
      workspaceFolder.match(/\/Users\/([^/]+)/i);
    if (pathMatch) {
      usernameFromPath = pathMatch[1];
    }
  }

  // Try to find session/conversation ID in the prompt content
  // CodeBuddy may inject session IDs in <additional_data> or other metadata blocks
  let sessionIdFromPrompt: string | null = null;
  const sessionPatterns = [
    /session[_\s-]?id["\s:=]+([^\s\n"']+)/i,
    /conversation[_\s-]?id["\s:=]+([^\s\n"']+)/i,
    /chat[_\s-]?id["\s:=]+([^\s\n"']+)/i,
    /"sessionId"\s*:\s*"([^"]+)"/i,
    /"conversationId"\s*:\s*"([^"]+)"/i,
    /uuid[:=]\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
    /session_key["\s:=]+([^\s\n"']+)/i,
  ];
  for (const pattern of sessionPatterns) {
    const match = systemContent.match(pattern);
    if (match) {
      sessionIdFromPrompt = match[1];
      break;
    }
  }

  // Try to find plan ID from <additional_data>
  let planId: string | null = null;
  const planMatch = systemContent.match(/plan[s]?\/([a-f0-9-]+)\/plan\.md/i);
  if (planMatch) {
    planId = planMatch[1];
  }

  return {
    osVersion,
    shell,
    workspaceFolder,
    usernameFromPath,
    currentTime,
    sessionIdFromPrompt,
    planId,
  };
}

function extractField(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match ? match[1].trim() : null;
}

function extractBearer(authHeader: string): string {
  if (!authHeader) return "";
  const match = authHeader.match(/^[Bb]earer\s+(.+)$/);
  return match ? match[1].trim() : "";
}

// ── Full inspection helper (called from handler) ───────────────────────────────

/**
 * Inspect the incoming request and log the extracted identity signals.
 * Called from handler.ts and anthropicHandler.ts.
 *
 * 53 起不再产出 inspection 记录（ring buffer 已删）：`method` / `path` 仅为不动两个调用点
 * 而保留的形参，不参与任何产出。
 */
export function inspectAndRecord(
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  agentSource = "claude-code",
): ClientIdentity {
  const identity = extractClientIdentity(headers, body, agentSource);

  // Also log to stderr for real-time visibility
  console.error(
    `[identity] userId=${identity.userId ?? "?"} keyId=${identity.keyId} ` +
    `sessionId=${identity.sessionId ?? "none"} ` +
    `wechatId=${identity.wechatWorkId ?? "none"} ` +
    `user=${identity.userInfo?.usernameFromPath ?? "?"} ` +
    `ws=${identity.userInfo?.workspaceFolder ?? "?"} ` +
    `proxyToken=${identity.proxyToken ? identity.proxyToken.slice(0, 12) + "***" : "none"}` +
    (Object.keys(identity.customHeaders).length > 0
      ? ` custom=[${Object.keys(identity.customHeaders).join(",")}]`
      : ""),
  );

  // [DEBUG-CC-SESSION] 临时调试：打印 Claude Code SDK 注入的 session id 值，
  // 用于验证「同一次 claude 启动多次请求同 id / 不同启动不同 id」。验证完即移除。
  {
    const ccSid =
      identity.customHeaders["x-claude-code-session-id"] ??
      identity.customHeaders["X-Claude-Code-Session-Id"];
    const xApp =
      identity.customHeaders["x-app"] ?? identity.customHeaders["X-App"];
    if (ccSid || xApp) {
      console.error(
        `[debug-cc] x-claude-code-session-id=${ccSid ?? "none"} x-app=${xApp ?? "none"}`,
      );
    }
  }

  return identity;
}
