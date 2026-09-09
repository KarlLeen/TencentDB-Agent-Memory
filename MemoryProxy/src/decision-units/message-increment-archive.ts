/**
 * Message-increment archive — 档② visible-text 消息增量（40-visible-text-archive.md §4）。
 *
 * 接缝：与 runDecisionUnitExtraction 同调用区（注入前）。每条消息按 (session, epoch, index)
 * 落 attribution_message_snap；水位（epoch + last_seen_count）镜像 decision-unit-runner 内存
 * 水位的 compaction 语义（runner.ts:126-127：messageCount < watermark ⇒ 归零全量重放）：
 *   - DB 水位每会话单行；本请求 messageCount < last_seen_count ⇒ epoch+1 且 last_seen_count=0，
 *     随后整窗以新 epoch 重放（旧 epoch 行保留 —— 压缩改写不吞行）。
 *
 * 轮次推导（§4.2，B3）：与 decision-unit-extractor turnSeqOf 同源 —— 复用 turnSeq.ts 的
 * isHumanUserContent 前缀计数，不新增第二套语义。逐消息在档内推导，纯函数可单测。
 *
 * role=system 行不入档（§3a/§4.3：system 层由档① + excluded 兜底）；tool/system 行合法例外。
 *
 * 互斥断言守卫（40 spec §7 test 7 / R1-B2 收窄）：classifySameTurnWholeContainment 判定"同轮
 * 非 tool 新消息（user/assistant）不得整块包含档① block"，tool/system 行合法例外；返回违规分类、
 * 不阻断（告警观测语义交调用方）。档① 在注入中归档、档② 在注入前归档，同轮配对只能 read 期完成，
 * 故本函数是可注入纯函数，由 S5 worker / 验收装置以 (本会话 seen 行, 单 epoch 消息行) 喂入。
 */
import { getVisibleTextRepo, readWatermark } from "../db/visibleTextRepo.js";
import type {
  BlockSeenWithTextRow,
  MessageSnapRow,
  NewMessageSnap,
} from "../db/visibleTextRepo.js";
import { sha256Of } from "../injection/visible-block-archive-observer.js";
import { isHumanUserContent } from "../turnSeq.js";

export const DEFAULT_MAX_MESSAGE_CHARS = 65_536;

// ── 消息内容归一（fingerprint 用于 hash/chars/cap 判定；content_json 存原文）───────

/** 逐段抽 text：string 原样；数组按序拼 text / tool_result.content。 */
export function messageTextFingerprint(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_result") {
      // tool_result 的 content 可能是字符串或 text-block 数组（Anthropic 形态）。
      parts.push(messageTextFingerprint(b.content));
    }
  }
  return parts.join("\n");
}

/** 构建"截断后仍合法 JSON"的 content 副本（保持原结构，text 字段逐段削到预算内）。 */
export function truncateMessageContent(content: unknown, maxChars: number): unknown {
  if (typeof content === "string") {
    return content.length <= maxChars ? content : content.slice(0, maxChars);
  }
  if (!Array.isArray(content)) return content;
  let budget = maxChars;
  const out: unknown[] = [];
  for (const item of content) {
    if (budget <= 0) break;
    if (!item || typeof item !== "object") {
      out.push(item);
      continue;
    }
    const b = { ...(item as Record<string, unknown>) };
    if (b.type === "text" && typeof b.text === "string") {
      b.text = b.text.length <= budget ? b.text : b.text.slice(0, budget);
      budget -= (b.text as string).length;
      out.push(b);
    } else if (b.type === "tool_result") {
      const sub = truncateMessageContent(b.content, budget);
      const subFp = messageTextFingerprint(sub);
      budget -= subFp.length;
      b.content = sub;
      out.push(b);
    } else {
      out.push(item);
    }
  }
  return out;
}

// ── 轮次推导（§4.2，与 turnSeq.ts / extractor turnSeqOf 同源）─────────────────────

/**
 * 计算 messages[fromIndex..] 段内每条消息的 turn_seq：turn_seq(m) =
 * countHumanTurns(messages[0..m])（与 extractor turnSeqOf(anchor) 同语义前缀计数）。
 */
export function deriveSegmentTurnSeqs(
  messages: unknown[],
  fromIndex: number,
  protocol: "openai" | "anthropic",
): number[] {
  const out: number[] = [];
  let humanCount = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Record<string, unknown> | null | undefined;
    if (m && m.role === "user" && isHumanUserContent(m.content)) humanCount += 1;
    if (i >= fromIndex) out.push(humanCount);
  }
  return out;
}

// ── 互斥断言守卫（40 spec §7 test 7 / R1-B2 收窄）────────────────────────────────

export interface TurnContainmentViolation {
  blockHook: string; // 档① block 来源 hook（skill-listing-injector / session-context …）
  source: string; // 档① block 的 source 标注
  blockIdx: number;
  msgIndex: number; // 档② message_index（会话消息流位置）
  role: "user" | "assistant"; // 收窄后只对非 tool 新消息判
  kind: "whole"; // 整块包含；segment 级部分重叠不在收窄判定内（S5 归一化工具职责）
  blockChars: number; // 命中 block 原长 chars
  msgChars: number; // 命中消息可见文本 chars
  truncatedBlock: boolean; // 命中 block 超 cap（比对对象为已存头段）
  truncatedMsg: boolean; // 命中消息超 cap（比对对象为已存可见头段）
}

/** content_json → 可见文本（口径同 messageTextFingerprint）；解析失败按空串，绝不 throw。 */
function visibleTextOfContentJson(contentJson: string): string {
  try {
    return messageTextFingerprint(JSON.parse(contentJson));
  } catch {
    return "";
  }
}

