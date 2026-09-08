/**
 * S2 EventObserver 单测（docs/implementation/20-event-observer.md §6）。
 *
 * 直测 AttributionEventObserver + CompositeInjectionObserver + collectAssets，
 * 用内存 fake repo 断言 NewAttributionEvent 输入（不落 SQLite）。
 */

import { describe, expect, it } from "vitest";

import type {
  AgentContextMetadata,
  ContextBlock,
  InjectionHook,
  InjectionPoint,
} from "../types.js";
import type { AttributionEventRepo, NewAttributionEvent } from "../../db/attributionEventRepo.js";
import {
  AttributionEventObserver,
  collectAssets,
  EVENT_TYPE_HOOK_DONE,
  EVENT_TYPE_HOOK_ERROR,
  EVENT_TYPE_HOOK_START,
  EVENT_TYPE_PIPELINE_DONE,
  EVENT_TYPE_PIPELINE_ERROR,
  EVENT_TYPE_PIPELINE_START,
} from "../attribution-event-observer.js";
import { CompositeInjectionObserver } from "../observer.js";
import type { InjectionObserver } from "../observer.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeRepo implements AttributionEventRepo {
  events: NewAttributionEvent[] = [];
  failAppend = false;

  append(e: NewAttributionEvent): void {
    if (this.failAppend) throw new Error("db down");
    this.events.push(e);
  }
  appendMany(events: NewAttributionEvent[]): void {
    if (this.failAppend) throw new Error("db down");
    this.events.push(...events);
  }
  listBySession(): AttributionEventRowStub[] {
    return [];
  }
  listByAsset(): AttributionEventRowStub[] {
    return [];
  }
}

// 轻量桩类型：listBySession/listByAsset 的实现可空（本套用例不读行）。
type AttributionEventRowStub = never;

function makeMeta(overrides: Partial<AgentContextMetadata> = {}): AgentContextMetadata {
  return {
    protocol: "openai",
    traceId: "trace-1",
    keyId: "key-1",
    modelId: "model-1",
    stream: false,
    agentSource: "codebuddy",
    sessionKey: "sess-1",
    turnSeq: 3,
    spaceId: "space-1",
    userId: "user-1",
    ...overrides,
  };
}

function makeHook(id = "h1"): InjectionHook {
  return {
    id,
    point: "user.before",
    priority: 100,
    description: "test hook",
    execute: async () => [],
  };
}

const POINT_USER_BEFORE: InjectionPoint = "user.before";

function blockWithAssets(assets: unknown[], source = "src-1"): ContextBlock {
  return { type: "text", content: "x", metadata: { source, assets } };
}

function plainBlock(): ContextBlock {
  return { type: "text", content: "plain", metadata: {} };
}

function ofType(repo: FakeRepo, eventType: string): NewAttributionEvent[] {
  return repo.events.filter((e) => e.eventType === eventType);
}

// ── collectAssets ─────────────────────────────────────────────────────────────

describe("collectAssets", () => {
  it("ignores blocks without assets metadata and non-array assets", () => {
    expect(collectAssets([plainBlock(), { type: "text", content: "a", metadata: { assets: "nope" } }])).toEqual([]);
    expect(collectAssets([])).toEqual([]);
  });

  it("skips malformed entries (missing / wrong-typed identity)", () => {
    const blocks = [
      blockWithAssets([
        { assetType: "skill" }, // no assetId
        { assetId: 42, assetType: "skill" }, // assetId not string
        { assetId: "a", assetType: 7 }, // assetType not string
        { assetId: "", assetType: "skill" }, // empty assetId
        null,
        "junk",
        { assetId: "ok", assetType: "skill", name: "N", version: 3 }, // valid
      ]),
    ];
    expect(collectAssets(blocks)).toEqual([{ assetId: "ok", assetType: "skill", name: "N", version: 3 }]);
  });

  it("dedupes across blocks by assetType:assetId, keeping first", () => {
    const blocks = [
      blockWithAssets([
        { assetId: "a", assetType: "skill" },
        { assetId: "b", assetType: "llm_wiki" },
      ]),
      blockWithAssets([
        { assetId: "b", assetType: "llm_wiki", name: "dup-name" }, // dup, first wins
        { assetId: "c", assetType: "chat_memory" },
      ]),
    ];
    expect(collectAssets(blocks)).toEqual([
      { assetId: "a", assetType: "skill" },
      { assetId: "b", assetType: "llm_wiki" },
      { assetId: "c", assetType: "chat_memory" },
    ]);
  });

  it("keeps optional name only when non-empty string, version only when number", () => {
    const blocks = [
      blockWithAssets([
        { assetId: "a", assetType: "skill", name: "", version: "3" }, // dropped both
        { assetId: "b", assetType: "skill", name: "B", version: 2 }, // kept both
      ]),
    ];
    expect(collectAssets(blocks)).toEqual([
      { assetId: "a", assetType: "skill" },
      { assetId: "b", assetType: "skill", name: "B", version: 2 },
    ]);
  });
});

