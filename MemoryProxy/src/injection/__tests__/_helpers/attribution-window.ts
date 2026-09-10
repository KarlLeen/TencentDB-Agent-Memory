/**
 * 归档归因窗口 helper —— S4 真链路冒烟（visible-archive-http-smoke.test.ts）与 golden 装置
 * （visible-archive-golden.test.ts）的**唯一共享实现**。
 *
 * 为什么必须有这一份文件（s4-smoke-design.md §3 要点 2 / §5.3 纪律 3）：
 *   归档侧"可见正文提取"与"排除项（excluded）不归档"的口径只能有一份实现。golden 装置
 *   （pre-injection 等价层）与 S4（真链路 HTTP 层）若各自内联一套拼接/归因规则，两套规则
 *   各自自洽 = 假绿。改动本文件等于同时改动两处断言口径。
 *
 * ⚠️ **口径归属已变更（2026-09-10，共享基座-c §4.8.1）**：`SEAM_GLUE` / `visibleTextOfPiece` /
 *   `restoredVisibleText` 的**实现**上移到生产模块 `src/attribution/citation/visible-text.ts`
 *   （基座-c 的归一化/剥离/n-gram 都必须吃同一份"可见正文"），本文件改为**纯 re-export**。
 *   因此"只能有一份实现"的落点从本文件搬到了那里；本文件剩 `stripGlue`（辅助诊断）与
 *   `rebuildInjectedBodyFromArchive`（测试侧重建工具）两份**测试专用**件。
 *   对上（两套装置）的 import 面零改动 ⇒ 断言口径零漂移（T26）。
 *
 * 上游事实锚点（均已按源码核过，非照抄文档行号）：
 *   - 档① piece.content = attribution_block_text.content_utf8（**原字节**，直接可见）
 *   - 档② piece.content = attribution_message_snap.content_json（JSON 字符串，需反序列化）
 *   - 窗口序            = (turn_seq, tier, seq)，tier 序 block < message
 *   - 水位（档②单代视图）= attribution_message_watermark.{epoch, last_seen_count}
 *   - 胶水             = src/session/context-injector.ts 的 appendBlockToAnthropicSystem /
 *                        appendBlockToOpenAISystem：string 载体一律拼 `${prev}\n\n${block}`
 */
import {
  windowVisibleText,
  type VisibleTextRepo,
  type VisibleWindowPiece,
} from "../../../db/visibleTextRepo.js";
// ⚠️ 口径已上移到生产模块（共享基座-c，attribution-base-design.md §4.8.1）：
// 本文件**只 re-export**，不再自己实现 —— 这是"只能有一份实现"纪律的落地形态。
// 断言口径零漂移：本文件仍导出同名同签名的 SEAM_GLUE / visibleTextOfPiece /
// restoredVisibleText，两套装置（golden + S4 真链路冒烟）的 import 面**零改动**。
import {
  restoredVisibleText,
  SEAM_GLUE,
  visibleTextOfPiece,
} from "../../../attribution/citation/visible-text.js";

export { restoredVisibleText, SEAM_GLUE, visibleTextOfPiece };

export type WindowPiece = VisibleWindowPiece;

/**
 * 只剥"接缝胶水"。
 *
 * **用法边界（务必按此用，否则会误判）**：这是**有损投影**——把连续空行折叠为单换行，
 * 它无法区分"接缝胶水"与"块内容里本来就有的空行"。因此它只用于辅助诊断
 * （s4-smoke-design.md §3a 的 D 准则）：
 *     stripGlue(上游 body 文本) === stripGlue(按归档重建的文本)
 * 当精确断言红掉时，用它判断"差异是否只来自胶水"。主断言一律用带位置的精确重建
 * （rebuildInjectedBodyFromArchive）。
 */
export function stripGlue(text: string): string {
  return text.replace(/\n{2,}/g, "\n");
}

export interface RebuildOptions {
  /**
   * 客户端自带、**不入档**的 system 原文。
   *  - anthropic：body.system 的 string 形态原文；
   *  - openai   ：messages[0]（system）的 content 原文。
   */
  excluded: string;
  protocol: "anthropic" | "openai";
  /** 缺省取当前水位 epoch（档②单代视图）。 */
  epoch?: number;
  turnFrom?: number;
  turnTo?: number;
}

export interface RebuiltInjectedBody {
  /** anthropic：重建后的 body.system 文本（string 形态）。 */
  anthropicSystem?: string;
  /** openai：重建后的 messages（首条 system + 档② 消息，窗口序）。 */
  openaiMessages?: Array<Record<string, unknown>>;
  /** 窗口内档① 注入块（注入面，窗口序）。 */
  injectedBlocks: WindowPiece[];
  /** 窗口内档② 消息（注入前消息流，窗口序）。 */
  archiveMessages: WindowPiece[];
  /** 档② 当前水位 epoch（无水位行 = 0）。 */
  epoch: number;
  /** 全窗口 pieces（窗口序）。 */
  pieces: WindowPiece[];
}

/**
 * 从归档窗口重建"注入后 body"的注入面，用于与真实上游 rawBody 做字节比对。
 *
 * **适用边界（诚实声明，不要越界使用）**：
 *   - system 侧只覆盖 **string 形态**，即系统侧只追加了 session-context 一个块、
 *     且 `adapter.serialize` 仍回落为 plain string 的场景。
 *   - 注入了渲染块（档① hook）后 system 是否变 block 数组，**取决于锚点是否解析成功**
 *     （详见 design §5.7.1）：锚点命中时 `pipeline.ts:362-371` 把 system 重建为**单块** ⇒
 *     `serializeSystemMessage` 的 `textBlocks.length === 1` 成立、**仍是 string**；只有锚点未命中
 *     走 `appendTextToMessage` 的 push 路径才会 >1 ⇒ 数组。**别按"块数"反推形态**（1 块走
 *     fallback 同样是数组）。数组形态由用例直接断块数组（见 smoke 用例 A2），**不走本函数**。
 *   - 多块（> 1）时按 SEAM_GLUE 拼接，仅当调用方确知 system 保持 string 时成立。
 */
export function rebuildInjectedBodyFromArchive(
  repo: VisibleTextRepo,
  sessionKey: string,
  opts: RebuildOptions,
): RebuiltInjectedBody {
  const win = windowVisibleText(repo, sessionKey, {
    epoch: opts.epoch,
    turnFrom: opts.turnFrom,
    turnTo: opts.turnTo,
  });

  const injectedBlocks = win.pieces.filter((p) => p.tier === "block");
  const archiveMessages = win.pieces.filter((p) => p.tier === "message");

  const blockText = injectedBlocks.map((p) => p.content).join(SEAM_GLUE);
  const systemText =
    blockText.length === 0
      ? opts.excluded
      : opts.excluded.length === 0
        ? blockText
        : opts.excluded + SEAM_GLUE + blockText;

  const out: RebuiltInjectedBody = {
    injectedBlocks,
    archiveMessages,
    epoch: win.epoch ?? 0,
    pieces: win.pieces,
  };

  if (opts.protocol === "anthropic") {
    out.anthropicSystem = systemText;
  } else {
    out.openaiMessages = [
      { role: "system", content: systemText },
      ...archiveMessages.map((p) => ({
        role: p.role ?? "user",
        content: JSON.parse(p.content) as unknown,
      })),
    ];
  }
  return out;
}
