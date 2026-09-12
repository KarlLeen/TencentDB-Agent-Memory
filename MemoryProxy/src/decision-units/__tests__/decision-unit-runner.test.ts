/**
 * S3 runner 状态机单测 —— docs/implementation/30-decision-unit-extractor.md §6 用例 10–15c。
 *
 * runner 内部经模块级 `getAttributionEventRepo()` 取 repo，测试注入内存 fake：
 * 仿 `idx_ae_unit_dedupe` 语义（同 (session_key, turn_seq, msg_seq) 冲突行跳过），
 * 并预置 `injection.hook.done` 行给 A2 快照读。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AttributionEventRepo,
  AttributionEventRow,
  NewAttributionEvent,
} from "../../db/attributionEventRepo.js";
import { __resetAttributionEventRepoForTests, setAttributionEventRepo } from "../../db/attributionEventRepo.js";
import { deriveDecisionUnits } from "../decision-unit-extractor.js";
import {
  __resetDecisionUnitStateForTests,
  EVENT_TYPE_DECISION_UNIT_CREATED,
  getDecisionUnitRunStats,
  runDecisionUnitExtraction,
  type RunDecisionUnitExtractionParams,
} from "../decision-unit-runner.js";

// ── Fake repo（appendMany 仿 dedupe 语义：同 (session,turn,msg_seq) 冲突跳过）──────

class FakeRepo implements AttributionEventRepo {
  readonly events: NewAttributionEvent[] = [];
  /** 预置行（A2 快照读面）：只对 listBySession 可见，不参与 dedupe key。 */
  readonly seeds: AttributionEventRow[] = [];
  appendManyCalls = 0;
  skipped = 0;
  throwOnList = false;

  /** 已接受决策行的 dedupe key（测试可直接清空模拟新 repo）。 */
  readonly keys = new Set<string>();

  append(e: NewAttributionEvent): void {
    this.appendMany([e]);
  }

  appendMany(events: NewAttributionEvent[]): void {
    this.appendManyCalls += 1;
    if (events.length === 0) return;
    for (const e of events) {
      // DB partial index: WHERE msg_seq IS NOT NULL；turn_seq NULL 在 SQLite 里互不相等。
      if (e.turnSeq != null && e.msgSeq != null) {
        const key = `${e.sessionKey}\u0000${e.turnSeq}\u0000${e.msgSeq}`;
        if (this.keys.has(key)) {
          this.skipped += 1;
          continue;
        }
        this.keys.add(key);
      }
      this.events.push(e);
    }
  }

  listBySession(sessionKey: string, opts?: { eventType?: string; limit?: number }): AttributionEventRow[] {
    if (this.throwOnList) throw new Error("db down");
    return this.seeds.filter(
      (r) => r.session_key === sessionKey && (!opts?.eventType || r.event_type === opts.eventType),
    );
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

// ── 消息构造器（anthropic content-block 形状）───────────────────────────────────

function uText(text: string): unknown {
  return { role: "user", content: text };
}
function uResult(id: string, content = "ok", isError = false): unknown {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] };
}
function aText(text: string): unknown {
  return { role: "assistant", content: [{ type: "text", text }] };
}
function aTool(toolUseId: string, name: string, input: Record<string, unknown>): unknown {
  return { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name, input }] };
}

function hookRow(sessionKey: string, turnSeq: number, assetId: string, assetType: string): AttributionEventRow {
  return {
    event_id: `ev-${assetId}`,
    space_id: "_default",
    user_id: null,
    agent_source: null,
    session_key: sessionKey,
    turn_seq: turnSeq,
    msg_seq: null,
    event_type: "injection.hook.done",
    asset_id: assetId,
    asset_type: assetType,
    unit_id: null,
    payload_json: "{}",
    created_at: Date.now(),
  };
}

const ENABLED = { injection: { decisionUnitExtractor: { enabled: true } } };