// ── AttributionEventObserver ──────────────────────────────────────────────────

describe("AttributionEventObserver", () => {
  const mk = () => {
    const repo = new FakeRepo();
    const observer = new AttributionEventObserver(repo);
    return { repo, observer };
  };

  it("pipeline.start writes one row with columns + payload", () => {
    const { repo, observer } = mk();
    observer.onPipelineStart(makeMeta({ sessionKey: "s", turnSeq: 7 }));
    const rows = ofType(repo, EVENT_TYPE_PIPELINE_START);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.sessionKey).toBe("s");
    expect(r.turnSeq).toBe(7);
    expect(r.spaceId).toBe("space-1");
    expect(r.userId).toBe("user-1");
    expect(r.agentSource).toBe("codebuddy");
    expect(r.assetId).toBeNull();
    expect(r.assetType).toBeNull();
    expect(r.payload).toMatchObject({ traceId: "trace-1", protocol: "openai", modelId: "model-1" });
  });

  it("pipeline.done aggregates hook summaries", () => {
    const { repo, observer } = mk();
    observer.onPipelineEnd(
      makeMeta(),
      12,
      [
        { hookId: "h1", point: POINT_USER_BEFORE, blockCount: 3, durationMs: 10 },
        { hookId: "h2", point: POINT_USER_BEFORE, blockCount: 0, durationMs: 2, error: "boom", cacheStrategy: "none" },
      ],
    );
    const rows = ofType(repo, EVENT_TYPE_PIPELINE_DONE);
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload).toMatchObject({ durationMs: 12, hookCount: 2, totalBlockCount: 3, errorCount: 1 });
    expect((payload.hooks as unknown[]).length).toBe(2);
  });

  it("pipeline.error writes errorMsg row", () => {
    const { repo, observer } = mk();
    observer.onPipelineError(makeMeta(), new Error("adapter missing"));
    const rows = ofType(repo, EVENT_TYPE_PIPELINE_ERROR);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ errorMsg: "adapter missing" });
  });

  it("hook.start writes one row with hook id + point", () => {
    const { repo, observer } = mk();
    observer.onHookStart(makeHook("hook-x"), POINT_USER_BEFORE, makeMeta());
    const rows = ofType(repo, EVENT_TYPE_HOOK_START);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ hookId: "hook-x", point: "user.before" });
  });

  it("hook.start normalizes undeclared cacheStrategy to 'none' (review F2)", () => {
    const { repo, observer } = mk();
    observer.onHookStart(makeHook("hook-und"), POINT_USER_BEFORE, makeMeta());
    const rows = ofType(repo, EVENT_TYPE_HOOK_START);
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as { cacheStrategy: string }).cacheStrategy).toBe("none");
  });

  it("hook.done normalizes undeclared cacheStrategy to 'none' (review F2)", () => {
    const { repo, observer } = mk();
    observer.onHookDone(makeHook(), POINT_USER_BEFORE, [plainBlock()], 4, undefined, makeMeta());
    const rows = ofType(repo, EVENT_TYPE_HOOK_DONE);
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as { cacheStrategy: string }).cacheStrategy).toBe("none");
  });

  it("hook.error writes one row", () => {
    const { repo, observer } = mk();
    observer.onHookError(makeHook(), POINT_USER_BEFORE, new Error("net"), 5, makeMeta());
    const rows = ofType(repo, EVENT_TYPE_HOOK_ERROR);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ hookId: "h1", point: "user.before", errorMsg: "net", durationMs: 5 });
  });

  it("hook.done without assets → one row, empty asset columns and assets: [] payload", () => {
    const { repo, observer } = mk();
    observer.onHookDone(makeHook(), POINT_USER_BEFORE, [plainBlock()], 4, "none", makeMeta());
    const rows = ofType(repo, EVENT_TYPE_HOOK_DONE);
    expect(rows).toHaveLength(1);
    expect(rows[0].assetId).toBeNull();
    expect(rows[0].assetType).toBeNull();
    expect(rows[0].payload).toMatchObject({ hookId: "h1", blockCount: 1, durationMs: 4, cacheStrategy: "none", assets: [] });
  });

  it("hook.done with K assets across blocks → K rows, spread asset columns, shared summary, blockSource from first asset block", () => {
    const { repo, observer } = mk();
    const blocks = [
      blockWithAssets([
        { assetId: "skill-1", assetType: "skill", name: "S1", version: 2 },
        { assetId: "wiki-1", assetType: "llm_wiki" },
      ]),
      blockWithAssets(
        [
          { assetId: "wiki-1", assetType: "llm_wiki" }, // dup
          { assetId: "mem-1", assetType: "chat_memory" },
        ],
        "src-2",
      ),
    ];
    observer.onHookDone(makeHook(), POINT_USER_BEFORE, blocks, 6, "session_init", makeMeta());
    const rows = ofType(repo, EVENT_TYPE_HOOK_DONE);
    expect(rows).toHaveLength(3);
    const byAsset = new Map(rows.map((r) => [r.assetId as string, r]));
    expect([...byAsset.keys()].sort()).toEqual(["mem-1", "skill-1", "wiki-1"]);
    expect(byAsset.get("skill-1")!.assetType).toBe("skill");
    expect(byAsset.get("wiki-1")!.assetType).toBe("llm_wiki");
    // 每行 payload 相同：整块摘要（无 spans）
    for (const r of rows) {
      expect(r.payload).toMatchObject({
        hookId: "h1",
        blockCount: 2,
        cacheStrategy: "session_init",
        blockSource: "src-1",
        assets: [
          { assetId: "skill-1", assetType: "skill", name: "S1", version: 2 },
          { assetId: "wiki-1", assetType: "llm_wiki" },
          { assetId: "mem-1", assetType: "chat_memory" },
        ],
      });
    }
  });

  it("hook.done with assets: [] (producing block but nothing resolved) → single empty row", () => {
    const { repo, observer } = mk();
    observer.onHookDone(makeHook(), POINT_USER_BEFORE, [blockWithAssets([])], 1, undefined, makeMeta());
    const rows = ofType(repo, EVENT_TYPE_HOOK_DONE);
    expect(rows).toHaveLength(1);
    expect(rows[0].assetId).toBeNull();
    expect((rows[0].payload as { assets: unknown[] }).assets).toEqual([]);
  });

  it("meta without sessionKey → every callback degrades silently (no rows)", () => {
    const { repo, observer } = mk();
    const meta = makeMeta({ sessionKey: undefined });
    observer.onPipelineStart(meta);
    observer.onPipelineEnd(meta, 1, []);
    observer.onPipelineError(meta, new Error("x"));
    observer.onHookStart(makeHook(), POINT_USER_BEFORE, meta);
    observer.onHookDone(makeHook(), POINT_USER_BEFORE, [blockWithAssets([{ assetId: "a", assetType: "skill" }])], 1, undefined, meta);
    observer.onHookError(makeHook(), POINT_USER_BEFORE, new Error("x"), 1, meta);
    expect(repo.events).toHaveLength(0);
  });

  it("hook callbacks without meta (interface-optional) degrade silently", () => {
    const { repo, observer } = mk();
    observer.onHookStart(makeHook(), POINT_USER_BEFORE, undefined);
    observer.onHookDone(makeHook(), POINT_USER_BEFORE, [blockWithAssets([{ assetId: "a", assetType: "skill" }])], 1, undefined, undefined);
    observer.onHookError(makeHook(), POINT_USER_BEFORE, new Error("x"), 1, undefined);
    expect(repo.events).toHaveLength(0);
  });

  it("repo failure never throws (fire-and-forget)", () => {
    const { repo, observer } = mk();
    repo.failAppend = true;
    expect(() => observer.onPipelineStart(makeMeta())).not.toThrow();
    expect(() => observer.onHookDone(makeHook(), POINT_USER_BEFORE, [blockWithAssets([{ assetId: "a", assetType: "skill" }])], 1, undefined, makeMeta())).not.toThrow();
    expect(() => observer.onPipelineEnd(makeMeta(), 1, [])).not.toThrow();
  });
});

