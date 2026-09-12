/**
 * 73 · C1/C3 测试 DB 隔离（vitest `setupFiles`；**每个测试文件独享临时库**）。
 *
 * - **绝不用静态共享路径**：vitest 默认多文件并行 ⇒ 共享路径会互相踩库。
 * - 既有自行设 `PROXY_DB_PATH` 的文件保持原样（它们覆盖本 setup 值，语义不变）。
 * - `restoreIsolatedDbPath()` 供 C3：把 **`delete process.env.PROXY_DB_PATH`** 替换为
 *   "恢复 setup 值"——delete 会制造"裸跑窗口"，回落到默认真库时被 `getDb()` 的
 *   真库守卫（73 C2）显式 throw。
 * - `afterAll`：关连接 + 还原 env 原值 + 删临时目录（失败只 warn）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

import { __resetDbForTests, closeDb } from "../../db/index.js";

const prevDbPath = process.env.PROXY_DB_PATH;
// 每个测试文件一个 mkdtemp（文件级隔离；不用静态共享路径）。
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-vitest-"));
const isolatedDbPath = path.join(tempDir, "proxy.db");

process.env.PROXY_DB_PATH = isolatedDbPath;

/** C3：恢复 setup 指向的隔离库路径（**替代** `delete process.env.PROXY_DB_PATH`）。 */
export function restoreIsolatedDbPath(): void {
  process.env.PROXY_DB_PATH = isolatedDbPath;
}

afterAll(() => {
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
});