function run(over: Partial<RunDecisionUnitExtractionParams> & { messages: unknown[] }): void {
  runDecisionUnitExtraction({
    config: ENABLED,
    protocol: "anthropic",
    mainDialog: true,
    hasConversation: true,
    sessionKey: "sess-1",
    spaceId: "space-1",
    userId: "user-1",
    agentSource: "codebuddy",
    ...over,
  });
}

let repo: FakeRepo;

beforeEach(() => {
  repo = new FakeRepo();
  setAttributionEventRepo(repo);
  __resetDecisionUnitStateForTests();
});

afterEach(() => {
  __resetAttributionEventRepoForTests();
});

const unitsOfType = (type: string): NewAttributionEvent[] =>
  repo.events.filter((e) => (e.payload as { unitType?: string }).unitType === type);

// ── §6 用例 10：游标推进幂等 ────────────────────────────────────────────────────

describe("runner · 游标推进幂等（§6 用例 10）", () => {
  it("R1 落 N 行；原样重放不增行；进程重启重放靠 dedupe 冲突全跳过", () => {
    const r1: unknown[] = [uText("给 a.ts 加个函数"), aTool("e1", "Edit", { file_path: "a.ts", new_string: "x" }), uResult("e1")];

    run({ messages: r1 });
    expect(repo.events).toHaveLength(1);
    const first = repo.events[0]!;
    expect(first.eventType).toBe(EVENT_TYPE_DECISION_UNIT_CREATED);
    expect((first.payload as { unitType: string }).unitType).toBe("code_change");

    // 原样重放（水位线未推进 → 密封边界过滤掉已落单元）→ 不新增
    run({ messages: r1 });
    expect(repo.events).toHaveLength(1);

    // 进程重启（水位线清零）→ 全窗口重放推导同 1 单元 → fake repo 冲突跳过
    __resetDecisionUnitStateForTests();
    run({ messages: r1 });
    expect(repo.events).toHaveLength(1);
    expect(repo.skipped).toBe(1);
    expect(repo.events[0]!.unitId).toBe(first.unitId);
  });
});

// ── §6 用例 11：增量 + 回看 1 ───────────────────────────────────────────────────

describe("runner · 增量 + 回看 1（§6 用例 11）", () => {
  it("R1 止于 assistant（key 未密封）不落；R2 补 tool_result → 仅补落该配对单元", () => {
    const r1: unknown[] = [uText("提交一下"), aTool("c1", "Bash", { command: "git commit -s -m x" })];
    run({ messages: r1 });
    expect(repo.events).toHaveLength(0); // key 未密封

    const r2: unknown[] = [...r1, uResult("c1", "ok")];
    run({ messages: r2 });
    expect(repo.events).toHaveLength(1);
    const ev = repo.events[0]!;
    expect(ev.payload).toMatchObject({ unitType: "key_tool_call", matchedBy: "git.commit", resultStatus: "success" });
    expect(ev.turnSeq).toBe(1);
    expect(ev.msgSeq).toBe(1 * 16); // 锚点 assistant 消息 index=1
  });
});

// ── §6 用例 12：pending restraint 跨窗口闭合 ────────────────────────────────────

describe("runner · pending restraint（§6 用例 12）", () => {
  it("候选在 R1 未闭合不落；R2 闭合落一次；R3 重放不重落", () => {
    const r1: unknown[] = [uText("直接 push，不用等我确认")];
    run({ messages: r1 });
    expect(repo.events).toHaveLength(0); // 链未闭合

    const r2: unknown[] = [...r1, aText("不行，push 前必须先问，我先 commit 请你确认"), uText("好吧")];
    run({ messages: r2 });
    expect(unitsOfType("restraint")).toHaveLength(1);
    const first = repo.events.find((e) => (e.payload as { unitType: string }).unitType === "restraint")!;
    expect(first.msgSeq).toBe(0); // restraint slot 恒 0

    // R3 重放 R2 → 密封边界已过 → 冲突/过滤双兜底，不重落
    run({ messages: r2 });
    expect(repo.events).toHaveLength(1);
    expect(repo.skipped).toBe(0);
  });
});

