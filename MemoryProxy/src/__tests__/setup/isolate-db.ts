/**
 * 73 · C1/C3 测试 DB 隔离（vitest `setupFiles`；**每个测试文件独享临时库**）。
 *
 * - **绝不用静态共享路径**：vitest 默认多文件并行 ⇒ 共享路径会互相踩库。
 * - 既有自行设 `PROXY_DB_PATH` 的文件保持原样（它们覆盖本 setup 值，语义不变）。
 * - `restoreIsolatedDbPath()` 供 C3：把 **`delete process.env.PROXY_DB_PATH`** 替换为
 *   "恢复 setup 值"——delete 会制造"裸跑窗口"，回落到默认真库时被 `getDb()` 的
 *   真库守卫（73 C2）显式 throw。
 * - `afterAll`：关连接 + 还原 env 原值 + 删临时目录（失败只 warn）。
 *
 * 78 · O12（防御纵深）：守卫的 `throw` 可能被调用链上的 `try/catch` 吞掉 ⇒
 *   - 模块顶层**清违规账本**（每文件干净起点）；守卫触发时**先记录、后 throw**（C1，见 `db/index.ts`）；
 *   - `afterAll` **在还原 env 之前**断言两件：① 违规账本为空 ② `resolveDbPath()` ≠ 默认真库
 *     （②专门抓"测试里 delete/覆盖过 env"的裸跑窗口——放还原后则抓不到）。
 *   判定抽成纯函数 `assertIsolationIntact`（node 单测直测）。**结构信号优先于人的自觉**：
 *   不让防线强度取决于"没人手滑把它包进 try/catch"。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

import {
  __resetDbForTests,
  __resetRealDbGuardViolations,
  __realDbGuardViolations,
  closeDb,
  resolveDbPath,
} from "../../db/index.js";

const prevDbPath = process.env.PROXY_DB_PATH;
// 每个测试文件一个 mkdtemp（文件级隔离；不用静态共享路径）。
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-vitest-"));
const isolatedDbPath = path.join(tempDir, "proxy.db");

process.env.PROXY_DB_PATH = isolatedDbPath;

// 78 · O12：每文件干净起点（vitest 每文件独立 worker）。
__resetRealDbGuardViolations();

/** 默认（真实）用户库路径——与 `db/index.ts` 守卫判据同式。 */
const DEFAULT_DB_PATH = path.join(os.homedir(), ".tdai-memory-proxy", "proxy.db");

/**
 * 78 · O12：隔离完整性判定（**纯函数**；可在 node 单测里直测，不依赖 vitest 生命周期）。
 *
 * 判据**刻意不写严**：只要求"**不是默认真库**"——**不是**"等于 setup 的隔离路径"，
 * 因为既有 13 个测试文件自设临时路径是合法做法（F5）。
 */
export function assertIsolationIntact(input: {
  violations: readonly string[];
  resolvedPath: string;
  defaultPath: string;
}): void {
  if (input.violations.length > 0) {
    throw new Error(
      `[test-db-guard] 真库守卫在本次测试中被触发（${input.violations.length} 次；被吞与否都记账）：\n` +
        input.violations.map((v) => `  · ${v}`).join("\n"),
    );
  }
  if (input.resolvedPath === input.defaultPath) {
    throw new Error(
      `[test-db-guard] 测试退出时 PROXY_DB_PATH 指向默认真库（${input.resolvedPath}）——` +
        `疑似测试内 delete/覆盖了 env（裸跑窗口）。请在 afterAll 恢复（或改用 restoreIsolatedDbPath()）。`,
    );
  }
}

/** C3：恢复 setup 指向的隔离库路径（**替代** `delete process.env.PROXY_DB_PATH`）。 */
export function restoreIsolatedDbPath(): void {
  process.env.PROXY_DB_PATH = isolatedDbPath;
}

/** 78 · O12：setup 指向的隔离库路径（测试里做"临时指向真库"演练后恢复用）。 */
export function isolatedDbPathForTests(): string {
  return isolatedDbPath;
}

afterAll(() => {
  try {
    // 78 · O12：**先断言**——必须在"还原 env"**之前**（此处 env = 测试退出时的样子，
    // 才能抓到"测试里 delete/覆盖过 env"的裸跑窗口）；失败 ⇒ throw ⇒ 本测试文件必红。
    assertIsolationIntact({
      violations: __realDbGuardViolations(),
      resolvedPath: resolveDbPath(),
      defaultPath: DEFAULT_DB_PATH,
    });
  } finally {
    // 还原与清理放 finally：即使断言抛出也不留垃圾。
    try {
      closeDb();
      __resetDbForTests();
    } catch {
      /* 连接从未打开或已关闭 */
    }
    if (prevDbPath === undefined) delete process.env.PROXY_DB_PATH;
    else process.env.PROXY_DB_PATH = prevDbPath;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[test-db-isolation] temp dir cleanup failed: ${tempDir}`, err);
    }
  }
});