// ── CompositeInjectionObserver ────────────────────────────────────────────────

class RecordingObserver implements InjectionObserver {
  readonly calls: string[] = [];
  failOn: string | null = null;

  private record(name: string): void {
    if (this.failOn === name) throw new Error("boom");
    this.calls.push(name);
  }

  onPipelineStart(): void {
    this.record("pipeline.start");
  }
  onPipelineEnd(): void {
    this.record("pipeline.end");
  }
  onPipelineError(): void {
    this.record("pipeline.error");
  }
  onHookStart(): void {
    this.record("hook.start");
  }
  onHookDone(): void {
    this.record("hook.done");
  }
  onHookError(): void {
    this.record("hook.error");
  }
}

describe("CompositeInjectionObserver", () => {
  it("forwards every event to all children in order", () => {
    const a = new RecordingObserver();
    const b = new RecordingObserver();
    const composite = new CompositeInjectionObserver([a, b]);
    composite.onPipelineStart(makeMeta());
    composite.onHookDone(makeHook(), POINT_USER_BEFORE, [plainBlock()], 1, undefined, makeMeta());
    composite.onPipelineError(makeMeta(), new Error("x"));
    expect(a.calls).toEqual(["pipeline.start", "hook.done", "pipeline.error"]);
    expect(b.calls).toEqual(["pipeline.start", "hook.done", "pipeline.error"]);
  });

  it("isolates errors: one failing child never blocks another", () => {
    const bad = new RecordingObserver();
    bad.failOn = "hook.done";
    const good = new RecordingObserver();
    const composite = new CompositeInjectionObserver([bad, good]);
    expect(() => composite.onHookDone(makeHook(), POINT_USER_BEFORE, [plainBlock()], 1, undefined, makeMeta())).not.toThrow();
    expect(good.calls).toEqual(["hook.done"]);
  });
});
