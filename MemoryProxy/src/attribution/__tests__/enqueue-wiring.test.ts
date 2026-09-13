/**
 * 基座-a 单测：触发接线（runner → 入队）。
 * 覆盖 design §5 的 T12（缺省回归）、T13（触发接线）。
 *
 * 动态 import 是异步的（design §4.6）⇒ 断言前必须让出一次宏任务。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AttributionEventRepo,
  AttributionEventRow,
  AttributionEventRowWithRowid,
  NewAttributionEvent,
} from "../../db/attributionEventRepo.js";
import { __resetAttributionEventRepoForTests, setAttributionEventRepo } from "../../db/attributionEventRepo.js";
import { __resetDecisionUnitStateForTests, runDecisionUnitExtraction } from "../../decision-units/decision-unit-runner.js";
import { EVENT_TYPE_AGENT_TOOL_CHANGE } from "../../decision-units/tool-change-records.js";
import type { AttributionJudgeQueueRepo, JudgeQueueRow } from "../judge-queue-repo.js";
import { setAttributionJudgeQueueRepo } from "../judge-queue-repo.js";
import { queueRepo, teardownTempDb, withTempDb } from "./_helpers/base-harness.js";

// ── fake 事件 repo（只需 appendMany / listBySession）──────────────────────────────

class FakeEventRepo implements AttributionEventRepo {
  readonly events: NewAttributionEvent[] = [];
  /** 122 · C3①：仿 S3 幂等锚（idx_ae_unit_dedupe）——撞锚行**跳过**并计数（appendMany 的真实行为）。 */
  skipped = 0;
  private readonly anchorKeys = new Set<string>();
  appendMany(events: NewAttributionEvent[]): void {
    for (const e of events) {
      const anchor: (string | number | null)[] = [e.sessionKey, e.turnSeq ?? null, e.msgSeq ?? null];
      if (anchor.every((v) => v !== null)) {
        const key = JSON.stringify(anchor);
        if (this.anchorKeys.has(key)) {
          this.skipped += 1;
          continue;
        }
        this.anchorKeys.add(key);
      }
      this.events.push(e);
    }
  }
  append(e: NewAttributionEvent): void {
    this.appendMany([e]);
  }
  listBySession(): AttributionEventRow[] {
    return [];
  }
  listByAsset(): AttributionEventRow[] {
    return [];
  }
  /** 122 · C1：helper 经此读"锚主"（落库事实）——返回当前已落行的全列形状。 */
  listBySessionWithRowid(sessionKey: string): AttributionEventRowWithRowid[] {
    return this.events
      .filter((e) => e.sessionKey === sessionKey)
      .map((e, i) => ({
        rowid: i + 1,
        event_id: `ev-${i}`,
        space_id: e.spaceId ?? "_default",
        user_id: e.userId ?? null,
        agent_source: e.agentSource ?? null,
        session_key: e.sessionKey,
        turn_seq: e.turnSeq ?? null,
        msg_seq: e.msgSeq ?? null,
        event_type: e.eventType,
        asset_id: e.assetId ?? null,
        asset_type: e.assetType ?? null,
        unit_id: e.unitId ?? null,
        payload_json: JSON.stringify(e.payload ?? {}),
        created_at: Date.now(),
      }));
  }
  distinctSessionKeys() {
    return [];
  }
}

// ── fake 队列 repo（只数入队，别的都不参与）─────────────────────────────────────

class CountingQueueRepo implements AttributionJudgeQueueRepo {
  enqueued: string[] = [];
  throwOnEnqueue = false;
  enqueue(item: { unitId: string }): boolean {
    if (this.throwOnEnqueue) throw new Error("queue exploded");
    this.enqueued.push(item.unitId);
    return true;
  }
  claimBatch(): JudgeQueueRow[] {
    return [];
  }
  complete(): boolean {
    return false;
  }
  fail(): null {
    return null;
  }
  retryFailed(): number {
    return 0;
  }
  get(): JudgeQueueRow | null {
    return null;
  }
  listByStatus(): JudgeQueueRow[] {
    return [];
  }
  countByStatus(): Record<string, number> {
    return {};
  }
  latestByUnit(): JudgeQueueRow | null {
    return null;
  }
  distinctSessionKeys(): string[] {
    return [];
  }
  listBySession(): JudgeQueueRow[] {
    return [];
  }
}

