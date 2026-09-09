/**
 * VisibleTextRepo — persistence for the P0 visible-text archive
 * (docs/implementation/40-visible-text-archive.md §4-§6).
 *
 * Two write tiers + one watermark row per session:
 *   - 档① rendered injection blocks  → attribution_block_seen + attribution_block_text
 *     (content deduplicated globally by content_hash; source is annotation only)
 *   - 档② message-stream increments  → attribution_message_snap (epoch layered, compaction
 *     mirrors decision-unit-runner's in-memory watermark reset)
 *   - epoch/last_seen_count watermark → attribution_archive_watermark
 *
 * Read side exposes window()/archive() building blocks (join text back into seen rows,
 * filter by epoch/turn range). Cross-tier ordering and the read-期 dedupeByContentHash
 * fold option live at the API layer (windowVisibleText), NOT in SQL.
 *
 * Failure semantics mirror attributionEventRepo: any DB error degrades silently, never
 * throws into the request path. SQLite UNIQUE violations are *expected* on crash replay
 * (block_text content_hash / message_snap (session,epoch,index)) — swallowed at info level,
 * distinct from real failures (warned).
 *
 * Row shape follows the repo convention: snake_case columns returned as-is; content_json /
 * asset_ids are handed to the caller as raw strings (repo does not decode business objects).
 */

import type Database from "better-sqlite3";

import { getDb } from "./index.js";

// ── Write inputs ────────────────────────────────────────────────────────────────────

/** 档① 文本行。content_hash 为全局去重键（§3 规则 2 / B5：source 不进唯一键）。 */
export interface NewBlockText {
  source: string;
  contentHash: string; // sha256(utf8(content))
  contentUtf8: string; // 超 cap 时存前段
  chars: number; // 原长（截断前全量字符数）
  bytes: number; // 原长 utf8 字节数（截断前）
  truncated: boolean;
}

/** 档① occurrence 行（每轮每 hook 每 block 一条链接）。asset_ids = collectAssets 摘要 JSON。 */
export interface NewBlockSeen {
  sessionKey: string;
  turnSeq: number;
  hookId: string;
  point: string;
  contentId: number;
  blockIdx: number;
  assetIdsJson: string | null;
}

/** 档② 消息快照行。epoch/compaction 语义见 40 spec §4.1。 */
export interface NewMessageSnap {
  sessionKey: string;
  epoch: number;
  turnSeq: number; // §4.2 与 extractor 同源的前缀计数
  messageIndex: number;
  role: string; // user/assistant/tool；system 行不入档
  contentHash: string; // §5 read 期跨档去重选项用
  contentJson: string; // 文本/tool_calls/tool_result 原文（超 cap 截断后仍为合法 JSON）
  chars: number; // 原长字符数
  truncated: boolean;
}

/** 档② 水位行（镜像 runner 内存"已见消息条数"语义，B4）。 */
export interface WatermarkRow {
  session_key: string;
  epoch: number;
  last_seen_count: number;
}

// ── Read rows ───────────────────────────────────────────────────────────────────────

/** 档① seen JOIN text（occurrence + 内容一体返回，供 window 直接拼正文）。 */
export interface BlockSeenWithTextRow {
  seen_id: number;
  session_key: string;
  turn_seq: number;
  hook_id: string;
  point: string;
  block_idx: number;
  asset_ids: string | null;
  content_id: number;
  source: string;
  content_hash: string;
  content_utf8: string;
  chars: number;
  bytes: number;
  truncated: number;
}

/** 档② 快照行（原样返回，content_json 保持字符串由调用方解析）。 */
export interface MessageSnapRow {
  msg_id: number;
  session_key: string;
  epoch: number;
  turn_seq: number;
  message_index: number;
  role: string;
  content_hash: string;
  content_json: string;
  chars: number;
  truncated: number;
}

export interface WindowOpts {
  epoch?: number; // 缺省 = 当前水位 epoch
  turnFrom?: number;
  turnTo?: number;
}

/** window() read 选项：WindowOpts + §5 read 期跨档去重开关（B5，缺省关）。 */
export interface VisibleWindowReadOpts extends WindowOpts {
  /** 开时按 content_hash 折叠整条同内容（保留窗口序中每个 hash 的首次出现，后续同 hash 丢弃）。 */
  dedupeByContentHash?: boolean;
}

export interface VisibleTextRepo {
  // ── 档① 写 ──
  /** content_hash 全局去重 upsert；返回 content_id + 是否新插入。 */
  upsertBlockText(t: NewBlockText): { contentId: number; inserted: boolean };
  /** occurrence 行（幂等无唯一约束；写失败静默降级）。 */
  insertBlockSeen(s: NewBlockSeen): void;

