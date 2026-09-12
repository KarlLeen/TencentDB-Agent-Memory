/**
 * 69 · L1 自动接线测试矩阵（70 spec §3 C1–C7）。
 *
 * ⚠️ 定格口径（C6）= **68 D1（60 spec §5 "payload 新鲜度契约"）**：corrected 行版本字段 =
 * 检测时（首次判定）快照；重跑 ⇒ duplicate、`payload_json`/`created_at` **逐字不变**（T4 钉死）。
 *
 * T1 CLI --session 修正；T2 单版本 ⇒ 0；T3 窗口外版本 ⇒ 0；T4 重跑 payload 逐字不变；
 * T5 脏集去重（同 session 多 unit 只扫一次）；T5b 节流 minIdleMs；T6 空转不空扫 + 缺省关零输出；
 * T7 L1 异常 ⇒ 零影响（cycle 计数/队列行/正常退出）；T8 --all-sessions --since（两来源并集 + 水位）；
 * T9 缺 --since ⇒ 码 5 + 零扫描。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { getAttributionEventRepo } from "../../db/attributionEventRepo.js";
import { getDb } from "../../db/index.js";
import {
  createPostCycleL1Hook,
  emptyL1Outcome,
  enumerateL1Sessions,
  parseSinceMs,
  validateL1CliScope,
  type L1WiringDeps,
} from "../l1-wiring.js";
import { getAttributionStatusEventsRepo, STATUS_EVENT_TYPE_ASSET_CORRECTED } from "../status-events-repo.js";
import { EXIT_L1_SCOPE_INVALID, main, runWorker } from "../worker.js";
import { queueRepo, teardownTempDb, withTempDb, workerDeps } from "./_helpers/base-harness.js";

interface StatusRowLite {
  status_id: string;
  event_type: string;
  payload_json: string;
  created_at: number;
}

function statusRows(sessionKey: string): StatusRowLite[] {
  return getDb()!
    .prepare(
      "SELECT status_id, event_type, payload_json, created_at FROM attribution_status_events WHERE session_key = ? ORDER BY created_at ASC, status_id ASC",
    )
    .all(sessionKey) as StatusRowLite[];
}

function correctedRows(sessionKey: string): StatusRowLite[] {
  return statusRows(sessionKey).filter((r) => r.event_type === STATUS_EVENT_TYPE_ASSET_CORRECTED);
}

function seedFetched(sessionKey: string, assetId: string, versions: number[]): void {
  getAttributionEventRepo().appendMany(
    versions.map((v) => ({
      sessionKey,
      eventType: "asset_fetched",
      assetId,
      assetType: "skill",
      payload: { version: v },
    })),
  );
}

function seedUsed(sessionKey: string, unitId: string, assetId: string): string {
  return getAttributionStatusEventsRepo().insertIdempotent({
    unitId,
    sessionKey,
    assetId,
    assetType: "skill",
    round: 0,
    outcome: null,
    payload: { judgement_id: `jd_${unitId}` },
  }).statusId;
}

/** 把 fetched 行的 created_at 拨到指定水位（append 恒用 now，测试需造"老行"）。 */
function ageFetchedRows(sessionKey: string, createdAt: number): void {
  getDb()!
    .prepare("UPDATE attribution_events SET created_at = ? WHERE session_key = ?")
    .run(createdAt, sessionKey);
}

function stderrSpy(): { lines: () => string[]; restore: () => void } {
  const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  return {
    lines: () => spy.mock.calls.map((c) => String(c[0])),
    restore: () => spy.mockRestore(),
  };
}

afterEach(() => {
  delete process.env.PROXY_DATA_DIR;
});