let eventRepo: FakeEventRepo;

/**
 * 等到条件成立（或超时）。**不能**用固定次数的 setImmediate：动态 import 要走
 * 模块解析 + transform，tick 数不保证（实测 ≥3，vitest 冷/热态不同）⇒ 固定 tick 会 flaky。
 */
const waitFor = async (cond: () => boolean, timeoutMs = 3000): Promise<void> => {
  const started = Date.now();
  while (!cond() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** 一条 restraint 消息序列：uText → aTool(Edit) → uResult ⇒ 恰好密封 1 个单元。 */
const RESTRAINT_MESSAGES: unknown[] = [
  { role: "user", content: "给 a.ts 加个函数" },
  { role: "assistant", content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "a.ts" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] },
];

function run(config: unknown): void {
  runDecisionUnitExtraction({
    config: config as never,
    protocol: "anthropic",
    mainDialog: true,
    hasConversation: true,
    sessionKey: "sess-1",
    spaceId: "space-1",
    userId: "user-1",
    agentSource: "codebuddy",
    messages: RESTRAINT_MESSAGES,
  });
}

/** `149`：runner 现在**另落**变更行（`agent.tool.change`）⇒ 单元断言只看单元事件（与入队语义无关）。 */
const unitEvents = (): NewAttributionEvent[] =>
  eventRepo.events.filter((e) => e.eventType !== EVENT_TYPE_AGENT_TOOL_CHANGE);

const ENABLED = { injection: { decisionUnitExtractor: { enabled: true } } };
/** 给反面断言一个"会发生的话早该发生了"的窗口。 */
const settle = async (ms = 80): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

beforeEach(() => {
  withTempDb();
  eventRepo = new FakeEventRepo();
  setAttributionEventRepo(eventRepo);
  __resetDecisionUnitStateForTests();
});

afterEach(() => {
  __resetAttributionEventRepoForTests();
  teardownTempDb();
});

describe("T12 缺省回归（enqueue=false 时零访问）", () => {
  it("决策单元照常落库；队列 0 行；连模块都不加载", async () => {
    run(ENABLED); // 不带 attribution ⇒ 缺省 false
    expect(unitEvents()).toHaveLength(1);

    await settle();
    // 真库队列 0 行（零访问的直接证据）
    expect(queueRepo().countByStatus()).toEqual({});
  });

  it("显式 enqueue:false 与缺省等价；其它值（含字符串 true / 数字 1）也不放行", async () => {
    for (const value of [false, undefined, "true", 1, null] as unknown[]) {
      __resetDecisionUnitStateForTests();
      eventRepo = new FakeEventRepo();
      setAttributionEventRepo(eventRepo);
      run({ ...ENABLED, attribution: { judge: { enqueue: value } } });
      expect(unitEvents()).toHaveLength(1);
    }
    await settle();
    expect(queueRepo().countByStatus()).toEqual({});
  });
});

describe("T13 触发接线", () => {
  it("落库后调用入队，fake queue 计数 = 落库单元数", async () => {
    const fake = new CountingQueueRepo();
    setAttributionJudgeQueueRepo(fake);

    run({ ...ENABLED, attribution: { judge: { enqueue: true } } });
    expect(unitEvents()).toHaveLength(1);

    await waitFor(() => fake.enqueued.length > 0);
    expect(fake.enqueued).toHaveLength(1);
    // unit_id 用的是 v1 内容哈希（幂等键的来源），不是别的东西
    expect(fake.enqueued[0]).toBe(unitEvents()[0]!.unitId);
  });

  it("多单元落库 ⇒ 逐步入队；同单元重放（events 被 appendMany 去重）不重复入队", async () => {
    const fake = new CountingQueueRepo();
    setAttributionJudgeQueueRepo(fake);

    run({ ...ENABLED, attribution: { judge: { enqueue: true } } });
    await waitFor(() => fake.enqueued.length > 0);
    expect(fake.enqueued).toHaveLength(1);

    // 原样重放：runner 水位线不推进 ⇒ 不产生新单元 ⇒ 不重复入队
    run({ ...ENABLED, attribution: { judge: { enqueue: true } } });
    await settle();
    expect(fake.enqueued).toHaveLength(1);
    expect(unitEvents()).toHaveLength(1);
  });

  it("入队抛错不影响落库（fire-and-forget）", async () => {
    const fake = new CountingQueueRepo();
    fake.throwOnEnqueue = true;
    setAttributionJudgeQueueRepo(fake);

    expect(() => run({ ...ENABLED, attribution: { judge: { enqueue: true } } })).not.toThrow();
    // 等到"入队确实被尝试过"（抛错发生在 enqueue 内 ⇒ 计数永远 0，只能靠时间窗兜）
    await settle();

    // 落库照旧（这是关键：入队绝不能拖垮 v1 链路）
    expect(unitEvents()).toHaveLength(1);
    expect(fake.enqueued).toHaveLength(0);
  });
});

describe("122 · C3①/C3② 入队集合 = 实际落库的那一份（同锚胜者唯一化）", () => {
  const uText = (text: string): unknown => ({ role: "user", content: text });
  const aTool = (id: string, name: string, input: Record<string, unknown>): unknown => ({
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
  });
  const uResult = (id: string): unknown => ({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
  });

  const runMessages = (messages: unknown[]): void => {
    runDecisionUnitExtraction({
      config: { ...ENABLED, attribution: { judge: { enqueue: true } } } as never,
      protocol: "anthropic",
      mainDialog: true,
      hasConversation: true,
      sessionKey: "sess-1",
      spaceId: "space-1",
      userId: "user-1",
      agentSource: "codebuddy",
      messages,
    });
  };

  it("同槽位重放（内容变 ⇒ 新 unit_id）⇒ 撞锚行不得入队；不同槽位不误杀", async () => {
    const fake = new CountingQueueRepo();
    setAttributionJudgeQueueRepo(fake);

    // 首跑：两个不同槽位的单元（a.ts / b.ts）⇒ 都应入队（C3② 不误杀）
    const first = [
      uText("给 a.ts 加个函数"),
      aTool("e1", "Edit", { file_path: "a.ts", new_string: "x" }),
      uResult("e1"),
      uText("再改 b.ts"),
      aTool("e2", "Edit", { file_path: "b.ts", new_string: "y" }),
      uResult("e2"),
    ];
    runMessages(first);
    await waitFor(() => fake.enqueued.length >= 2);
    expect(fake.enqueued).toHaveLength(2);

    // 第二跑：缩短窗口（len 5 < 水位 6 ⇒ 全量重放）+ a.ts 参数改 "x"→"x2"
    // ⇒ a.ts 单元内容变（新 unit_id）、位置不变（同槽位）⇒ appendMany 撞锚跳过该行。
    // 修复前：被跳过的行仍入队（幽灵单元，122 F6）⇒ enqueued 会变 3 ⇒ 红。
    const replayed = [
      uText("给 a.ts 加个函数"),
      aTool("e1", "Edit", { file_path: "a.ts", new_string: "x2" }),
      uResult("e1"),
      uText("再改 b.ts"),
      aTool("e2", "Edit", { file_path: "b.ts", new_string: "y" }),
    ];
    runMessages(replayed);
    await settle();

    expect(eventRepo.skipped, "appendMany 确实吞了撞锚行（锚在工作）").toBeGreaterThan(0);
    expect(fake.enqueued, "撞锚的新 unit 不得入队（修复前此处为 3）").toHaveLength(2);
  });
});
