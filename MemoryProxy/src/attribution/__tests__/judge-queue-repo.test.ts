/**
 * 基座-a 单测：队列 repo（入队幂等 / CAS 认领 / 租约 / 死信 / DB 降级）。
 * 覆盖 design §5 的 T1–T4、T11（repo 侧）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetDbForTests } from "../../db/index.js";
import {
  NullAttributionJudgeQueueRepo,
  getAttributionJudgeQueueCounters,
  setAttributionJudgeQueueRepo,
} from "../judge-queue-repo.js";
import { DeterministicMockJudge } from "../judge/deterministic-mock-judge.js";
import { runWorker } from "../worker.js";
import { detailsRepo, queueRepo, teardownTempDb, withTempDb, workerDeps } from "./_helpers/base-harness.js";

beforeEach(() => {
  withTempDb();
});

afterEach(() => {
  teardownTempDb();
});

describe("T1 入队幂等", () => {
  it("同 (unit_id, round) 二次入队 → 1 行 + dedupeConflicts +1", () => {
    const repo = queueRepo();

    expect(repo.enqueue({ unitId: "u1", sessionKey: "s1", payload: { a: 1 } })).toBe(true);
    // 第二次：命中 idx_ajq_dedupe ⇒ 不是错误，是**预期路径**
    expect(repo.enqueue({ unitId: "u1", sessionKey: "s1", payload: { a: 2 } })).toBe(false);

    const rows = repo.listByStatus("pending");
    expect(rows).toHaveLength(1);
    // payload 保持**首次**那一份（OR IGNORE 不覆盖）—— 幂等键相同就不该改语义
    expect(rows[0]!.payload_json).toBe(JSON.stringify({ a: 1 }));

    const counters = getAttributionJudgeQueueCounters();
    expect(counters.enqueued).toBe(1);
    expect(counters.dedupeConflicts).toBe(1);
    expect(counters.failures).toBe(0);

    // round 不同 ⇒ 不同幂等键（重判路径可入队）
    expect(repo.enqueue({ unitId: "u1", sessionKey: "s1", round: 1, payload: {} })).toBe(true);
    expect(repo.countByStatus().pending).toBe(2);

    // 不同单元同轮 ⇒ 各一行
    expect(repo.enqueue({ unitId: "u2", sessionKey: "s1", payload: {} })).toBe(true);
    expect(repo.countByStatus().pending).toBe(3);
  });
});

describe("T2 认领 CAS", () => {
  it("两个 owner 同轮抢 → 只有 1 个拿到；attempts 只 +1", () => {
    const repo = queueRepo();
    repo.enqueue({ unitId: "u1", sessionKey: "s1", payload: {} });

    const a = repo.claimBatch({ owner: "A", batchSize: 8, leaseTtlMs: 60_000, now: 1000 });
    const b = repo.claimBatch({ owner: "B", batchSize: 8, leaseTtlMs: 60_000, now: 1000 });

    expect(a).toHaveLength(1);
    expect(a[0]!.lease_owner).toBe("A");
    expect(a[0]!.status).toBe("processing");
    expect(a[0]!.lease_expires_ms).toBe(1000 + 60_000);

    // B 的 CAS-UPDATE 命中 0 行 —— 这才是"changes()==0"，而不是异常
    expect(b).toHaveLength(0);
    // 关键：B 的失败认领不该污染 attempts
    expect(repo.get(a[0]!.queue_id)!.attempts).toBe(1);

    const counters = getAttributionJudgeQueueCounters();
    expect(counters.claimed).toBe(1);
    expect(counters.failures).toBe(0);
  });

  it("complete 带 lease_owner 条件：非持有者标不掉，持有者可标", () => {
    const repo = queueRepo();
    repo.enqueue({ unitId: "u1", sessionKey: "s1", payload: {} });
    const [row] = repo.claimBatch({ owner: "A", batchSize: 8, leaseTtlMs: 60_000, now: 1000 });

    expect(repo.complete(row!.queue_id, "B", 2000)).toBe(false);
    expect(repo.get(row!.queue_id)!.status).toBe("processing");

    expect(repo.complete(row!.queue_id, "A", 2000)).toBe(true);
    expect(repo.get(row!.queue_id)!.status).toBe("done");
    expect(repo.get(row!.queue_id)!.lease_owner).toBeNull();
  });
});

describe("T3 租约恢复", () => {
  it("未过期不可再认领；过期后可被另一 owner 再认领且 attempts 递增", () => {
    const repo = queueRepo();
    repo.enqueue({ unitId: "u1", sessionKey: "s1", payload: {} });
    const [leased] = repo.claimBatch({ owner: "A", batchSize: 8, leaseTtlMs: 5000, now: 10_000 });
    const id = leased!.queue_id;

    // 未过期
    expect(repo.claimBatch({ owner: "B", batchSize: 8, leaseTtlMs: 5000, now: 14_999 })).toHaveLength(0);
    // 边界：lease_expires_ms == now ⇒ **不**算过期（SQL 用严格小于）
    expect(repo.claimBatch({ owner: "B", batchSize: 8, leaseTtlMs: 5000, now: 15_000 })).toHaveLength(0);

    // 过期 1ms 即恢复
    const reclaimed = repo.claimBatch({ owner: "B", batchSize: 8, leaseTtlMs: 5000, now: 15_001 });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.queue_id).toBe(id);
    expect(reclaimed[0]!.lease_owner).toBe("B");
    expect(reclaimed[0]!.attempts).toBe(2);
    expect(reclaimed[0]!.status).toBe("processing");
  });
});

describe("T4 死信（failed 不再自动认领）", () => {
  it("attempts 达 maxAttempts → failed；再跑 --once 不动它；--retry-failed 才复位", async () => {
    const repo = queueRepo();
    repo.enqueue({ unitId: "u1", sessionKey: "s1", payload: { visibleAssets: [] } });

    // 必然抛错的 judge（MockJudgeScript 显式指定）
    const judge = new DeterministicMockJudge({
      script: { byUnitId: { u1: { kind: "throw", message: "boom" } } },
    });
    const deps = workerDeps({ judge, maxAttempts: 2 });

    // 第 1 次：attempts=1 < 2 ⇒ 回 pending
    const r1 = await runWorker(deps, { drain: true });
    expect(r1.claimed).toBe(1);
    expect(r1.errored).toBe(1);
    expect(r1.requeued).toBe(1);
    expect(r1.deadLettered).toBe(0);
    expect(repo.get(1)!.status).toBe("pending");
    expect(repo.get(1)!.attempts).toBe(1);
    expect(repo.get(1)!.last_error).toContain("boom");

    // 抽干模式**不得**同一轮把它再抢一次（否则退避失效、一条坏行一次烧完）
    expect(r1.claimed).toBe(1);

    // 第 2 次：attempts=2 ⇒ 死信
    const r2 = await runWorker(deps, { drain: true });
    expect(r2.deadLettered).toBe(1);
    expect(repo.get(1)!.status).toBe("failed");
    expect(repo.get(1)!.attempts).toBe(2);

    // 死信不再被自动认领
    const r3 = await runWorker(deps, { drain: true });
    expect(r3.claimed).toBe(0);
    expect(repo.get(1)!.status).toBe("failed");
    expect(repo.get(1)!.attempts).toBe(2);

    // 只有 --retry-failed 复位（attempts 归零，可再战）
    expect(repo.retryFailed(9999)).toBe(1);
    expect(repo.get(1)!.status).toBe("pending");
    expect(repo.get(1)!.attempts).toBe(0);
    expect(repo.get(1)!.last_error).toBeNull();
    expect(getAttributionJudgeQueueCounters().retried).toBe(1);
  });
});

describe("T11 DB 降级（repo 侧）", () => {
  it("DB 不可用时 getDb() → null 的 Null 实现：入队/认领/完成全部静默降级不抛", () => {
    // 用 Null 实现直接验"DB 不可用"分支（getDb() → null 时 getAttributionJudgeQueueRepo()
    // 装配的就是它，见 judge-queue-repo.ts 的 if (db) 分支）。
    setAttributionJudgeQueueRepo(new NullAttributionJudgeQueueRepo());
    const repo = queueRepo();

    expect(() => repo.enqueue({ unitId: "u", sessionKey: "s", payload: {} })).not.toThrow();
    expect(repo.enqueue({ unitId: "u", sessionKey: "s", payload: {} })).toBe(false);
    expect(repo.claimBatch({ owner: "A", batchSize: 8, leaseTtlMs: 1000 })).toEqual([]);
    expect(repo.complete(1, "A")).toBe(false);
    expect(repo.fail(1, "A", "x", { maxAttempts: 3 })).toBeNull();
    expect(repo.retryFailed()).toBe(0);
    expect(repo.get(1)).toBeNull();
    expect(repo.listByStatus("pending")).toEqual([]);
    expect(repo.countByStatus()).toEqual({});
  });

  it("真库可用时：DB 单例被 reset 后 repo 重新绑定新句柄（不串库）", () => {
    const repo = queueRepo();
    repo.enqueue({ unitId: "u1", sessionKey: "s1", payload: {} });
    expect(repo.countByStatus().pending).toBe(1);

    // 模拟"库换了"：reset DB + repo 单例 ⇒ 新句柄指向新文件
    __resetDbForTests();
    const secondDir = withTempDb();
    expect(secondDir.length).toBeGreaterThan(0);
    expect(queueRepo().countByStatus()).toEqual({});
    expect(detailsRepo().count()).toBe(0);
  });
});