describe("69 · T1–T4 CLI --correct-l1 --session（C1/C5/C6）", () => {
  it("T1 v1→used→v2 ⇒ 1 条 corrected（route=version_drift + payload 版本快照）+ stderr 六计数", async () => {
    const dir = withTempDb();
    process.env.PROXY_DATA_DIR = dir;
    const err = stderrSpy();
    try {
      seedFetched("sess-69-t1", "asset-t1", [1, 2]);
      const usedId = seedUsed("sess-69-t1", "u-t1", "asset-t1");
      const code = await main(["--correct-l1", "--session=sess-69-t1"]);
      expect(code).toBe(0);
      const rows = correctedRows("sess-69-t1");
      const line = err.lines().find((l) => l.includes("l1-correct")) ?? "";
      console.log(`T1 → code=${code} rows=${rows.length} | ${line.trim()}`);
      expect(rows.length).toBe(1);
      const p = JSON.parse(rows[0]!.payload_json) as Record<string, unknown>;
      expect(p.correction_route).toBe("version_drift");
      expect(p.used_status_id).toBe(usedId);
      expect(p.anchored_version).toBe(1);
      expect(p.latest_version).toBe(2);
      expect(line).toContain("sessions=1");
      expect(line).toContain("correctedInserted=1");
      expect(line).toContain("failed=0");
    } finally {
      err.restore();
      teardownTempDb();
    }
  });

  it("T2 单版本（无漂移）⇒ 0 条 + assetsSkippedNoVersion 计数", async () => {
    const dir = withTempDb();
    process.env.PROXY_DATA_DIR = dir;
    const err = stderrSpy();
    try {
      seedFetched("sess-69-t2", "asset-t2", [1]);
      seedUsed("sess-69-t2", "u-t2", "asset-t2");
      const code = await main(["--correct-l1", "--session=sess-69-t2"]);
      expect(code).toBe(0);
      const line = err.lines().find((l) => l.includes("l1-correct")) ?? "";
      console.log(`T2 → ${line.trim()}`);
      expect(correctedRows("sess-69-t2").length).toBe(0);
      expect(line).toContain("assetsSkippedNoVersion=1");
      expect(line).toContain("correctedInserted=0");
    } finally {
      err.restore();
      teardownTempDb();
    }
  });

  it("T3 窗口外版本（另一 session 的 v2）⇒ 0 条（不回查补齐）", async () => {
    const dir = withTempDb();
    process.env.PROXY_DATA_DIR = dir;
    const err = stderrSpy();
    try {
      seedFetched("sess-69-t3", "asset-t3", [1]);
      seedUsed("sess-69-t3", "u-t3", "asset-t3");
      seedFetched("sess-69-t3-other", "asset-t3", [1, 2]); // 窗口外
      seedUsed("sess-69-t3-other", "u-t3b", "asset-t3");
      const code = await main(["--correct-l1", "--session=sess-69-t3"]);
      expect(code).toBe(0);
      console.log(`T3 → ${err.lines().find((l) => l.includes("l1-correct"))?.trim()}`);
      expect(correctedRows("sess-69-t3").length).toBe(0);
      // other session 不在范围内 ⇒ 也没被扫
      expect(correctedRows("sess-69-t3-other").length).toBe(0);
    } finally {
      err.restore();
      teardownTempDb();
    }
  });

  it("T4 重跑同一 session 两次 ⇒ 第二次 inserted=0/duplicate=1，且 payload/created_at 逐字不变（钉 C6/68 D1）", async () => {
    const dir = withTempDb();
    process.env.PROXY_DATA_DIR = dir;
    let err = stderrSpy();
    try {
      seedFetched("sess-69-t4", "asset-t4", [1, 2]);
      seedUsed("sess-69-t4", "u-t4", "asset-t4");
      expect(await main(["--correct-l1", "--session=sess-69-t4"])).toBe(0);
      const snap1 = correctedRows("sess-69-t4").map((r) => ({
        status_id: r.status_id,
        payload_json: r.payload_json,
        created_at: r.created_at,
      }));
      const line1 = err.lines().find((l) => l.includes("l1-correct")) ?? "";
      err.restore();

      err = stderrSpy();
      expect(await main(["--correct-l1", "--session=sess-69-t4"])).toBe(0);
      const snap2 = correctedRows("sess-69-t4").map((r) => ({
        status_id: r.status_id,
        payload_json: r.payload_json,
        created_at: r.created_at,
      }));
      const line2 = err.lines().find((l) => l.includes("l1-correct")) ?? "";
      console.log(`T4 → 第一次 ${line1.trim()}；第二次 ${line2.trim()}`);
      expect(snap1.length).toBe(1);
      expect(snap2, "重跑后行集合逐字不变（payload/created_at 不刷）").toEqual(snap1);
      expect(line1).toContain("correctedInserted=1");
      expect(line2).toContain("correctedInserted=0");
      expect(line2).toContain("correctedDuplicate=1");
    } finally {
      err.restore();
      teardownTempDb();
    }
  });
});

