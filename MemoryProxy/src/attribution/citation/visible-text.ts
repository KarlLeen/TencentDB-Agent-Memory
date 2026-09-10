/**
 * 可见正文口径（**生产侧唯一实现**）—— 共享基座-c 上移落点。
 *
 * attribution-base-design.md §4.8.1：P0 的"可见正文提取 / 胶水"口径原本只有一份实现，
 * 但它放在**测试目录**（`src/injection/__tests__/_helpers/attribution-window.ts`，F31），
 * 文件头自述「只能有一份实现……改动本文件等于同时改动两处断言口径」。基座-c 需要同一口径
 * （归一化 / 剥离 / n-gram 的输入都是"可见正文"），因此**上移复用**而非新造第二份：
 *   1. 口径上移到本文件（生产模块）；
 *   2. 原测试 helper 改为 **re-export**（golden 装置 + S4 真链路冒烟的 import 面零改动
 *      ⇒ 断言口径零漂移，T26）；
 *   3. 复跑 `visible-archive-golden.test.ts` + `visible-archive-http-smoke.test.ts` 证明逐字节仍一致。
 *
 * 上游事实锚点（均已按源码核过，非照抄文档行号）：
 *   - 档① piece.tier = "block"   → content 即 attribution_block_text.content_utf8（**原字节**，直接可见）
 *   - 档② piece.tier = "message" → content 是 attribution_message_snap.content_json（JSON 字符串，需反序列化）
 *   - 胶水源头：src/session/context-injector.ts 的 appendBlockToAnthropicSystem /
 *     appendBlockToOpenAISystem —— string 载体一律拼 `${prev}\n\n${block}`。
 *
 * ⚠️ 本模块只提供"取可见正文 / 拼回胶水"的**读取口径**，不提供任何写路径：
 *    归档永远是原字节，任何归一化/剥离产物都只用于比较（design §4.8.2 纪律、T17）。
 */
import type { VisibleWindowPiece } from "../../db/visibleTextRepo.js";

/**
 * 接缝胶水：string 形态 system 追加 session-context 块时的分隔符。
 *
 * 唯一来源 —— c-2 的剥离模板表若需要"胶水"类条目，必须引用本常量，**不得重写字面量**（§4.8.3）。
 */
export const SEAM_GLUE = "\n\n";

/**
 * piece 的"可见正文"（**与 P0 golden 装置逐字节同口径**）：
 *   - tier === "block"   → content 原字节，直接返回；
 *   - tier === "message" → content_json 反序列化后的文本。
 *
 * `piece.content` 对 message 档是 JSON 串（如 `"\"hello\""`），对 block 档是裸文本；
 * 二者**不能混用**，否则窗口还原串会多出引号 —— 这正是必须只有一份实现的原因。
 */
export function visibleTextOfPiece(piece: VisibleWindowPiece): string {
  return piece.tier === "block" ? piece.content : String(JSON.parse(piece.content));
}

/**
 * 归档窗口还原串：按窗口序逐字节拼接，**无分隔符**。
 *
 * 归档的是正文本身，不含 handler 拼接时加的胶水；胶水由重建侧按 SEAM_GLUE 补回
 * （档① 的合成块 content 是不带胶水的纯块体）。
 */
export function restoredVisibleText(pieces: readonly VisibleWindowPiece[]): string {
  return pieces.map(visibleTextOfPiece).join("");
}