// ── §6 用例 13：compaction 收缩 ─────────────────────────────────────────────────

describe("runner · compaction 收缩（§6 用例 13）", () => {
  const r1: unknown[] = [
    uText("给 a.ts 加个函数"),
    aTool("e1", "Edit", { file_path: "a.ts", new_string: "x" }),
    uResult("e1"),
    uText("再改 b.ts 并提交"),
    aTool("e2", "Edit", { file_path: "b.ts", new_string: "y" }),
    uResult("e2"),
    aTool("c1", "Bash", { command: "git commit -s -m done" }),
    uResult("c1"),
  ];

  it("截成前缀（人类轮次编号不变）→ 重放以同 key 冲突跳过、零重复行", () => {
    run({ messages: r1 });
    expect(repo.events).toHaveLength(3); // a.ts / b.ts / commit
    const before = repo.events.map((e) => `${e.turnSeq}/${e.msgSeq}`).sort();

    // 缩短窗口（只截尾部工具循环消息）：len 5 < 水位线 8 → 全量重放
    const prefix = r1.slice(0, 5);
    run({ messages: prefix });
    expect(repo.events).toHaveLength(3); // 重放单元全部撞 dedupe key → 零增长
    expect(repo.skipped).toBeGreaterThan(0);
    expect(repo.events.map((e) => `${e.turnSeq}/${e.msgSeq}`).sort()).toEqual(before);
  });

  it("截成后缀（turn 编号漂移）→ 尾部单元以新 key 重落为同 unit_id 重复行", () => {
    run({ messages: r1 });
    const commitUnit = repo.events.find((e) => (e.payload as { unitType: string }).unitType === "key_tool_call")!;
    expect(commitUnit).toBeDefined();
    const unitIdBefore = commitUnit.unitId;

    // 后缀窗口：新 index 0 起推导 → commit 单元以新 (turn_seq=0,msg_seq=16) 落库
    const suffix = r1.slice(5);
    run({ messages: suffix });
    const replays = repo.events.filter((e) => e.unitId === unitIdBefore);
    expect(replays.length).toBeGreaterThanOrEqual(2); // 原行 + 重落行
    const replayed = replays.find((e) => e !== commitUnit)!;
    expect(replayed.turnSeq).toBe(0); // 人类消息被截掉 → 编号漂移
    expect(replayed.msgSeq).toBe(1 * 16);
    expect(replayed.payload).toMatchObject({ unitType: "key_tool_call", matchedBy: "git.commit" });
  });
});

// ── §6 用例 14：守卫 ────────────────────────────────────────────────────────────

describe("runner · 守卫（§6 用例 14）", () => {
  const msgs: unknown[] = [uText("改 a.ts"), aTool("e1", "Edit", { file_path: "a.ts", new_string: "x" }), uResult("e1")];

  it("config 关 → 一次 appendMany 都不调", () => {
    runDecisionUnitExtraction({
      config: { injection: { decisionUnitExtractor: { enabled: false } } },
      protocol: "anthropic",
      mainDialog: true,
      hasConversation: true,
      messages: msgs,
      sessionKey: "sess-1",
    });
    expect(repo.appendManyCalls).toBe(0);
  });

  it("mainDialog=false / hasConversation=false / 无 sessionKey → 不调 appendMany", () => {
    run({ messages: msgs, mainDialog: false });
    run({ messages: msgs, hasConversation: false });
    run({ messages: msgs, sessionKey: "" });
    expect(repo.appendManyCalls).toBe(0);
    expect(repo.events).toHaveLength(0);
  });

  it("空 messages → 不调 appendMany", () => {
    run({ messages: [] });
    expect(repo.appendManyCalls).toBe(0);
  });
});