describe("69 · T5/T5b/T6 post-cycle 钩子（C2/C3）", () => {
  it("T5 脏集去重：同 session 两 unit ⇒ applyL1 只被调一次（只扫一次）", async () => {
    const dir = withTempDb();
    process.env.PROXY_DATA_DIR = dir;
    try {
      const spy = vi.fn((_sessionKey: string) => emptyL1Outcome());
      const hook = createPostCycleL1Hook({ enabled: true, minIdleMs: 0 }, { applyL1: spy });
      queueRepo().enqueue({
        unitId: "u-69-t5a",
        sessionKey: "sess-69-t5",
        payload: { kind: "restraint", turnSeq: 1, payload: { text: "无关文本" } },
      });
      queueRepo().enqueue({
        unitId: "u-69-t5b",
        sessionKey: "sess-69-t5",
        payload: { kind: "restraint", turnSeq: 1, payload: { text: "无关文本" } },
      });
      const result = await runWorker(workerDeps(), { drain: true, onIdle: hook });
      console.log(`T5 → claimed=${result.claimed} applyL1 调用次数=${spy.mock.calls.length}`);
      expect(result.completed).toBe(2);
      expect(spy.mock.calls.length, "两 unit 同 session ⇒ 去重后只扫 1 次").toBe(1);
      expect(spy.mock.calls[0]![0]).toBe("sess-69-t5");
    } finally {
      teardownTempDb();
    }
  });

  it("T5b 节流：minIdleMs 内同 session 不再扫；到期后重扫（一次扫完即出清）", () => {
    let t = 10_000;
    const spy = vi.fn(() => emptyL1Outcome());
    const deps: L1WiringDeps = { applyL1: spy, now: () => t };
    const hook = createPostCycleL1Hook({ enabled: true, minIdleMs: 5_000 }, deps);
    const dirty = new Set<string>(["s-throttle"]);
    hook(dirty);
    console.log(`T5b → 第一次调用数=${spy.mock.calls.length}（脏集出清=${!dirty.has("s-throttle")}）`);
    expect(spy.mock.calls.length).toBe(1);
    expect(dirty.has("s-throttle"), "一次扫完即从脏集移除").toBe(false);
    dirty.add("s-throttle"); // 又有新消费
    hook(dirty);
    expect(spy.mock.calls.length, "距上次 < minIdleMs ⇒ 被节流").toBe(1);
    t += 5_000;
    dirty.add("s-throttle");
    hook(dirty);
    console.log(`T5b → 到期后调用数=${spy.mock.calls.length}`);
    expect(spy.mock.calls.length, "到期（≥ minIdleMs）⇒ 重扫").toBe(2);
  });

  it("T6 空转不空扫（脏集空 ⇒ 零调用）+ enabled=false ⇒ 零动作零输出（零回归）", async () => {
    const dir = withTempDb();
    process.env.PROXY_DATA_DIR = dir;
    const err = stderrSpy();
    try {
      const spy = vi.fn(() => emptyL1Outcome());
      const hook = createPostCycleL1Hook({ enabled: true, minIdleMs: 0 }, { applyL1: spy });
      hook(new Set()); // 脏集空
      expect(spy, "空脏集 ⇒ 零调用（不得空扫）").not.toHaveBeenCalled();
      // 集成：队列空 ⇒ drain 立即结束 ⇒ onIdle 被调但脏集空 ⇒ 仍零调用 + 零输出
      const result = await runWorker(workerDeps(), { drain: true, onIdle: hook });
      console.log(`T6 → claimed=${result.claimed} applyL1=${spy.mock.calls.length} stderr=${err.lines().length}`);
      expect(spy.mock.calls.length).toBe(0);
      expect(err.lines().filter((l) => l.includes("l1-correct")).length).toBe(0);

      // enabled=false（缺省关）：即使有脏集也零动作、零输出
      const offSpy = vi.fn(() => emptyL1Outcome());
      const offHook = createPostCycleL1Hook({ enabled: false, minIdleMs: 0 }, { applyL1: offSpy });
      const dirty = new Set<string>(["s-any"]);
      offHook(dirty);
      expect(offSpy).not.toHaveBeenCalled();
      expect(dirty.has("s-any"), "缺省关 ⇒ 不触碰脏集").toBe(true);
      expect(err.lines().filter((l) => l.includes("l1-correct")).length).toBe(0);
    } finally {
      err.restore();
      teardownTempDb();
    }
  });

  it("T7 L1 注入异常 ⇒ cycle 计数不变、队列行 done 不变、worker 正常返回、failed=1 报告（C4）", async () => {
    const dir = withTempDb();
    process.env.PROXY_DATA_DIR = dir;
    const err = stderrSpy();
    try {
      queueRepo().enqueue({
        unitId: "u-69-t7",
        sessionKey: "sess-69-t7",
        payload: { kind: "restraint", turnSeq: 1, payload: { text: "无关文本" } },
      });
      const boom = vi.fn((): never => {
        throw new Error("l1 boom");
      });
      const hook = createPostCycleL1Hook({ enabled: true, minIdleMs: 0 }, { applyL1: boom });
      const result = await runWorker(workerDeps(), { drain: true, onIdle: hook });
      const l1Line = err.lines().find((l) => l.includes("l1-correct")) ?? "";
      const row = getDb()!
        .prepare("SELECT status FROM attribution_judge_queue WHERE unit_id = 'u-69-t7'")
        .get() as { status: string };
      console.log(`T7 → ${l1Line.trim()}；queue.status=${row.status}`);
      expect(result.claimed).toBe(1);
      expect(result.completed).toBe(1);
      expect(result.errored, "L1 异常不得进 cycle 计数").toBe(0);
      expect(row.status, "队列行状态不受 L1 影响").toBe("done");
      expect(boom).toHaveBeenCalledTimes(1);
      expect(l1Line).toContain("failed=1");
    } finally {
      err.restore();
      teardownTempDb();
    }
  });
});