/**
 * 同轮互斥断言（收窄口径，40 spec §7 test 7 / R1-B2）：
 * 只检查 role ∈ {user, assistant} 的档② 消息 vs 同 turn_seq 的档① block occurrence ——
 * 消息可见文本不得**整块**包含 block.content_utf8；role=tool / system 行合法例外不参与
 * （skill_view 返回含注入段全文的 tool_result 属合法记忆工作流，不判违规）。
 *
 * 语义边界：
 * - 本函数是"P0 守卫 / S5 worker 自检"的可注入纯函数：档① block 在注入中归档、档② 消息在注入前
 *   归档，同一请求的配对只能 read 期完成 —— 调用方按 epoch 取消息后与本会话 seen 行一起喂入。
 * - 不 throw、不阻断：命中即返回违规分类，由调用方做告警观测（v1"observer 绝不 throw"纪律）。
 * - 比对对象为归档正文（block=content_utf8、消息=content_json 解析后的可见文本）；截断行以已存
 *   头段为准并带 truncated 标记（原始全文在档① 只在 hash 键/截断语义上可还原，S5 消费端自行核对）。
 */
export function classifySameTurnWholeContainment(
  blocks: BlockSeenWithTextRow[],
  messages: MessageSnapRow[],
): TurnContainmentViolation[] {
  const blocksByTurn = new Map<number, BlockSeenWithTextRow[]>();
  for (const b of blocks) {
    if (typeof b.content_utf8 !== "string" || b.content_utf8.length === 0) continue;
    const arr = blocksByTurn.get(b.turn_seq);
    if (arr) arr.push(b);
    else blocksByTurn.set(b.turn_seq, [b]);
  }

  const violations: TurnContainmentViolation[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue; // tool/system 合法例外
    const turnBlocks = blocksByTurn.get(m.turn_seq);
    if (!turnBlocks || turnBlocks.length === 0) continue;
    const text = visibleTextOfContentJson(m.content_json);
    if (text.length === 0) continue;
    for (const b of turnBlocks) {
      if (b.content_utf8.length === 0 || !text.includes(b.content_utf8)) continue;
      violations.push({
        blockHook: b.hook_id,
        source: b.source,
        blockIdx: b.block_idx,
        msgIndex: m.message_index,
        role: m.role as "user" | "assistant",
        kind: "whole",
        blockChars: b.chars,
        msgChars: text.length,
        truncatedBlock: b.truncated === 1,
        truncatedMsg: m.truncated === 1,
      });
    }
  }
  return violations;
}

// ── 归档入口 ───────────────────────────────────────────────────────────────────────

export interface MessageArchiveConfig {
  injection?: {
    decisionUnitExtractor?: { enabled?: boolean };
    visibleArchive?: { enabled?: boolean; maxMessageChars?: number };
  };
}

export interface ArchiveMessageIncrementParams {
  config: MessageArchiveConfig;
  protocol: "openai" | "anthropic";
  messages: unknown[];
  sessionKey: string;
}

/**
 * 档②：主对话请求注入前调用（同区同守卫已在调用点保证）。best-effort，绝不 throw。
 * 覆盖 guard：visibleArchive.enabled + mainDialog + 有会话（调用点） + messages 非空。
 */
export function archiveMessageIncrement(params: ArchiveMessageIncrementParams): void {
  const archiveCfg = params.config?.injection?.visibleArchive;
  if (archiveCfg?.enabled !== true) return;
  if (!params.sessionKey) return;
  if (!Array.isArray(params.messages) || params.messages.length === 0) return;

  const repo = getVisibleTextRepo();
  const messageCount = params.messages.length;
  const { epoch: curEpoch, lastSeen: curLast } = readWatermark(repo, params.sessionKey);

  let epoch = curEpoch;
  let last = curLast;
  const compacted = messageCount < last; // 镜像 runner.ts:126-127
  if (compacted) {
    epoch = curEpoch + 1;
    last = 0;
  }

  if (messageCount <= last) {
    // 无新增段：仍可能发生 compaction（归零后 count 成为新水位）。
    if (compacted) repo.upsertWatermark(params.sessionKey, epoch, messageCount);
    return;
  }

  const maxChars =
    archiveCfg.maxMessageChars && archiveCfg.maxMessageChars > 0
      ? archiveCfg.maxMessageChars
      : DEFAULT_MAX_MESSAGE_CHARS;
  const turnSeqs = deriveSegmentTurnSeqs(params.messages, last, params.protocol);

  let inserted = 0;
  for (let m = last; m < messageCount; m++) {
    const msg = params.messages[m] as Record<string, unknown> | null | undefined;
    if (!msg || typeof msg !== "object") continue;
    const role = typeof msg.role === "string" ? msg.role : "";
    if (role === "system") continue; // §3a/§4.3：system 行不入档②
    if (role !== "user" && role !== "assistant" && role !== "tool") continue;

    const fp = messageTextFingerprint(msg.content);
    if (fp.length === 0) continue;

    const contentForJson = fp.length <= maxChars
      ? msg.content
      : truncateMessageContent(msg.content, maxChars);
    const snap: NewMessageSnap = {
      sessionKey: params.sessionKey,
      epoch,
      turnSeq: turnSeqs[m - last],
      messageIndex: m,
      role,
      contentHash: sha256Of(fp), // 与档① text hash 同为"正文 fingerprint"口径，read 期可折叠
      contentJson: JSON.stringify(contentForJson),
      chars: fp.length,
      truncated: fp.length > maxChars,
    };
    repo.insertMessageSnap(snap);
    inserted += 1;
  }

  // 有新段即写水位（幂等：无消息变化时直接返回不写，避免与重复请求的读-写竞态放大幅度）。
  repo.upsertWatermark(params.sessionKey, epoch, messageCount);
}
