/**
 * 基座-b 单测：worker 消费循环 / CLI 退出码 / DB 降级 / 引用式日志。
 * 覆盖 design §5 的 T9、T10、T11（worker 侧）、T14。
 */

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConfig } from "../../config.js";
import { DeterministicMockJudge } from "../judge/deterministic-mock-judge.js";
import {
  getAttributionJudgeLogFilePath,
  initAttributionJudgeLogger,
} from "../judge-log.js";
import { getAttributionJudgeQueueCounters } from "../judge-queue-repo.js";
import { __resetDbForTests, getDb } from "../../db/index.js";
import {
  EXIT_DB_UNAVAILABLE,
  buildWorkerDeps,
  main,
  parseWorkerArgs,
  runWorker,
} from "../worker.js";
import { detailsRepo, queueRepo, teardownTempDb, withTempDb, workerDeps } from "./_helpers/base-harness.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = withTempDb();
});

afterEach(() => {
  teardownTempDb();
});

const seededUnits = (): void => {
  queueRepo().enqueue({
    unitId: "u-1",
    sessionKey: "sess-1",
    payload: { kind: "restraint", payload: { visibleAssets: [{ assetId: "asset-a", assetType: "skill" }], text: "见 asset-a" } },
  });
};

describe("T9 worker --once", () => {
  it("无待办 → 0 行且立刻返回（不挂死）", async () => {
    const result = await runWorker(workerDeps(), { drain: true });
    expect(result.claimed).toBe(0);
    expect(result.completed).toBe(0);
  });

  it("有待办 → 处理完即退出；真入口 main([--once]) 退出码 0", async () => {
    seededUnits();
    queueRepo().enqueue({ unitId: "u-2", sessionKey: "sess-1", payload: { kind: "restraint", payload: {} } });

    const code = await main(["--once"]);
    expect(code).toBe(0);
    expect(queueRepo().countByStatus()).toEqual({ done: 2 });
    expect(detailsRepo().count()).toBe(2);

    // 再跑一次：无待办，退出码仍 0，且**不增行**（正向计数，不是"0 行也通过"）
    const code2 = await main(["--once"]);
    expect(code2).toBe(0);
    expect(detailsRepo().count()).toBe(2);
  });

  it("参数解析：--once / --retry-failed / --config <p> / --config=<p>", () => {
    expect(parseWorkerArgs([])).toEqual({ once: false, retryFailed: false });
    expect(parseWorkerArgs(["--once"])).toEqual({ once: true, retryFailed: false });
    expect(parseWorkerArgs(["--retry-failed", "--once"])).toEqual({ once: true, retryFailed: true });
    expect(parseWorkerArgs(["--config", "/tmp/a.yaml"])).toEqual({
      once: false,
      retryFailed: false,
      configFile: "/tmp/a.yaml",
    });
    expect(parseWorkerArgs(["--config=/tmp/b.yaml"])).toEqual({
      once: false,
      retryFailed: false,
      configFile: "/tmp/b.yaml",
    });
    // 悬空 --config 不吞下一个 flag
    expect(parseWorkerArgs(["--config", "--once"])).toEqual({ once: true, retryFailed: false });
  });

  it("--retry-failed 真入口：死信被复位并消费", async () => {
    seededUnits();
    const id = queueRepo().listByStatus("pending")[0]!.queue_id;
    queueRepo().claimBatch({ owner: "X", batchSize: 1, leaseTtlMs: 1000, now: 0 });
    queueRepo().fail(id, "X", "seed", { maxAttempts: 1, now: 1 });
    expect(queueRepo().get(id)!.status).toBe("failed");

    expect(await main(["--once"])).toBe(0);
    // 没带 --retry-failed ⇒ 死信不动、也不增行
    expect(queueRepo().get(id)!.status).toBe("failed");
    expect(detailsRepo().count()).toBe(0);

    expect(await main(["--once", "--retry-failed"])).toBe(0);
    expect(queueRepo().get(id)!.status).toBe("done");
    expect(detailsRepo().count()).toBe(1);
  });
});

describe("T10 处理抛错", () => {
  it("judge 抛错 ⇒ attempts+1、回 pending、**不落明细**（不被吞成成功）", async () => {
    seededUnits();
    const judge = new DeterministicMockJudge({
      script: { byUnitId: { "u-1": { kind: "throw", message: "judge exploded" } } },
    });
    const result = await runWorker(workerDeps({ judge, maxAttempts: 5 }), { drain: true });

    expect(result.claimed).toBe(1);
    expect(result.errored).toBe(1);
    expect(result.completed).toBe(0);
    expect(result.idempotent).toBe(0);

    const row = queueRepo().listByStatus("pending")[0]!;
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("judge exploded");
    expect(row.lease_owner).toBeNull();
    // 关键：失败**没有**落明细，也没有被标 done
    expect(detailsRepo().count()).toBe(0);
    expect(queueRepo().countByStatus().done).toBeUndefined();
  });

  it("落库抛错同样进失败路径（judge 成功也不算完成）", async () => {
    seededUnits();
    const deps = workerDeps({
      detailsRepo: {
        insertIdempotent: () => {
          throw new Error("insert exploded");
        },
        getById: () => null,
        listByUnit: () => [],
        listBySession: () => [],
        count: () => 0,
        latestByUnit: () => null,
      },
    });
    const result = await runWorker(deps, { drain: true });
    expect(result.errored).toBe(1);
    expect(result.completed).toBe(0);
    expect(queueRepo().listByStatus("pending")[0]!.last_error).toContain("insert exploded");
  });
});

