/**
 * T26 上移零漂移（design §4.8.1 / §5）—— 可见正文口径上移后，
 *   1) 原测试 helper 是**纯 re-export**（不是副本：函数引用恒等）；
 *   2) 口径本身（block 原字节 / message JSON 反序列化 / 无分隔符拼接）不变。
 *
 * 另半条证据在装置层：`visible-archive-golden.test.ts`（5 例）+
 * `visible-archive-http-smoke.test.ts`（10 例）逐字节断言全绿，import 面零改动。
 * 本文件只钉"结构上确实只有一份实现"，防后来人把 helper 改回内联副本（那样两套装置
 * 会各自自洽 = 假绿）。
 */

import { describe, expect, it } from "vitest";

import type { VisibleWindowPiece } from "../../../db/visibleTextRepo.js";
import * as helper from "../../../injection/__tests__/_helpers/attribution-window.js";
import * as prod from "../visible-text.js";

function piece(over: Partial<VisibleWindowPiece> & Pick<VisibleWindowPiece, "tier" | "content">): VisibleWindowPiece {
  return {
    epoch: null,
    turnSeq: 1,
    seq: 0,
    source: "session-context",
    contentHash: `h-${over.seq ?? 0}`,
    truncated: false,
    chars: over.content.length,
    role: null,
    blockIdx: null,
    ...over,
  };
}

describe("T26 上移零漂移", () => {
  it("helper 是纯 re-export：三个导出与生产模块**同一引用**（同一份实现，非副本）", () => {
    expect(helper.SEAM_GLUE).toBe(prod.SEAM_GLUE);
    expect(helper.visibleTextOfPiece).toBe(prod.visibleTextOfPiece);
    expect(helper.restoredVisibleText).toBe(prod.restoredVisibleText);
    expect(Object.is(helper.visibleTextOfPiece, prod.visibleTextOfPiece)).toBe(true);
  });

  it("胶水字面量仍是 \\n\\n（胶水源头 = context-injector 的 `${prev}\\n\\n${block}`）", () => {
    expect(prod.SEAM_GLUE).toBe("\n\n");
  });

  it("档① 取原字节；档② 取 JSON 反序列化文本 —— 两档口径不同，不能混用", () => {
    // 档①：content 就是裸文本
    expect(prod.visibleTextOfPiece(piece({ tier: "block", content: "# alpha\n正文" }))).toBe("# alpha\n正文");
    // 档②：content 是 JSON 串（如 "\"hello\""）⇒ 必须反序列化
    expect(prod.visibleTextOfPiece(piece({ tier: "message", content: JSON.stringify("hello") }))).toBe("hello");
    // 反例：档② 直接返回 content 会把引号带出来（这正是"不能混用"的证据）
    expect(prod.visibleTextOfPiece(piece({ tier: "message", content: JSON.stringify("hello") }))).not.toBe(
      JSON.stringify("hello"),
    );
  });

  it("restoredVisibleText = 按窗口序无分隔符拼接（胶水不在这里，由重建侧补）", () => {
    const pieces = [
      piece({ tier: "block", content: "A", seq: 0 }),
      piece({ tier: "message", content: JSON.stringify("B"), seq: 1 }),
      piece({ tier: "block", content: "C", seq: 2 }),
    ];
    expect(prod.restoredVisibleText(pieces)).toBe("ABC");
    expect(prod.restoredVisibleText(pieces)).not.toContain(prod.SEAM_GLUE);
    expect(prod.restoredVisibleText([])).toBe("");
  });
});
