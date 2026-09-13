/**
 * 66 · 单元 B：`task_boundary` 生产（60 spec §4；裁定见勘正 3 裁定 ② = 结构信号优先）。
 *
 * 边界信号 = **epoch 切换**（复用 runner 既有 compaction 水位归零机制：
 * `messageCount < watermark` ⇒ 归零重放）⇒ 该批入队带 `trigger="task_boundary"`；
 * 无信号批 = `decision_unit`（负向）。**不做自由词表**。
 * 反向控制（手工、用后即还原）：R3 无信号也产 ⇒ 本文件负向格必红（rejudge.test.ts 的 T4
 * 负向不经 runner、保留成立）。
 */
import { describe, expect, it } from "vitest";

import { buildConfig } from "../../config.js";
import { getDb } from "../../db/index.js";
import {
  __resetDecisionUnitStateForTests,
  runDecisionUnitExtraction,
} from "../../decision-units/decision-unit-runner.js";
import { getAttributionWriteCounters } from "../../db/attributionEventRepo.js";
import { __resetAttributionJudgeQueueRepoForTests } from "../judge-queue-repo.js";
import { __resetAttributionStatusEventsRepoForTests } from "../status-events-repo.js";
import { teardownTempDb, withTempDb } from "./_helpers/base-harness.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return true;
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
}

function queueTriggers(sessionKey: string): Array<{ trigger: string; round: number }> {
  return getDb()!
    .prepare("SELECT trigger, round FROM attribution_judge_queue WHERE session_key = ? ORDER BY queue_id ASC")
    .all(sessionKey) as Array<{ trigger: string; round: number }>;
}