describe("69 · T8/T9 --all-sessions（水位两来源并集 / 缺 --since 拒绝）", () => {
  it("T8 只扫水位内命中的 session（fetched ∪ used 并集）；水位外有漂移也不扫", async () => {
    const dir = withTempDb();
    process.env.PROXY_DATA_DIR = dir;
    const err = stderrSpy();
    try {
      const now = Date.now();
      // 水位外：老 fetched session（带完整漂移形状，若被扫会产 corrected）
      seedFetched("sess-69-old", "asset-old", [1, 2]);
      seedUsed("sess-69-old", "u-old", "asset-old");
      ageFetchedRows("sess-69-old", now - 3_600_000);
      getDb()!
        .prepare("UPDATE attribution_status_events SET created_at = ? WHERE session_key = ?")
        .run(now - 3_600_000, "sess-69-old");
      // 水位内来源 1（fetched）：新 session 且带漂移 ⇒ 应被扫并产 1 条
      seedFetched("sess-69-fresh", "asset-fresh", [1, 2]);
      seedUsed("sess-69-fresh", "u-fresh", "asset-fresh");
      // 水位内来源 2（used-only）：只出现过的 used session ⇒ 应在枚举并集里
      seedUsed("sess-69-used-only", "u-used-only", "asset-x");

      const sinceMs = now - 60_000;
      const sessions = enumerateL1Sessions(sinceMs);
      console.log(`T8 并集 → ${JSON.stringify(sessions)}`);
      expect(sessions).toEqual(["sess-69-fresh", "sess-69-used-only"]);

      const code = await main(["--correct-l1", "--all-sessions", `--since=${sinceMs}`]);
      expect(code).toBe(0);
      const line = err.lines().find((l) => l.includes("l1-correct")) ?? "";
      console.log(`T8 CLI → ${line.trim()}`);
      expect(line).toContain("sessions=2");
      expect(correctedRows("sess-69-old").length, "水位外不扫").toBe(0);
      expect(correctedRows("sess-69-fresh").length, "水位内被扫且产 1 条").toBe(1);
    } finally {
      err.restore();
      teardownTempDb();
    }
  });

  it("T9 --all-sessions 缺 --since ⇒ 码 5 + 报错 + 零扫描；辅助判据（互斥/无范围/非法值）", async () => {
    const dir = withTempDb();
    process.env.PROXY_DATA_DIR = dir;
    const err = stderrSpy();
    try {
      seedFetched("sess-69-t9", "asset-t9", [1, 2]);
      seedUsed("sess-69-t9", "u-t9", "asset-t9");
      const code = await main(["--correct-l1", "--all-sessions"]);
      const fatal = err.lines().find((l) => l.includes("FATAL")) ?? "";
      console.log(`T9 → code=${code} | ${fatal.trim()}`);
      expect(code).toBe(EXIT_L1_SCOPE_INVALID);
      expect(fatal).toContain("--since");
      expect(correctedRows("sess-69-t9").length, "零扫描").toBe(0);

      // 辅助判据（纯函数）
      expect(validateL1CliScope({ allSessions: false })).toContain("--session");
      expect(validateL1CliScope({ allSessions: false, sessionKey: "s", sinceRaw: "1" })).toContain("--since");
      expect(validateL1CliScope({ allSessions: true, sessionKey: "s", sinceRaw: "1" })).toContain("mutually");
      expect(validateL1CliScope({ allSessions: true, sinceRaw: "not-a-date" })).toContain("非法");
      expect(validateL1CliScope({ allSessions: true, sinceRaw: "1700000000000" })).toBe(null);
      expect(parseSinceMs("2026-09-12T00:00:00Z")).toBe(Date.parse("2026-09-12T00:00:00Z"));
    } finally {
      err.restore();
      teardownTempDb();
    }
  });
});
