/**
 * 共享基座单测的临时库装置（照 visible-archive-golden.test.ts 的 withTempDb 姿势）。
 *
 * 顺序有讲究：先换 `PROXY_DB_PATH`，再 reset DB 单例，最后 reset repo 单例 ——
 * repo 是**绑定到 db 句柄**的（构造期 prepare），漏掉任一步都会让测试互相串库。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { __resetDbForTests } from "../../../db/index.js";
import {
  __resetAttributionJudgeQueueRepoForTests,
  getAttributionJudgeQueueRepo,
  type AttributionJudgeQueueRepo,
} from "../../judge-queue-repo.js";
import {
  __resetAttributionJudgementDetailsRepoForTests,
  getAttributionJudgementDetailsRepo,
  type AttributionJudgementDetailsRepo,
} from "../../judgement-details-repo.js";
import { __resetAttributionJudgeLoggerForTests } from "../../judge-log.js";
import { DeterministicMockJudge } from "../../judge/deterministic-mock-judge.js";
import { __resetAttributionStatusEventsRepoForTests } from "../../status-events-repo.js";
import type { AttributionWorkerDeps } from "../../worker.js";

let dir: string | null = null;

export function withTempDb(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-attr-base-"));
  process.env.PROXY_DB_PATH = path.join(dir, "proxy.db");
  __resetDbForTests();
  __resetAttributionJudgeQueueRepoForTests();
  __resetAttributionJudgementDetailsRepoForTests();
  __resetAttributionStatusEventsRepoForTests(); // 59 · 状态事件单例 + counters
  __resetAttributionJudgeLoggerForTests();
  return dir;
}

export function teardownTempDb(): void {
  __resetAttributionJudgeQueueRepoForTests();
  __resetAttributionJudgementDetailsRepoForTests();
  __resetAttributionStatusEventsRepoForTests();
  __resetAttributionJudgeLoggerForTests();
  __resetDbForTests();
  delete process.env.PROXY_DB_PATH;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
}

export function queueRepo(): AttributionJudgeQueueRepo {
  return getAttributionJudgeQueueRepo();
}

export function detailsRepo(): AttributionJudgementDetailsRepo {
  return getAttributionJudgementDetailsRepo();
}

/** 单测友好的 worker deps：零退避 + 无日志落盘 + 可注入 judge。 */
export function workerDeps(
  overrides: Partial<AttributionWorkerDeps> = {},
): AttributionWorkerDeps {
  return {
    queueRepo: queueRepo(),
    detailsRepo: detailsRepo(),
    judge: new DeterministicMockJudge(),
    owner: "worker-test",
    batchSize: 8,
    leaseTtlMs: 60_000,
    maxAttempts: 3,
    pollIntervalMs: 1,
    backoffMs: 0,
    // 62 · top-N 成本闸门缺省（30 spec 口径；与生产 DEFAULT_CONFIG 一致）
    topNPerCycle: 30,
    sleep: async () => {},
    emitLog: () => {},
    ...overrides,
  };
}