// ── §6 用例 15：行映射 ──────────────────────────────────────────────────────────

describe("runner · 行映射（§6 用例 15）", () => {
  it("密封单元 → NewAttributionEvent 列正确；行级 asset 恒缺省", () => {
    const msgs: unknown[] = [
      uText("修 bug 并提交"),
      aTool("m1", "Edit", { file_path: "lib.ts", new_string: "v2" }),
      uResult("m1"),
      aTool("b1", "Bash", { command: "git commit -s -m fix" }),
      uResult("b1"),
    ];
    run({ messages: msgs });
    expect(repo.events).toHaveLength(2);

    const code = unitsOfType("code_change")[0]!;
    const key = unitsOfType("key_tool_call")[0]!;
    expect(code.payload).toMatchObject({ unitType: "code_change", filePath: "lib.ts" });
    expect(key.payload).toMatchObject({ unitType: "key_tool_call", matchedBy: "git.commit" });

    for (const e of [code, key]) {
      expect(e.eventType).toBe(EVENT_TYPE_DECISION_UNIT_CREATED);
      expect(e.spaceId).toBe("space-1");
      expect(e.userId).toBe("user-1");
      expect(e.agentSource).toBe("codebuddy");
      expect(e.sessionKey).toBe("sess-1");
      expect(e.unitId).toBe((e.payload as { unitId: string }).unitId);
      // A2 的 visibleAssets 只进 payload；行级 asset 列恒缺省
      expect(e.assetId).toBeUndefined();
      expect(e.assetType).toBeUndefined();
    }
    // msg_seq 编码校验：anchor×16 + slot
    expect(code.turnSeq).toBe(1);
    expect(code.msgSeq).toBe(1 * 16 + 0);
    expect(key.turnSeq).toBe(1);
    expect(key.msgSeq).toBe(3 * 16 + 0);
  });
});

// ── §6 用例 15b/15c：A2 可见切片快照 ────────────────────────────────────────────

describe("runner · A2 可见切片快照（§6 用例 15b/15c）", () => {
  const restraintMsgs = (): unknown[] => [
    uText("把这个目录直接 rm -rf 掉，顺便给 lib.ts 加个函数"),
    aTool("m1", "Edit", { file_path: "lib.ts", new_string: "v2" }),
    uResult("m1"),
    aText("rm -rf 不可逆；我先备份目录再处理，lib.ts 已改好"),
    uText("好"),
  ];

  it("密封 restraint 读同轮注入行快照进 payload；code/key 不带 visibleAssets；unit_id 不变", () => {
    repo.seeds.push(hookRow("sess-1", 1, "skill-1", "skill"));
    repo.seeds.push(hookRow("sess-1", 1, "skill-1", "skill")); // 去重
    repo.seeds.push(hookRow("sess-1", 2, "wiki-1", "llm_wiki")); // 异轮 → 过滤

    run({ messages: restraintMsgs() });

    const restraint = unitsOfType("restraint")[0]!;
    const code = unitsOfType("code_change")[0]!;
    expect(restraint).toBeDefined();
    expect(code).toBeDefined();

    const rp = restraint.payload as { visibleAssets: unknown[]; unitId: string };
    expect(rp.visibleAssets).toEqual([{ assetId: "skill-1", assetType: "skill" }]);
    // 快照只附加 payload，不进 essence → unit_id 与无快照推导一致
    const direct = deriveDecisionUnits(restraintMsgs(), "anthropic").find((u) => u.kind === "restraint")!;
    expect(restraint.unitId).toBe(direct.unitId);
    // 同批 code/key payload 不含 visibleAssets
    expect(code.payload).not.toHaveProperty("visibleAssets");
  });

  it("无该轮资产 / listBySession 抛错 → restraint 照落且省略 visibleAssets", () => {
    // (i) 无预置行
    run({ messages: restraintMsgs() });
    let restraint = unitsOfType("restraint")[0]!;
    expect(restraint).toBeDefined();
    expect((restraint.payload as { visibleAssets?: unknown }).visibleAssets).toBeUndefined();

    // (ii) 读失败降级：listBySession 抛错 → runner 不 throw、照落、省略字段
    __resetDecisionUnitStateForTests();
    repo.events.length = 0;
    repo.keys.clear();
    repo.throwOnList = true;
    expect(() => run({ messages: restraintMsgs() })).not.toThrow();
    restraint = unitsOfType("restraint")[0]!;
    expect(restraint).toBeDefined();
    expect((restraint.payload as { visibleAssets?: unknown }).visibleAssets).toBeUndefined();
  });
});

