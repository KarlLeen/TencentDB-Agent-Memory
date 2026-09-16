/**
 * `163` 工具调用素材单测 —— deriveToolCallObserved（纯函数，零 IO）。
 *
 * 断言面：
 *   - 非 key shell 命令（grep/diff）⇒ 产（含 command_surface + exit_status + toolUseId）；
 *   - key 命令（pytest/git commit）⇒ **不产**（已是决策单元，不重复记录）；
 *   - 非命令面工具（Read/Grep 文件工具）⇒ 不产（commandSurfaceTextOf 返回 undefined）；
 *   - 窗口末条不落（半成品纪律）；
 *   - 独立槽位带 `TOOL_CALL_OBSERVED_SEQ_BASE`（与单元/变更槽位不交）。
 */
import { describe, expect, it } from "vitest";

import {
  EVENT_TYPE_TOOL_CALL_OBSERVED,
  TOOL_CALL_OBSERVED_SEQ_BASE,
  deriveToolCallObserved,
  toolCallObservedPayload,
} from "../tool-call-observed.js";

// ── 消息构造器（anthropic content-block 形状，与 runner 测试同款）────────────────

function uText(text: string): unknown {
  return { role: "user", content: text };
}
function uResult(id: string, content = "ok", isError = false): unknown {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] };
}
function aTool(toolUseId: string, name: string, input: Record<string, unknown>): unknown {
  return { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name, input }] };
}

describe("163 · 工具调用素材（deriveToolCallObserved）", () => {
  it("非 key shell 命令（grep/diff）⇒ 产；key 命令（pytest/git commit）⇒ 不产；非命令面 ⇒ 不产", () => {
    const recs = deriveToolCallObserved(
      [
        uText("跑测试"),
        aTool("t1", "execute_command", { command: "pytest -q" }), // key（test.run）⇒ 不产
        uResult("t1"),
        aTool("t2", "execute_command", { command: "grep -rn 'FAILED' /tmp/log | sort" }), // 非 key ⇒ 产
        uResult("t2", "3 failed", true), // is_error=true ⇒ exit_status=error
        aTool("t3", "execute_command", { command: "git commit --signoff" }), // key（git.commit）⇒ 不产
        uResult("t3"),
        aTool("t4", "Grep", { pattern: "x", path: "." }), // 非命令面（文件工具）⇒ 不产
        uResult("t4"),
        aTool("t5", "execute_command", { command: "diff clean-main ours" }), // 非 key ⇒ 产
        uResult("t5", "diff output", false), // is_error=false ⇒ exit_status=ok
        uText("收尾"),
      ],
      "anthropic",
    );

    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({
      toolName: "execute_command",
      toolUseId: "t2",
      exitStatus: "error",
    });
    expect(recs[0]!.commandSurface).toContain("grep");
    expect(recs[1]).toMatchObject({
      toolName: "execute_command",
      toolUseId: "t5",
      exitStatus: "ok",
    });
    expect(recs[1]!.commandSurface).toContain("diff");
    console.log(`163 派生 → ${recs.map((r) => `${r.toolUseId}:${r.exitStatus}`).join(" ")}`);
  });

  it("独立槽位带：msgSeq = TOOL_CALL_OBSERVED_SEQ_BASE + anchor×16 + eventPos", () => {
    const recs = deriveToolCallObserved(
      [
        uText("开始"),
        aTool("g1", "execute_command", { command: "grep -rn gate_" }), // index=1
        uResult("g1"),
        uText("结束"),
      ],
      "anthropic",
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]!.msgSeq).toBe(TOOL_CALL_OBSERVED_SEQ_BASE + 1 * 16 + 0);
  });

  it("窗口末条不落（半成品纪律）：命令在末条 ⇒ 不产", () => {
    const recs = deriveToolCallObserved(
      [uText("开始"), aTool("g1", "execute_command", { command: "grep -rn gate_" })],
      "anthropic",
    );
    expect(recs).toHaveLength(0);
  });

  it("无配对结果 ⇒ exit_status=null（如实标注，不猜）", () => {
    // g1 有配对结果（ok）；g2 无配对结果但非末条（后面还有消息）⇒ exit_status=null
    const recs = deriveToolCallObserved(
      [
        uText("开始"),
        aTool("g1", "execute_command", { command: "cat file.txt" }),
        uResult("g1"),
        aTool("g2", "execute_command", { command: "wc -l file.txt" }), // 无结果配对
        uText("结束"),
      ],
      "anthropic",
    );
    expect(recs.map((r) => [r.toolUseId, r.exitStatus])).toEqual([
      ["g1", "ok"],
      ["g2", null],
    ]);
  });

  it("payload 键集合：tool/command_surface/toolUseId + exit_status(可选) + units", () => {
    const recs = deriveToolCallObserved(
      [uText("开始"), aTool("g1", "execute_command", { command: "diff a b" }), uResult("g1"), uText("结束")],
      "anthropic",
    );
    const payload = toolCallObservedPayload(recs[0]!);
    expect(Object.keys(payload).sort()).toEqual(
      ["command_surface", "exit_status", "tool", "toolUseId", "units"].sort(),
    );
    expect(payload.command_surface).toBe("diff a b");
    expect(EVENT_TYPE_TOOL_CALL_OBSERVED).toBe("tool_call.observed");
  });
});
