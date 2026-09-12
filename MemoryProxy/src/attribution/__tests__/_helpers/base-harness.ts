/**
 * 共享基座单测的临时库装置（照 visible-archive-golden.test.ts 的 withTempDb 姿势）。
 *
 * 顺序有讲究：先换 `PROXY_DB_PATH`，再 reset DB 单例，最后 reset repo 单例 ——
 * repo 是**绑定到 db 句柄**的（构造期 prepare），漏掉任一步都会让测试互相串库。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { __resetAttributionEventRepoForTests } from "../../../db/attributionEventRepo.js";
import { __resetDbForTests } from "../../../db/index.js";
import { restoreIsolatedDbPath } from "../../../__tests__/setup/isolate-db.js";
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
import { __resetAttributionAuditReviewsRepoForTests } from "../../audit-reviews-repo.js";
import { __resetAttributionStatusEventsRepoForTests } from "../../status-events-repo.js";
import type { AttributionWorkerDeps } from "../../worker.js";

let dir: string | null = null;

export function withTempDb(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-attr-base-"));
  process.env.PROXY_DB_PATH = path.join(dir, "proxy.db");
  __resetDbForTests();
  __resetAttributionEventRepoForTests(); // 66 · v1 事件表单例（漏它会把写入落到上一个已删库的孤儿连接）
  __resetAttributionJudgeQueueRepoForTests();
  __resetAttributionJudgementDetailsRepoForTests();
  __resetAttributionStatusEventsRepoForTests(); // 59 · 状态事件单例 + counters
  __resetAttributionAuditReviewsRepoForTests(); // 74 · 抽查状态单例 + counters
  __resetAttributionJudgeLoggerForTests();
  return dir;
}

export function teardownTempDb(): void {
  __resetAttributionEventRepoForTests();
  __resetAttributionJudgeQueueRepoForTests();
  __resetAttributionJudgementDetailsRepoForTests();
  __resetAttributionStatusEventsRepoForTests();
  __resetAttributionAuditReviewsRepoForTests();
  __resetAttributionJudgeLoggerForTests();
  __resetDbForTests();
  // 78 · O12：**恢复 setup 的隔离值**（替代裸 `delete`）——裸 delete 会让 setup 的
  // 收尾断言（"隔离未被拆开"）看到 `PROXY_DB_PATH` 落到默认真库（与"测试里删了 env
  // 的裸跑窗口"在事后不可区分）；恢复语义与 73 C3 的 `restoreIsolatedDbPath()` 同向。
  restoreIsolatedDbPath();
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