describe("T11 DB 降级（worker 侧）", () => {
  it("getDb() → null ⇒ main([--once]) 退出码非 0 + 明确报错，不抛", async () => {
    // 把库路径指向一个**目录**：open 必失败 ⇒ getDb() 返回 null（F1 路径）
    process.env.PROXY_DB_PATH = tmpDir;
    __resetDbForTests();
    expect(getDb()).toBeNull();

    await expect(main(["--once"])).resolves.toBe(EXIT_DB_UNAVAILABLE);
  });

  it("消费循环在 DB 降级时不抛（Null repo）", async () => {
    const deps = workerDeps({
      queueRepo: {
        enqueue: () => false,
        claimBatch: () => [],
        complete: () => false,
        fail: () => null,
        retryFailed: () => 0,
        get: () => null,
        listByStatus: () => [],
        countByStatus: () => ({}),
        latestByUnit: () => null,
      },
    });
    const result = await runWorker(deps, { drain: true });
    expect(result.claimed).toBe(0);
  });
});

describe("T14 引用式日志", () => {
  it("每次消费 1 行，字段最小集齐（log_id/generation_id/layer/status/prompt_ref/input_refs/output_refs/latency_ms）", async () => {
    const logDir = path.join(tmpDir, "logs");
    initAttributionJudgeLogger(logDir);
    seededUnits();
    queueRepo().enqueue({ unitId: "u-2", sessionKey: "sess-1", payload: { kind: "restraint", payload: {} } });

    const deps = buildWorkerDeps(buildConfig({}), "test-owner");
    const result = await runWorker(deps, { drain: true });
    expect(result.completed + result.idempotent).toBe(2);

    const { shutdownAttributionJudgeLogger, __resetAttributionJudgeLoggerForTests } = await import(
      "../judge-log.js"
    );
    await shutdownAttributionJudgeLogger();

    const logPath = getAttributionJudgeLogFilePath();
    expect(logPath).toBe(path.join(logDir, "attribution-judge.log"));
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);

    for (const line of lines) {
      const json = JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>;
      expect(Object.keys(json).sort()).toEqual([
        "generation_id",
        "input_refs",
        "judge_impl",
        "latency_ms",
        "layer",
        "log_id",
        "output_refs",
        "prompt_ref",
        "status",
      ]);
      expect(json.layer).toBe("attribution_judge");
      expect(json.status).toBe("ok");
      expect(typeof json.log_id).toBe("string");
      expect(typeof json.latency_ms).toBe("number");
      expect(json.generation_id).toBe((json.output_refs as Array<{ judgement_id: string }>)[0]!.judgement_id);
      expect((json.input_refs as Array<{ unit_id: string }>)[0]!.unit_id).toMatch(/^u-/);
      expect((json.prompt_ref as { prompt_sha256: string }).prompt_sha256).toBe(
        "6ed16597732f5a196378e4081d1a2b873271e08fe22172f2add3bb2d5557d0ac",
      );
      // 引用式：不写正文（不出现被判定文本 / rationale 自由文本）
      expect(line).not.toContain("见 asset-a");
      expect(line).not.toContain("rationaleRef");
    }
    __resetAttributionJudgeLoggerForTests();
  });

  it("日志初始化失败/不可写 ⇒ 判定照常成功（日志绝不断链）", async () => {
    // 指向一个**文件**作为目录 ⇒ FileLogger disabled / 写失败
    const bogus = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(bogus, "x");
    initAttributionJudgeLogger(bogus);
    seededUnits();

    const result = await runWorker(buildWorkerDeps(buildConfig({}), "test-owner"), { drain: true });
    expect(result.completed).toBe(1);
    expect(detailsRepo().count()).toBe(1);
    expect(getAttributionJudgeQueueCounters().failures).toBe(0);
  });
});

describe("S5 交付单元：落库四态在 worker 侧的分支（A1/A2）", () => {
  const fakeDetails = (kind: "anomaly" | "failed") => ({
    insertIdempotent: () => ({ judgementId: "jd_0123456789ab", kind }),
    getById: () => null,
    listByUnit: () => [],
    listBySession: () => [],
    count: () => 0,
    latestByUnit: () => null,
  });

  const spyQueueCompletion = () => {
    const q = queueRepo();
    const calls = { complete: 0, fail: 0 };
    const complete = q.complete.bind(q);
    const fail = q.fail.bind(q);
    q.complete = (...args: Parameters<typeof complete>) => {
      calls.complete += 1;
      return complete(...args);
    };
    q.fail = (...args: Parameters<typeof fail>) => {
      calls.fail += 1;
      return fail(...args);
    };
    return calls;
  };

  it("A1 落库 failed ⇒ 不调 complete()、fail() 恰好一次、只进 errored 桶", async () => {
    seededUnits();
    const calls = spyQueueCompletion();

    const result = await runWorker(workerDeps({ detailsRepo: fakeDetails("failed") }), { drain: true });

    expect(calls.complete).toBe(0);
    expect(calls.fail).toBe(1);
    expect(result).toMatchObject({ claimed: 1, completed: 0, idempotent: 0, errored: 1, anomaly: 0 });
    // 「没落成」不得被标 done
    expect(queueRepo().countByStatus().done).toBeUndefined();
  });

  it("A2 落库 anomaly ⇒ result.anomaly===1 且 errored===0（不复用 catch 桶）", async () => {
    seededUnits();
    const calls = spyQueueCompletion();

    const result = await runWorker(workerDeps({ detailsRepo: fakeDetails("anomaly") }), { drain: true });

    expect(result.anomaly).toBe(1);
    expect(result.errored).toBe(0);
    expect(calls.complete).toBe(0);
    expect(calls.fail).toBe(1);
    // 机器可读渠道是 result.anomaly；last_error 只是给人看的补充
    expect(queueRepo().listByStatus("pending")[0]!.last_error).toContain("anomaly");
  });
});
