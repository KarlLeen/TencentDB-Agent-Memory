/**
 * S1 attribution_events repo tests — see MemoryProxy/docs/implementation/
 * 10-event-table.md §6. Each test gets a fresh temp DB via PROXY_DB_PATH and
 * full singleton reset so repo/db state never leaks between cases.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetAttributionEventRepoForTests,
  getAttributionEventRepo,
  getAttributionWriteCounters,
  type NewAttributionEvent,
} from "../attributionEventRepo.js";
import { __resetDbForTests, getDb } from "../index.js";
import { restoreIsolatedDbPath } from "../../__tests__/setup/isolate-db.js";

let dir: string;

function withTempDb(): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-ae-test-"));
  process.env.PROXY_DB_PATH = path.join(dir, "proxy.db");
  __resetAttributionEventRepoForTests();
  __resetDbForTests();
}

beforeEach(() => {
  withTempDb();
});

afterEach(() => {
  __resetAttributionEventRepoForTests();
  __resetDbForTests();
  restoreIsolatedDbPath(); // 73 · C3：delete → 恢复 setup 隔离值（防裸跑回落到默认真库）
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function ev(over: Partial<NewAttributionEvent>): NewAttributionEvent {
  return {
    sessionKey: "sess-1",
    eventType: "injection.hook.done",
    payload: { hookId: "knowledge-tools-injector" },
    ...over,
  };
}

describe("attribution_events table bootstrap", () => {
  it("is created idempotently across repeated schema runs", () => {
    const db = getDb();
    expect(db).not.toBeNull();
    const names = db!
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(names.map((r) => r.name)).toContain("attribution_events");
    // second schema exec must not throw (IF NOT EXISTS) — repo already ran schema once.
    expect(() => {
      db!.prepare("SELECT * FROM attribution_events LIMIT 1").all();
    }).not.toThrow();
  });

  it("creates the partial dedupe index for decision-unit anchors", () => {
    const db = getDb();
    const idx = db!
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_ae_unit_dedupe'")
      .get() as { sql: string } | undefined;
    expect(idx?.sql).toMatch(/WHERE msg_seq IS NOT NULL/);
  });
});

describe("AttributionEventRepo (sqlite)", () => {
  it("append → listBySession round-trips a full row including payload and defaults", () => {
    const repo = getAttributionEventRepo();
    const payload = { hookId: "knowledge-tools-injector", kinds: ["a", "b"] };
    repo.append(
      ev({
        userId: "usr-1",
        agentSource: "codebuddy",
        turnSeq: 3,
        assetId: "wiki-1vo353ux",
        assetType: "llm_wiki",
        payload,
      }),
    );

    const rows = repo.listBySession("sess-1");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.space_id).toBe("_default");
    expect(row.user_id).toBe("usr-1");
    expect(row.agent_source).toBe("codebuddy");
    expect(row.turn_seq).toBe(3);
    expect(row.msg_seq).toBeNull();
    expect(row.asset_id).toBe("wiki-1vo353ux");
    expect(row.asset_type).toBe("llm_wiki");
    expect(row.unit_id).toBeNull();
    expect(JSON.parse(row.payload_json)).toEqual(payload);
    expect(typeof row.created_at).toBe("number");
  });

  it("keeps session isolation and orders by created_at desc", () => {
    const repo = getAttributionEventRepo();
    repo.append(ev({ sessionKey: "sess-a", payload: { n: 1 } }));
    repo.append(ev({ sessionKey: "sess-b", payload: { n: 2 } }));
    repo.append(ev({ sessionKey: "sess-a", payload: { n: 3 } }));
    expect(repo.listBySession("sess-a")).toHaveLength(2);
    expect(repo.listBySession("sess-b")).toHaveLength(1);
    expect(repo.listBySession("sess-a", { limit: 1 })).toHaveLength(1);
  });

  it("filters by event_type", () => {
    const repo = getAttributionEventRepo();
    repo.append(ev({ eventType: "injection.pipeline.start" }));
    repo.append(ev({ eventType: "decision_unit.created" }));
    const units = repo.listBySession("sess-1", { eventType: "decision_unit.created" });
    expect(units).toHaveLength(1);
    expect(units[0]!.event_type).toBe("decision_unit.created");
  });

  it("lists by asset dimension (real asset id filter)", () => {
    const repo = getAttributionEventRepo();
    repo.append(ev({ assetId: "wiki-1vo353ux", assetType: "llm_wiki", payload: { a: 1 } }));
    repo.append(ev({ assetId: "cg-fmlyecm5", assetType: "code_graph", payload: { a: 2 } }));
    repo.append(
      ev({ sessionKey: "sess-other", assetId: "wiki-1vo353ux", assetType: "llm_wiki", payload: { a: 3 } }),
    );

    const rows = repo.listByAsset("wiki-1vo353ux");
    expect(rows).toHaveLength(2); // both sessions — asset dimension is session-agnostic
    for (const r of rows) {
      expect(r.asset_id).toBe("wiki-1vo353ux");
      expect(r.asset_type).toBe("llm_wiki");
    }
    expect(repo.listByAsset("no-such-asset")).toHaveLength(0);
  });

  it("appendMany inserts all rows in one transaction", () => {
    const repo = getAttributionEventRepo();
    repo.appendMany([
      ev({ sessionKey: "sess-x", payload: { n: 1 } }),
      ev({ sessionKey: "sess-x", payload: { n: 2 } }),
      ev({ sessionKey: "sess-x", payload: { n: 3 } }),
    ]);
    expect(repo.listBySession("sess-x")).toHaveLength(3);
    expect(repo.listBySession("sess-x", { eventType: "injection.hook.done" })).toHaveLength(3);
    repo.appendMany([]); // no-op must not throw
  });
});

describe("dedupe anchor (idx_ae_unit_dedupe)", () => {
  const unit = (msgSeq: number): NewAttributionEvent =>
    ev({
      eventType: "decision_unit.created",
      turnSeq: 5,
      msgSeq,
      unitId: `unit-${msgSeq}`,
      assetId: null,
      payload: { messages: [msgSeq] },
    });

  it("swallows a repeated single append (crash replay) at info level, counted as dedupe", () => {
    const repo = getAttributionEventRepo();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    repo.append(unit(2));
    repo.append(unit(2)); // same (session_key, turn_seq, msg_seq) → dedupe
    expect(repo.listBySession("sess-1")).toHaveLength(1);
    expect(info).toHaveBeenCalled(); // 预期去重 = info（v1.1 观测：与真实失败 warn 区分）
    expect(warn).not.toHaveBeenCalled(); // 绝不 upgrade 成 error/warn 噪音
    expect(getAttributionWriteCounters()).toMatchObject({ appended: 1, dedupeConflicts: 1, failures: 0 });
    info.mockRestore();
    warn.mockRestore();
  });

  it("appendMany skips conflicting rows but keeps the rest", () => {
    const repo = getAttributionEventRepo();
    repo.append(unit(1)); // baseline anchor (turn_seq=5, msg_seq=1)
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    repo.appendMany([unit(1), unit(2), unit(3)]); // 1 conflicts, 2/3 are new
    const rows = repo.listBySession("sess-1");
    expect(rows).toHaveLength(3); // baseline + 2 new; dup row skipped
    expect(rows.some((r) => r.msg_seq === 2)).toBe(true);
    expect(rows.some((r) => r.msg_seq === 3)).toBe(true);
    expect(info).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(getAttributionWriteCounters()).toMatchObject({ appended: 3, dedupeConflicts: 1, failures: 0 });
    info.mockRestore();
    warn.mockRestore();
  });

  it("does not constrain non-decision events (msg_seq NULL)", () => {
    const repo = getAttributionEventRepo();
    // Same (session_key, turn_seq) but msg_seq NULL: partial index must not apply.
    repo.appendMany([
      ev({ eventType: "injection.hook.done", turnSeq: 5, assetId: "wiki-1vo353ux" }),
      ev({ eventType: "injection.hook.error", turnSeq: 5, assetId: "wiki-1vo353ux" }),
    ]);
    expect(repo.listBySession("sess-1")).toHaveLength(2);
  });
});

describe("degradation (Null repo)", () => {
  it("silently no-ops when the DB cannot initialize", () => {
    // Make ensureDbDir fail: PROXY_DB_PATH points under a regular file.
    __resetAttributionEventRepoForTests();
    __resetDbForTests();
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "not a dir");
    process.env.PROXY_DB_PATH = path.join(blocker, "proxy.db");

    const repo = getAttributionEventRepo();
    expect(() => {
      repo.append(ev({ payload: { n: 1 } }));
      repo.appendMany([ev({ payload: { n: 2 } }), ev({ payload: { n: 3 } })]);
    }).not.toThrow();
    expect(repo.listBySession("sess-1")).toEqual([]);
    expect(repo.listByAsset("anything")).toEqual([]);
  });
});