  // ── 档② 写 ──
  /** (session, epoch, message_index) 唯一冲突静默跳过（崩溃重放兜底）。 */
  insertMessageSnap(m: NewMessageSnap): void;
  /** upsert 水位（INSERT OR REPLACE 单行每会话）。 */
  upsertWatermark(sessionKey: string, epoch: number, lastSeenCount: number): void;

  // ── 读（§5 分侧诚实：单 epoch 视图 + 跨 epoch 归档超集由 API 层组合）──
  getWatermark(sessionKey: string): WatermarkRow | null;
  /** 档① occurrence+内容，可按 turn 区间过滤（无 epoch 维度，见 40 spec §5 诚实注记）。 */
  listBlockSeen(sessionKey: string, opts?: WindowOpts): BlockSeenWithTextRow[];
  /** 档② 快照，可按 epoch / turn 区间过滤；不排序（排序是 API 语义，B5）。 */
  listMessageSnaps(sessionKey: string, opts?: WindowOpts): MessageSnapRow[];
  /** 档② 已存在的全部 epoch（归档超集视图用）。 */
  listEpochs(sessionKey: string): number[];
}

// ── Write counters（观测/测试断言用；区分预期 dedupe 与真实失败）───────────────
export interface VisibleArchiveWriteCounters {
  blockTextInserted: number;
  blockTextDedupe: number;
  blockSeen: number;
  messageSnapInserted: number;
  messageSnapDedupe: number;
  watermarkUpserts: number;
  failures: number;
}
const writeCounters: VisibleArchiveWriteCounters = {
  blockTextInserted: 0,
  blockTextDedupe: 0,
  blockSeen: 0,
  messageSnapInserted: 0,
  messageSnapDedupe: 0,
  watermarkUpserts: 0,
  failures: 0,
};

export function getVisibleArchiveWriteCounters(): VisibleArchiveWriteCounters {
  return { ...writeCounters };
}

function isConstraintViolation(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
  }
  return false;
}

function toBool(v: number | null | undefined): boolean {
  return v === 1;
}

class SqliteVisibleTextRepo implements VisibleTextRepo {
  private upsertTextStmt: Database.Statement; // INSERT OR IGNORE → 冲突时再 SELECT
  private findTextByHashStmt: Database.Statement;
  private seenInsertStmt: Database.Statement;
  private snapInsertStmt: Database.Statement;
  private watermarkUpsertStmt: Database.Statement;
  private watermarkGetStmt: Database.Statement;
  private blockSeenBase: string;
  private messageSnapsBase: string;

  constructor(private db: Database.Database) {
    this.upsertTextStmt = db.prepare(`
INSERT OR IGNORE INTO attribution_block_text (source, content_hash, content_utf8, chars, bytes, truncated)
VALUES (@source, @contentHash, @contentUtf8, @chars, @bytes, @truncated)
`);
    this.findTextByHashStmt = db.prepare(
      "SELECT content_id FROM attribution_block_text WHERE content_hash = ?",
    );
    this.seenInsertStmt = db.prepare(`
INSERT INTO attribution_block_seen (session_key, turn_seq, hook_id, point, content_id, block_idx, asset_ids)
VALUES (@sessionKey, @turnSeq, @hookId, @point, @contentId, @blockIdx, @assetIdsJson)
`);
    this.snapInsertStmt = db.prepare(`
INSERT OR IGNORE INTO attribution_message_snap
  (session_key, epoch, turn_seq, message_index, role, content_hash, content_json, chars, truncated)
VALUES (@sessionKey, @epoch, @turnSeq, @messageIndex, @role, @contentHash, @contentJson, @chars, @truncated)
`);
    this.watermarkUpsertStmt = db.prepare(`
INSERT OR REPLACE INTO attribution_archive_watermark (session_key, epoch, last_seen_count)
VALUES (@sessionKey, @epoch, @lastSeenCount)
`);
    this.watermarkGetStmt = db.prepare(
      "SELECT session_key, epoch, last_seen_count FROM attribution_archive_watermark WHERE session_key = ?",
    );
    // 排序留在 API 层（B5）：DB 只保证归组/过滤。
    this.blockSeenBase = `
SELECT s.seen_id, s.session_key, s.turn_seq, s.hook_id, s.point, s.block_idx, s.asset_ids,
       t.content_id, t.source, t.content_hash, t.content_utf8, t.chars, t.bytes, t.truncated
FROM attribution_block_seen s
JOIN attribution_block_text t ON t.content_id = s.content_id
WHERE s.session_key = ?
`;
    this.messageSnapsBase = `
SELECT msg_id, session_key, epoch, turn_seq, message_index, role, content_hash, content_json, chars, truncated
FROM attribution_message_snap
WHERE session_key = ?
`;
  }

