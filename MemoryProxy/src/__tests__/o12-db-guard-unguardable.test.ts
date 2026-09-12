/**
 * 78 · O12：真库守卫"**不可被吞**"测试矩阵（T1–T4）。
 *
 * 结构：
 *   - T1（决定性）：**故意 `catch {}` 吞掉守卫 throw** ⇒ 账本仍为 1——直接把"不可被吞"
 *     变成可测事实（不必去追那个真实的吞点）；
 *   - T2/T3/T4a：`assertIsolationIntact` 纯函数三格（非空必红 / 自定义临时路径合法 /
 *     默认真库必红）；
 *   - T4b（结构）：断言调用必须在 `afterAll` 内、且**位置在"还原 env"之前**——R2/R4 的钉点。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  __realDbGuardViolations,
  __resetRealDbGuardViolations,
  closeDb,
  getDb,
} from "../db/index.js";
import {
  assertIsolationIntact,
  isolatedDbPathForTests,
  restoreIsolatedDbPath,
} from "./setup/isolate-db.js";

const DEFAULT_DB_PATH = path.join(os.homedir(), ".tdai-memory-proxy", "proxy.db");

describe("78 · T1 守卫不可被吞（决定性）", () => {
  it("try { getDb() } catch {} 吞掉 throw 后，账本仍记 1 条（含路径；80 起为临时 HOME 沙箱）", () => {
    // 80 · C1（认领 G2）：把"默认真库"整体搬进**临时 HOME 沙箱**——守卫若被回归删除，
    // 该用例真打开的也只是沙箱库（不再可能碰到用户真库）；守卫判据/位置零改动。
    const prevHome = process.env.HOME;
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "o12-home-"));
    process.env.HOME = sandboxHome;
    process.env.PROXY_DB_PATH = path.join(sandboxHome, ".tdai-memory-proxy", "proxy.db");
    try {
      closeDb();
      __resetRealDbGuardViolations();
      try {
        getDb();
      } catch {
        /* 故意吞掉 throw——模拟被外层 catch 吃掉的路径（73 C5 格 1 的形态） */
      }
      const v = __realDbGuardViolations();
      console.log(`78-T1 → 吞掉 throw 后账本=${JSON.stringify(v)}；sandbox=${sandboxHome}`);
      expect(v.length).toBe(1);
      expect(v[0]).toContain("proxy.db");
      expect(v[0]).toContain(".tdai-memory-proxy");
      // 80 · C1 新断言：路径必须落在**沙箱 HOME** 内（钉住"沙箱化确实生效"）。
      expect(v[0]).toContain(sandboxHome);
    } finally {
      process.env.HOME = prevHome; // ← 还原 HOME（必须；否则污染同 worker 后续用例）
      restoreIsolatedDbPath(); // ← 恢复隔离（afterAll 的"隔离未拆开"检查依赖它）
      __resetRealDbGuardViolations(); // ← 归还账本（本格故意触发守卫）
      fs.rmSync(sandboxHome, { recursive: true, force: true });
    }
  });
});

describe("78 · T2/T3/T4a 纯函数：assertIsolationIntact", () => {
  it("T2：账本非空 ⇒ 必 throw（报错列出每条路径+时间戳）", () => {
    const violations = ["[2026-09-12T00:00:00.000Z] /home/u/.tdai-memory-proxy/proxy.db"];
    const run = (): void =>
      assertIsolationIntact({ violations, resolvedPath: "/tmp/x/proxy.db", defaultPath: DEFAULT_DB_PATH });
    console.log(`78-T2 → violations=${JSON.stringify(violations)} ⇒ throw=${(() => { try { run(); return false; } catch { return true; } })()}`);
    expect(run).toThrow(/真库守卫/);
    expect(run).toThrow(/\.tdai-memory-proxy/);
  });

  it("T3：自定义临时路径（13 文件形态）⇒ 不 throw（判据不写严）", () => {
    const run = (): void =>
      assertIsolationIntact({
        violations: [],
        resolvedPath: "/tmp/my-own-temp-xyz/proxy.db",
        defaultPath: DEFAULT_DB_PATH,
      });
    console.log("78-T3 → 自定义临时路径 ⇒ 不 throw");
    expect(run).not.toThrow();
  });

  it("T4a：resolvedPath = 默认真库（模拟测试里 delete 了 env）⇒ 必 throw", () => {
    const run = (): void =>
      assertIsolationIntact({ violations: [], resolvedPath: DEFAULT_DB_PATH, defaultPath: DEFAULT_DB_PATH });
    console.log("78-T4a → 默认真库 ⇒ throw");
    expect(run).toThrow(/默认真库/);
  });
});

describe("78 · T4b 结构断言：afterAll 断言位置必须在还原 env 之前（R2/R4 钉点）", () => {
  it("调用存在（未被注释）+ 位置 < env 还原处 + 顶层清账存在", () => {
    const src = fs.readFileSync(new URL("./setup/isolate-db.ts", import.meta.url), "utf8");
    // 调用形态 = `assertIsolationIntact({`（函数定义是 `(input: {`，不冲突）。
    const callIdx = src.indexOf("assertIsolationIntact({");
    // 还原形态 = `if (prevDbPath === undefined) delete process.env.PROXY_DB_PATH;`（头注里的裸词不算）。
    const restoreIdx = src.indexOf("if (prevDbPath === undefined) delete process.env.PROXY_DB_PATH;");
    const callLineIdx = src.split("\n").findIndex((l) => l.includes("assertIsolationIntact({"));
    const callLine = src.split("\n")[callLineIdx] ?? "";
    console.log(
      `78-T4b → call@${callIdx} < restore@${restoreIdx}；调用行未被注释=${!callLine.trim().startsWith("//")}；` +
        `顶层清账=${src.includes("__resetRealDbGuardViolations();")}`,
    );
    expect(callIdx).toBeGreaterThan(0);
    expect(restoreIdx).toBeGreaterThan(0);
    expect(callIdx).toBeLessThan(restoreIdx); // **断言在还原之前**（R4：放后面 ⇒ 红）
    expect(callLine.trim().startsWith("//")).toBe(false); // 调用不得被注释（R2：改 no-op ⇒ 红）
    expect(src).toContain("__resetRealDbGuardViolations();"); // 每文件清账（C2）
    // 导入的隔离路径 helper 供 T1 恢复用（防 tree-shake 误报）
    expect(isolatedDbPathForTests()).toContain("tdai-vitest-");
  });
});
