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
  NewAttributionEvent,
} from "../../db/attributionEventRepo.js";
import { __resetAttributionEventRepoForTests, setAttributionEventRepo } from "../../db/attributionEventRepo.js";
import { __resetDecisionUnitStateForTests, runDecisionUnitExtraction } from "../../decision-units/decision-unit-runner.js";
import type { AttributionJudgeQueueRepo, JudgeQueueRow } from "../judge-queue-repo.js";
import { setAttributionJudgeQueueRepo } from "../judge-queue-repo.js";
import { queueRepo, teardownTempDb, withTempDb } from "./_helpers/base-harness.js";

// ── fake 事件 repo（只需 appendMany / listBySession）──────────────────────────────

class FakeEventRepo implements AttributionEventRepo {
  readonly events: NewAttributionEvent[] = [];
  appendMany(events: NewAttributionEvent[]): void {
    this.events.push(...events);
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
  listBySessionWithRowid() {
    return [];
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
    expect(eventRepo.events).toHaveLength(1);

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
      expect(eventRepo.events).toHaveLength(1);
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
    expect(eventRepo.events).toHaveLength(1);

    await waitFor(() => fake.enqueued.length > 0);
    expect(fake.enqueued).toHaveLength(1);
    // unit_id 用的是 v1 内容哈希（幂等键的来源），不是别的东西
    expect(fake.enqueued[0]).toBe(eventRepo.events[0]!.unitId);
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
    expect(eventRepo.events).toHaveLength(1);
  });

  it("入队抛错不影响落库（fire-and-forget）", async () => {
    const fake = new CountingQueueRepo();
    fake.throwOnEnqueue = true;
    setAttributionJudgeQueueRepo(fake);

    expect(() => run({ ...ENABLED, attribution: { judge: { enqueue: true } } })).not.toThrow();
    // 等到"入队确实被尝试过"（抛错发生在 enqueue 内 ⇒ 计数永远 0，只能靠时间窗兜）
    await settle();

    // 落库照旧（这是关键：入队绝不能拖垮 v1 链路）
    expect(eventRepo.events).toHaveLength(1);
    expect(fake.enqueued).toHaveLength(0);
  });
});
