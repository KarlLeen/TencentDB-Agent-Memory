/**
 * Visible-block archive — 档① visible-text 捕获（40-visible-text-archive.md §3）。
 *
 * Two capture seams share ONE archive path:
 *   - seam A（注入块）：VisibleBlockArchiveObserver 挂在 pipeline hook.done 回调上，把
 *     全量渲染 ContextBlock（仅 type:"text" 非空）逐 block 归档。
 *   - seam B（session-context 合成块，B1 关漏）：anthropic 协议下 session_context 经
 *     `appendBlockToAnthropicSystem` 直拼 `body.system`，不经过任何 hook —— 由 handler 在
 *     合并点调用 {@link recordArchivedBlock}（hook_id="session-context", point="system.prepend",
 *     source="session.context"）写入与合入正文逐字节相同的内容。openai 协议对称点同样经此入口。
 *
 * Content dedupe: attribution_block_text 按 content_hash 全局唯一（source 不参与唯一键，B5）；
 * 每条 occurrence 写 attribution_block_seen 链接（session/turn/hook/point/content_id/block_idx）。
 *
 * 纯函数（sha256Of / truncateToChars / textStats）导出供单测；错误一律静默降级（repo 层兜底）。
 */
import { createHash } from "node:crypto";

import { getVisibleTextRepo } from "../db/visibleTextRepo.js";
import type { NewBlockSeen, NewBlockText } from "../db/visibleTextRepo.js";
import { collectAssets } from "./attribution-event-observer.js";
import { NoopInjectionObserver } from "./observer.js";
import type { AgentContextMetadata, ContextBlock, InjectionHook, InjectionPoint } from "./types.js";

export const SESSION_CONTEXT_HOOK = "session-context";
export const SESSION_CONTEXT_POINT = "system.prepend";
export const SESSION_CONTEXT_SOURCE = "session.context";

export const DEFAULT_MAX_BLOCK_CHARS = 32_768;

// ── Pure helpers（单测锚点）───────────────────────────────────────────────────────

/** sha256(utf8(text))，16 进制 —— 全局去重键。 */
export function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface TextStats {
  chars: number; // JS string length（原长，截断前）
  bytes: number; // utf8 字节数（原长，截断前）
}

export function textStats(text: string): TextStats {
  return { chars: text.length, bytes: Buffer.byteLength(text, "utf8") };
}

/** 超 cap 时取前 maxChars 个 UTF-16 code units；否则原样。 */
export function truncateToChars(text: string, maxChars: number): { head: string; truncated: boolean } {
  if (text.length <= maxChars) return { head: text, truncated: false };
  return { head: text.slice(0, maxChars), truncated: true };
}

/**
 * block.metadata.source 取值规则（40 spec §3 规则 3）：metadata.source 为非空 string 时取之，
 * 否则回退 hook.id。
 */
export function sourceOfBlock(block: ContextBlock, hookId: string): string {
  const raw = block.metadata?.source;
  return typeof raw === "string" && raw.length > 0 ? raw : hookId;
}

/** occurrence 行 asset_ids：collectAssets identity 摘要（无 spans）；无资产 → null。 */
export function assetIdsJsonOf(blocks: ContextBlock[]): string | null {
  const assets = collectAssets(blocks);
  if (assets.length === 0) return null;
  return JSON.stringify(assets.map((a) => ({ assetId: a.assetId, assetType: a.assetType })));
}

// ── Shared archive entry ───────────────────────────────────────────────────────────

export interface ArchiveBlockInput {
  sessionKey: string;
  turnSeq: number;
  block: ContextBlock;
  hookId: string;
  point: string;
  blockIdx: number;
  maxBlockChars?: number;
}

/** 归档单条 text block（档① 共用路径：observer 与 handler 合成块捕获都走这里）。 */
export function archiveTextBlock(input: ArchiveBlockInput): void {
  const block = input.block;
  if (block.type !== "text") return;
  const content = typeof block.content === "string" ? block.content : "";
  if (content.length === 0) return;
  if (!input.sessionKey) return;

  const repo = getVisibleTextRepo();
  const maxChars = input.maxBlockChars && input.maxBlockChars > 0 ? input.maxBlockChars : DEFAULT_MAX_BLOCK_CHARS;
  const { head, truncated } = truncateToChars(content, maxChars);
  const hash = sha256Of(content); // 去重键按全量 content（B5：source 不参与）
  const stats = textStats(content);

  const textRow: NewBlockText = {
    source: sourceOfBlock(block, input.hookId),
    contentHash: hash,
    contentUtf8: head,
    chars: stats.chars,
    bytes: stats.bytes,
    truncated,
  };
  const { contentId } = repo.upsertBlockText(textRow);
  if (contentId <= 0) return;

  const seen: NewBlockSeen = {
    sessionKey: input.sessionKey,
    turnSeq: input.turnSeq,
    hookId: input.hookId,
    point: input.point,
    contentId,
    blockIdx: input.blockIdx,
    assetIdsJson: assetIdsJsonOf([block]),
  };
  repo.insertBlockSeen(seen);
}

/** seam B：session-context 合成块（handler 合并点调用，内容与合入正文逐字节相同）。 */
export function recordSessionContextBlock(input: {
  sessionKey: string;
  turnSeq: number;
  content: string;
  maxBlockChars?: number;
}): void {
  if (!input.sessionKey || typeof input.content !== "string" || input.content.length === 0) return;
  archiveTextBlock({
    sessionKey: input.sessionKey,
    turnSeq: input.turnSeq,
    // seam B 合成块固定 source=session.context（模块头契约）；不带则 sourceOfBlock
    // 会回退 hook.id，source 标注失真。
    block: { type: "text", content: input.content, metadata: { source: SESSION_CONTEXT_SOURCE } },
    hookId: SESSION_CONTEXT_HOOK,
    point: SESSION_CONTEXT_POINT,
    blockIdx: 0,
    maxBlockChars: input.maxBlockChars,
  });
}

// ── Observer（seam A：pipeline hook.done 全量 blocks）────────────────────────────

/**
 * 档① observer。缺省 config 关闭时不实例化（装配点 gate），此处不读任何表。
 * 每轮每个 hook 的 text block → 一次 occurrence；内容行跨轮全局去重。
 */
export class VisibleBlockArchiveObserver extends NoopInjectionObserver {
  private readonly maxBlockChars: number;

  constructor(opts?: { maxBlockChars?: number }) {
    super();
    this.maxBlockChars = opts?.maxBlockChars && opts.maxBlockChars > 0
      ? opts.maxBlockChars
      : DEFAULT_MAX_BLOCK_CHARS;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHookDone(
    hook: InjectionHook,
    point: InjectionPoint,
    blocks: ContextBlock[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _durationMs: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _cacheStrategy?: string,
    meta?: AgentContextMetadata,
  ): void {
    // 与 20 spec §4.2 同守卫：无 sessionKey 不落行。turnSeq 由 handler 层按注入管线
    // meta.turnSeq（= countHumanTurns 窗口口径）透传；缺失时跳过（不该发生在主对话注入路径）。
    const sessionKey = meta?.sessionKey;
    const turnSeq = meta?.turnSeq;
    if (!sessionKey || typeof turnSeq !== "number") return;
    if (!Array.isArray(blocks) || blocks.length === 0) return;

    for (let i = 0; i < blocks.length; i++) {
      archiveTextBlock({
        sessionKey,
        turnSeq,
        block: blocks[i],
        hookId: hook.id,
        point,
        blockIdx: i,
        maxBlockChars: this.maxBlockChars,
      });
    }
  }
}