  upsertBlockText(t: NewBlockText): { contentId: number; inserted: boolean } {
    try {
      // better-sqlite3 不接受 boolean 绑定：truncated 转 0/1。
      const res = this.upsertTextStmt.run({
        source: t.source,
        contentHash: t.contentHash,
        contentUtf8: t.contentUtf8,
        chars: t.chars,
        bytes: t.bytes,
        truncated: t.truncated ? 1 : 0,
      });
      if (res.changes === 1) {
        writeCounters.blockTextInserted += 1;
        const row = this.findTextByHashStmt.get(t.contentHash) as { content_id: number } | undefined;
        return { contentId: Number(row?.content_id ?? res.lastInsertRowid), inserted: true };
      }
      // INSERT OR IGNORE：无 changes 且非错误 → 已存在
      const row = this.findTextByHashStmt.get(t.contentHash) as { content_id: number } | undefined;
      writeCounters.blockTextDedupe += 1;
      return { contentId: row ? Number(row.content_id) : 0, inserted: false };
    } catch (err) {
      writeCounters.failures += 1;
      console.warn(
        "[visible-archive] upsertBlockText failed:",
        err instanceof Error ? err.message : String(err),
      );
      return { contentId: 0, inserted: false };
    }
  }

  insertBlockSeen(s: NewBlockSeen): void {
    try {
      this.seenInsertStmt.run(s);
      writeCounters.blockSeen += 1;
    } catch (err) {
      if (isConstraintViolation(err)) {
        // FK 异常理论上不存在（content_id 由 upsert 返回）；保留 info 便于观测。
        writeCounters.failures += 1;
        console.info("[visible-archive] insertBlockSeen constraint skipped:", s.hookId);
        return;
      }
      writeCounters.failures += 1;
      console.warn(
        "[visible-archive] insertBlockSeen failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  insertMessageSnap(m: NewMessageSnap): void {
    try {
      const res = this.snapInsertStmt.run({
        sessionKey: m.sessionKey,
        epoch: m.epoch,
        turnSeq: m.turnSeq,
        messageIndex: m.messageIndex,
        role: m.role,
        contentHash: m.contentHash,
        contentJson: m.contentJson,
        chars: m.chars,
        truncated: m.truncated ? 1 : 0,
      });
      if (res.changes === 1) {
        writeCounters.messageSnapInserted += 1;
      } else {
        // INSERT OR IGNORE 命中 (session,epoch,index) 唯一 → 崩溃重放预期路径。
        writeCounters.messageSnapDedupe += 1;
        console.info(
          `[visible-archive] message snap skipped (session=${m.sessionKey} epoch=${m.epoch} index=${m.messageIndex})`,
        );
      }
    } catch (err) {
      writeCounters.failures += 1;
      console.warn(
        "[visible-archive] insertMessageSnap failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  upsertWatermark(sessionKey: string, epoch: number, lastSeenCount: number): void {
    try {
      this.watermarkUpsertStmt.run({ sessionKey, epoch, lastSeenCount });
      writeCounters.watermarkUpserts += 1;
    } catch (err) {
      writeCounters.failures += 1;
      console.warn(
        "[visible-archive] upsertWatermark failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  getWatermark(sessionKey: string): WatermarkRow | null {
    try {
      const row = this.watermarkGetStmt.get(sessionKey) as WatermarkRow | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }

  private buildBlockSeenSql(opts?: WindowOpts): { sql: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.turnFrom !== undefined) where.push("s.turn_seq >= ?");
    if (opts?.turnTo !== undefined) where.push("s.turn_seq <= ?");
    if (opts?.turnFrom !== undefined) params.push(opts.turnFrom);
    if (opts?.turnTo !== undefined) params.push(opts.turnTo);
    const sql = where.length > 0
      ? `${this.blockSeenBase} AND ${where.join(" AND ")}`
      : this.blockSeenBase;
    return { sql, params };
  }

  listBlockSeen(sessionKey: string, opts?: WindowOpts): BlockSeenWithTextRow[] {
    try {
      const { sql, params } = this.buildBlockSeenSql(opts);
      const rows = (this.db.prepare(sql).all(sessionKey, ...params) ?? []) as BlockSeenWithTextRow[];
      return rows;
    } catch {
      return [];
    }
  }

  private buildMessageSnapsSql(opts?: WindowOpts): { sql: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.epoch !== undefined) where.push("epoch = ?");
    if (opts?.turnFrom !== undefined) where.push("turn_seq >= ?");
    if (opts?.turnTo !== undefined) where.push("turn_seq <= ?");
    if (opts?.epoch !== undefined) params.push(opts.epoch);
    if (opts?.turnFrom !== undefined) params.push(opts.turnFrom);
    if (opts?.turnTo !== undefined) params.push(opts.turnTo);
    const sql = where.length > 0
      ? `${this.messageSnapsBase} AND ${where.join(" AND ")}`
      : this.messageSnapsBase;
    return { sql, params };
  }

  listMessageSnaps(sessionKey: string, opts?: WindowOpts): MessageSnapRow[] {
    try {
      const { sql, params } = this.buildMessageSnapsSql(opts);
      const rows = (this.db.prepare(sql).all(sessionKey, ...params) ?? []) as MessageSnapRow[];
      return rows;
    } catch {
      return [];
    }
  }

  listEpochs(sessionKey: string): number[] {
    try {
      const rows = (this.db
        .prepare("SELECT DISTINCT epoch AS e FROM attribution_message_snap WHERE session_key = ? ORDER BY e ASC")
        .all(sessionKey) ?? []) as Array<{ e: number }>;
      return rows.map((r) => Number(r.e));
    } catch {
      return [];
    }
  }
}

class NullVisibleTextRepo implements VisibleTextRepo {
  upsertBlockText(): { contentId: number; inserted: boolean } {
    return { contentId: 0, inserted: false };
  }
  insertBlockSeen(): void {}
  insertMessageSnap(): void {}
  upsertWatermark(): void {}
  getWatermark(): WatermarkRow | null {
    return null;
  }
  listBlockSeen(): BlockSeenWithTextRow[] {
    return [];
  }
  listMessageSnaps(): MessageSnapRow[] {
    return [];
  }
  listEpochs(): number[] {
    return [];
  }
}

let _repo: VisibleTextRepo | null = null;

export function getVisibleTextRepo(): VisibleTextRepo {
  if (_repo) return _repo;
  const db = getDb();
  _repo = db ? new SqliteVisibleTextRepo(db) : new NullVisibleTextRepo();
  return _repo;
}

/** Replace the singleton (tests with an in-memory / alternate backend). */
export function setVisibleTextRepo(repo: VisibleTextRepo): void {
  _repo = repo;
}

/** Reset singleton — tests only. */
export function __resetVisibleTextRepoForTests(): void {
  _repo = null;
  writeCounters.blockTextInserted = 0;
  writeCounters.blockTextDedupe = 0;
  writeCounters.blockSeen = 0;
  writeCounters.messageSnapInserted = 0;
  writeCounters.messageSnapDedupe = 0;
  writeCounters.watermarkUpserts = 0;
  writeCounters.failures = 0;
}

// ── §5 API 层：拼接 read（get/set 可注入 repo + 默认走 singleton）───────────────

export interface VisibleWindowPiece {
  epoch: number | null; // 仅档②消息有值；档① occurrence 无 epoch 维度
  turnSeq: number;
  tier: "block" | "message";
  seq: number;
  source: string;
  contentHash: string;
  content: string; // block: content_utf8；message: content_json
  truncated: boolean;
  chars: number;
  role: string | null;
  blockIdx: number | null;
}

export interface VisibleWindow {
  epoch: number | null; // 当前水位 epoch；无水位行时 null（无档②）
  pieces: VisibleWindowPiece[];
}

/** 当前水位（档②侧）。查不到水位行 → { epoch: 0, lastSeen: 0 }（新会话语义）。 */
export function readWatermark(repo: VisibleTextRepo, sessionKey: string): { epoch: number; lastSeen: number } {
  const row = repo.getWatermark(sessionKey);
  return row ? { epoch: row.epoch, lastSeen: row.last_seen_count } : { epoch: 0, lastSeen: 0 };
}

/**
 * §5 read 期跨档去重助手：按 content_hash 折叠整条同内容（保留窗口序首次出现）。
 * - 输入须已按窗口序排好（即 windowVisibleText 的输出序）；调用方/S5 亦可直接复用。
 * - 语义是"hash 级折叠"（spec §5）：合成块与消息逐字节相同（同 hash）等罕见跨档重复被折叠；
 *   截断行与原行同 hash（去重键按全文 fingerprint），折叠取窗口序更早的 piece —— 按 spec 定义，
 *   不是按存储 head 是否相同。
 */
export function dedupePiecesByContentHash(pieces: VisibleWindowPiece[]): VisibleWindowPiece[] {
  const seen = new Set<string>();
  const out: VisibleWindowPiece[] = [];
  for (const p of pieces) {
    if (seen.has(p.contentHash)) continue;
    seen.add(p.contentHash);
    out.push(p);
  }
  return out;
}

/**
 * §5 window()：以"同 (epoch, turn_seq) 档位"拼接档① + 档②。
 * - 档①无 epoch 维度 → 按 turn 区间取（诚实注记：跨 epoch 的档① occurrences 会并入，
 *   内容行因 content_hash 全局去重不重复计数 —— S5 需按决策单元锚点 epoch+turn 取窗）。
 * - 档②默认取当前水位 epoch（B4：单 epoch 视图不混代）；传 epoch 可看指定代。
 * - 排序：(turn_seq, tier, seq) —— 轮次时间序，同轮内 system 层 block 先于 message。
 * - dedupeByContentHash（缺省关，B5）：开时按 content_hash 折叠整条同内容。
 */
export function windowVisibleText(
  repo: VisibleTextRepo,
  sessionKey: string,
  opts?: VisibleWindowReadOpts,
): VisibleWindow {
  const watermark = readWatermark(repo, sessionKey);
  const epoch = opts?.epoch ?? watermark.epoch;
  const blocks = repo.listBlockSeen(sessionKey, {
    turnFrom: opts?.turnFrom,
    turnTo: opts?.turnTo,
  });
  const messages = repo.listMessageSnaps(sessionKey, {
    epoch,
    turnFrom: opts?.turnFrom,
    turnTo: opts?.turnTo,
  });

  const pieces: VisibleWindowPiece[] = [];
  for (const b of blocks) {
    pieces.push({
      epoch: null,
      turnSeq: b.turn_seq,
      tier: "block",
      seq: b.block_idx,
      source: b.source,
      contentHash: b.content_hash,
      content: b.content_utf8,
      truncated: toBool(b.truncated),
      chars: b.chars,
      role: null,
      blockIdx: b.block_idx,
    });
  }
  for (const m of messages) {
    pieces.push({
      epoch: m.epoch,
      turnSeq: m.turn_seq,
      tier: "message",
      seq: m.message_index,
      source: m.role,
      contentHash: m.content_hash,
      content: m.content_json,
      truncated: toBool(m.truncated),
      chars: m.chars,
      role: m.role,
      blockIdx: null,
    });
  }
  // §5 排序语义：(turn_seq, tier, seq) —— 按轮次时间序，同轮内 system 层 block 先于 message。
  // 档① occurrence 无 epoch 维度，跨 epoch 会话的混排由 §5 诚实注记兜底（S5 按锚点取窗）。
  pieces.sort((a, b) => {
    if (a.turnSeq !== b.turnSeq) return a.turnSeq - b.turnSeq;
    const tierDiff = (a.tier === "block" ? 0 : 1) - (b.tier === "block" ? 0 : 1);
    if (tierDiff !== 0) return tierDiff;
    return a.seq - b.seq;
  });
  if (opts?.dedupeByContentHash === true) {
    return { epoch, pieces: dedupePiecesByContentHash(pieces) };
  }
  return { epoch, pieces };
}

/** §5 archive()：跨 epoch 归档超集（compaction 后原始 + 压缩改写版本并存，如实交付 S5）。 */
export function archiveVisibleText(repo: VisibleTextRepo, sessionKey: string): {
  epochs: number[];
  pieces: VisibleWindowPiece[];
} {
  const epochs = repo.listEpochs(sessionKey);
  const all: VisibleWindowPiece[] = [];
  for (const epoch of epochs) {
    const messages = repo.listMessageSnaps(sessionKey, { epoch });
    for (const m of messages) {
      all.push({
        epoch: m.epoch,
        turnSeq: m.turn_seq,
        tier: "message",
        seq: m.message_index,
        source: m.role,
        contentHash: m.content_hash,
        content: m.content_json,
        truncated: toBool(m.truncated),
        chars: m.chars,
        role: m.role,
        blockIdx: null,
      });
    }
  }
  // 归档超集 = 按 (epoch, turn_seq, seq) 升序，跨代原始/改写版本如实并排。
  all.sort(
    (a, b) =>
      (a.epoch ?? 0) - (b.epoch ?? 0) ||
      a.turnSeq - b.turnSeq ||
      a.seq - b.seq,
  );
  return { epochs, pieces: all };
}