describe("66 · 单元 B：task_boundary 生产（compaction = 边界信号）", () => {
  function anthropicTurns(pairs: Array<{ ask: string; file: string; id: string }>): unknown[] {
    const out: unknown[] = [];
    for (const p of pairs) {
      out.push({ role: "user", content: p.ask });
      out.push({
        role: "assistant",
        content: [{ type: "tool_use", id: p.id, name: "Edit", input: { file_path: p.file, old_string: "a", new_string: "b" } }],
      });
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: p.id, content: "ok" }] });
    }
    return out;
  }

  function enqueueOnConfig(): ReturnType<typeof buildConfig> {
    const cfg = buildConfig({});
    cfg.injection = { ...cfg.injection, decisionUnitExtractor: { enabled: true } };
    cfg.attribution = {
      judge: { ...cfg.attribution!.judge, enqueue: true },
    };
    return cfg;
  }

  it("compaction（消息数回落 = epoch 切换）⇒ 该批 trigger=task_boundary 且 round=0；无信号批 = decision_unit", async () => {
    withTempDb();
    try {
      __resetDecisionUnitStateForTests();
      const S = "sess-tb";
      const cfg = enqueueOnConfig();

      // 第一批（5 条消息，无 compaction）⇒ 2 单元，trigger=decision_unit
      const m5 = anthropicTurns([
        { ask: "改 skl-tb-1.ts", file: "skl-tb-1.ts", id: "tb-1" },
        { ask: "再改 skl-tb-2.ts", file: "skl-tb-2.ts", id: "tb-2" },
      ]);
      runDecisionUnitExtraction({
        config: cfg,
        protocol: "anthropic",
        mainDialog: true,
        hasConversation: true,
        messages: m5 as unknown[],
        sessionKey: S,
        spaceId: "sp-tb",
      });
      expect(await waitFor(() => queueTriggers(S).length >= 2), "第一批未入队").toBe(true);
      const first = queueTriggers(S);
      console.log(`66 单元B 第一批 → ${JSON.stringify(first)}`);
      expect(first.every((r) => r.trigger === "decision_unit")).toBe(true);


      // 第二批（**编号漂移批**，122 后的现实 task_boundary 构造）：窗口 = 第一批尾部 2 条 + 新一对
      // （长度 5 < 水位 6 ⇒ compacted；编号从新窗口重算 ⇒ t9 落 (turn1, msg48)，与旧单元 (1,16)/… 不同槽位
      // ⇒ 不撞 S3 锚）+ 内容新（新 unit_id）⇒ 新单元落库并入队，该批带 trigger=task_boundary。
      const drift = [m5[4]!, m5[5]!, ...anthropicTurns([{ ask: "改 skl-tb-9.ts", file: "skl-tb-9.ts", id: "tb-9" }])];
      runDecisionUnitExtraction({
        config: cfg,
        protocol: "anthropic",
        mainDialog: true,
        hasConversation: true,
        messages: drift as unknown[],
        sessionKey: S,
        spaceId: "sp-tb",
      });
      expect(await waitFor(() => queueTriggers(S).length >= 3), "编号漂移批未入队").toBe(true);

      // 第三批（撞锚批）：3 条消息 < 水位（漂移批后水位=5）⇒ 仍 compacted；内容为全新对但**位置与 tb-1 同槽位**
      // （窗口从 index0 起 ⇒ (1,16)）⇒ appendMany 撞 S3 锚吞该行 ⇒ **不入队**（122 C3①；修复前本格依赖"幽灵入队"）。
      const conflictsBefore = getAttributionWriteCounters().dedupeConflicts;
      const m3 = anthropicTurns([{ ask: "改 skl-tb-3.ts", file: "skl-tb-3.ts", id: "tb-3" }]);
      runDecisionUnitExtraction({
        config: cfg,
        protocol: "anthropic",
        mainDialog: true,
        hasConversation: true,
        messages: m3 as unknown[],
        sessionKey: S,
        spaceId: "sp-tb",
      });
      expect(
        await waitFor(() => getAttributionWriteCounters().dedupeConflicts > conflictsBefore),
        "撞锚批未触发 S3 锚（应吞掉同槽位行）",
      ).toBe(true);
      expect(queueTriggers(S), "122：被锚吞掉的行不得入队（修复前 = 4，幽灵）").toHaveLength(3);

      const all = queueTriggers(S);
      console.log(`66 单元B 全量 → ${JSON.stringify(all)}`);
      expect(all.length).toBe(3);
      const boundaryRows = all.filter((r) => r.trigger === "task_boundary");
      expect(boundaryRows.length, "compaction 批应带 task_boundary").toBeGreaterThanOrEqual(1);
      expect(boundaryRows.every((r) => r.round === 0), "trigger 不改变 round 账本（仍 0=首判）").toBe(true);
      // 无信号批不得带 task_boundary（负向，与 rejudge.test.ts 的 T4 同族）
      expect(all.filter((r) => r.trigger === "decision_unit").length).toBeGreaterThanOrEqual(2);

      // 收窄后的 §16.3 语义：task_boundary 只由边界信号产（负向在无 compaction 场景仍成立）
      __resetDecisionUnitStateForTests();
      const S2 = "sess-tb-none";
      runDecisionUnitExtraction({
        config: cfg,
        protocol: "anthropic",
        mainDialog: true,
        hasConversation: true,
        messages: anthropicTurns([{ ask: "改 skl-tb-x.ts", file: "skl-tb-x.ts", id: "tb-x" }]) as unknown[],
        sessionKey: S2,
        spaceId: "sp-tb",
      });
      expect(await waitFor(() => queueTriggers(S2).length >= 1)).toBe(true);
      console.log(`66 单元B 无信号 → ${JSON.stringify(queueTriggers(S2))}`);
      expect(queueTriggers(S2).every((r) => r.trigger !== "task_boundary")).toBe(true);
    } finally {
      __resetDecisionUnitStateForTests();
      __resetAttributionJudgeQueueRepoForTests();
      __resetAttributionStatusEventsRepoForTests();
      teardownTempDb();
    }
  });
});
