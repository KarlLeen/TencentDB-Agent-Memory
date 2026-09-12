/**
 * SQLite singleton for MemoryProxy.
 *
 * - DB path resolution: `process.env.PROXY_DB_PATH` > `~/.tdai-memory-proxy/proxy.db`.
 * - Directory created with mode 0700; DB file chmod'd to 0600 after creation.
 * - PRAGMA journal_mode=WAL, foreign_keys=ON, busy_timeout=2000.
 * - All callers MUST go through prepared statements (Repos enforce this).
 *
 * Errors during initialization are *not* fatal — callers can opt to disable
 * persistence by checking `getDb()` returning null, in which case the proxy
 * continues to operate in-memory only (degraded mode).
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";

import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

// ESM has no global `require`. We use createRequire here so that getDb()
// can stay synchronous (Repos rely on sync construction).
const _require = createRequire(import.meta.url);

let _db: Database.Database | null = null;
let _dbInitFailed = false;

/**
 * 78 · O12：真库守卫**违规账本**（模块级；**先记录、后 throw**）。
 *
 * 动机（防御纵深）：守卫的 `throw` 可能被调用链上任意 `try/catch` 吞掉
 * （73 C5 格 1 实测到过这种形态）⇒ 把"证据"与"控制流"解耦：即使 throw 被吞，
 * 账本里仍有记录，由 `isolate-db.ts` 的 `afterAll` 断言"账本为空"使该文件必红。
 * **结构信号优先于人的自觉**——不让防线强度取决于"没人手滑把它包进 try/catch"。
 */
let _realDbGuardViolations: string[] = [];

/** 78 · O12：仅供测试——违规账本只读快照（不改状态）。 */
export function __realDbGuardViolations(): readonly string[] {
  return [..._realDbGuardViolations];
}

/** 78 · O12：仅供测试——**显式**清账（`__resetDbForTests()` 不隐式清，保持职责单一）。 */
export function __resetRealDbGuardViolations(): void {
  _realDbGuardViolations = [];
}

/** Resolve the DB file path. Caller must ensure parent dir exists. */
export function resolveDbPath(): string {
  const fromEnv = process.env.PROXY_DB_PATH;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), ".tdai-memory-proxy", "proxy.db");
}

/** Ensure the parent directory for the DB exists with mode 0700. */
function ensureDbDir(dbPath: string): void {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync with mode is honored on first creation only; tighten anyway.
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* ignore — non-POSIX FS */
  }
}

/** Run schema creation + meta version bookkeeping. */
function runSchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  const row = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get("schema_version") as { value: string } | undefined;
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
      "schema_version",
      String(SCHEMA_VERSION),
    );
  }
  // Future: handle row.value < SCHEMA_VERSION → run migrations.
}

/**
 * Get (or lazily initialize) the singleton DB connection.
 *
 * Returns `null` if initialization fails (e.g. native module missing,
 * disk unwritable). Callers MUST treat null as "persistence disabled,
 * fall back to memory-only behavior".
 */
export function getDb(): Database.Database | null {
  if (_db) return _db;
  if (_dbInitFailed) return null;

  const dbPath = resolveDbPath();

  // 73 · C2：真实用户库守卫（仅测试环境生效；生产路径零改动）。
  // ⚠️ 必须放在 `try` **之外**：下方 catch 会把异常吞成 `console.warn` + `return null`
  // （持久化降级路径）——守卫的 throw 若插进 try，会被降级成静默 warn，正好违背目的
  // （宁可显式报错也不要静默；实测反模式见 73 工单 F7）。
  // 判据（实测值）：vitest 下 `process.env.VITEST === "true"`（WORKER_ID/POOL_ID 仅为编号）。
  if (
    process.env.VITEST === "true" &&
    dbPath === path.join(os.homedir(), ".tdai-memory-proxy", "proxy.db")
  ) {
    // 78 · O12：**先记录，后 throw**（顺序写死——即使外层 catch 把 throw 吞掉，证据仍在）。
    _realDbGuardViolations.push(`[${new Date().toISOString()}] ${dbPath}`);
    throw new Error(
      `[test-db-guard] 测试正在打开真实用户库（${dbPath}）。\n` +
        `请勿删除 PROXY_DB_PATH —— 它由 setupFiles 指向临时库；\n` +
        `若确实需要自建库，请显式设 process.env.PROXY_DB_PATH 并在 afterAll 恢复。`,
    );
  }

  try {
    ensureDbDir(dbPath);

    // better-sqlite3 is a native CJS module — load it via createRequire so
    // the call stays synchronous (dynamic `import()` would force the whole
    // call chain async and break the Repo-singleton contract).
    const SqliteCtor = _require("better-sqlite3") as typeof Database;
    const db = new SqliteCtor(dbPath);

    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 2000");
    runSchema(db);

    // Tighten file permissions (DB file + WAL/SHM siblings if present).
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        if (fs.existsSync(p)) fs.chmodSync(p, 0o600);
      } catch {
        /* ignore */
      }
    }

    _db = db;
    return _db;
  } catch (err) {
    _dbInitFailed = true;
    console.warn(
      "[session-db] failed to initialize SQLite, persistence disabled:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Close the DB connection. Primarily for tests. */
export function closeDb(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      /* ignore */
    }
    _db = null;
  }
  _dbInitFailed = false;
}

/** Reset internal singleton state. Tests only. */
export function __resetDbForTests(): void {
  closeDb();
}