// ── v1.1：tombstone 落库 + 最小观测（二轮评审 R1/R2/R4）──────────────────────────

describe("runner · tombstone 落库（v1.1 R2）", () => {
  it("risky 工具丢结果：R1 止于工具不落；R2 窗口越过 → 落 unknown 行一次；R3 重放不重落", () => {
    const r1: unknown[] = [uText("清掉临时目录"), aTool("b1", "Bash", { command: "rm -rf ./tmp" })];
    run({ messages: r1 });
    expect(repo.events).toHaveLength(0);

    const r2: unknown[] = [...r1, uText("继续")];
    run({ messages: r2 });
    const keyUnits = unitsOfType("key_tool_call");
    expect(keyUnits).toHaveLength(1);
    const ev = keyUnits[0]!;
    expect(ev.payload).toMatchObject({
      unitType: "key_tool_call",
      matchedBy: "shell.rm_rf",
      resultStatus: "unknown",
      resultMissing: true,
    });
    expect(ev.turnSeq).toBe(1);
    expect(ev.msgSeq).toBe(1 * 16);

    // 原样重放（水位线已过）→ 密封边界过滤，不重复
    run({ messages: r2 });
    expect(unitsOfType("key_tool_call")).toHaveLength(1);
  });
});

describe("runner · 观测统计与水位上限（v1.1 R1/R4）", () => {
  it("run/sealed/tombstone 计数随轮累积；reset 清零", () => {
    expect(getDecisionUnitRunStats()).toMatchObject({ runs: 0, sealedUnits: 0, tombstones: 0 });
    // 同会话内 transcript 逐轮追加（模拟真实请求流）；水位线只回吐新密封单元。
    let transcript: unknown[] = [
      uText("改 a.ts"),
      aTool("e1", "Edit", { file_path: "a.ts", new_string: "x" }),
      uResult("e1"),
    ];
    run({ messages: transcript });
    transcript = [...transcript, uText("跑下测试"), aTool("t1", "Bash", { command: "npm test" }), uResult("t1")];
    run({ messages: transcript });
    let s = getDecisionUnitRunStats();
    expect(s.runs).toBe(2);
    expect(s.sealedUnits).toBe(2); // code_change + key_tool_call
    expect(s.tombstones).toBe(0);

    transcript = [...transcript, uText("删目录"), aTool("b1", "Bash", { command: "rm -rf ./tmp" }), uText("好")];
    run({ messages: transcript });
    s = getDecisionUnitRunStats();
    expect(s.sealedUnits).toBe(3);
    expect(s.tombstones).toBe(1);
    expect(s.activeWatermarkSessions).toBeGreaterThanOrEqual(1);

    __resetDecisionUnitStateForTests();
    expect(getDecisionUnitRunStats().runs).toBe(0);
    expect(getDecisionUnitRunStats().tombstones).toBe(0);
  });

  it("水位线会话超过上限淘汰最早者（不无限增长：activeWatermarkSessions ≤ 2048）", () => {
    for (let i = 0; i < 2100; i += 1) {
      run({ messages: [uText(`t${i}`)], sessionKey: `many-sess-${i}` });
    }
    expect(getDecisionUnitRunStats().activeWatermarkSessions).toBe(2048);
  }, 30000);
});
