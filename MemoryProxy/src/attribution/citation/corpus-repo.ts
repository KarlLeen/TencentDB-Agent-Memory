/**
 * c-4 的**语料读口**（新增文件，纯只读）。
 *
 * 为什么另立一个 repo 而不是扩 `VisibleTextRepo`：
 *   `VisibleTextRepo`（P0 40-spec 已闭验收物）只有 **per-session** 读方法
 *   （`listBlockSeen/listMessageSnaps` 都要 sessionKey），而 c-3 的稀有度表需要
 *   **全局语料**（跨会话、按 content_id/msg_id 升序取前 cap 条，design §4.8.6）。
 *   给 P0 接口加方法等于动已闭验收物 —— 与"生产代码语义零改动"硬约束冲突。
 *   故**新增**本文件承载"全局语料读"，P0 文件一行不改。
 *
 * 只读硬约束（design §4.8.5）：本文件只出现 SELECT，**绝不** INSERT/UPDATE/DELETE/
 * CREATE —— T25 用"写计数全 0 + 水位行不变 + 表结构不变"锁这条。
 *
 * 失败语义照全仓口径：任何 DB 错误静默降级为 `[]`，绝不 throw（F1）。
 */
import type Database from "better-sqlite3";

import { getDb } from "../../db/index.js";

export interface CitationBlockTextRow {
  contentId: number;
  contentUtf8: string;
}

export interface CitationMessageSnapRow {
  msgId: number;
  contentJson: string;
}

export interface CitationCorpusRepo {
  /** 档① 文本，按 `content_id` **升序**（稳定序的一部分，design §4.8.4）。 */
  listBlockTexts(opts?: { limit?: number }): CitationBlockTextRow[];
  /** 档② 消息快照，按 `msg_id` **升序**。 */
  listMessageSnaps(opts?: { limit?: number }): CitationMessageSnapRow[];
}

const DEFAULT_LIMIT = 2000;

class SqliteCitationCorpusRepo implements CitationCorpusRepo {
  private blockTextsStmt: Database.Statement | null = null;
  private messageSnapsStmt: Database.Statement | null = null;

  constructor(private db: Database.Database) {}

  private prepare(name: "blocks" | "messages"): Database.Statement {
    if (name === "blocks") {
      if (!this.blockTextsStmt) {
        this.blockTextsStmt = this.db.prepare(
          "SELECT content_id, content_utf8 FROM attribution_block_text ORDER BY content_id ASC LIMIT ?",
        );
      }
      return this.blockTextsStmt;
    }
    if (!this.messageSnapsStmt) {
      this.messageSnapsStmt = this.db.prepare(
        "SELECT msg_id, content_json FROM attribution_message_snap ORDER BY msg_id ASC LIMIT ?",
      );
    }
    return this.messageSnapsStmt;
  }

  listBlockTexts(opts: { limit?: number } = {}): CitationBlockTextRow[] {
    const limit = Number.isInteger(opts.limit) && (opts.limit as number) > 0 ? (opts.limit as number) : DEFAULT_LIMIT;
    try {
      const rows = (this.prepare("blocks").all(limit) ?? []) as Array<{
        content_id: number;
        content_utf8: string;
      }>;
      return rows.map((r) => ({ contentId: Number(r.content_id), contentUtf8: String(r.content_utf8) }));
    } catch {
      return [];
    }
  }

  listMessageSnaps(opts: { limit?: number } = {}): CitationMessageSnapRow[] {
    const limit = Number.isInteger(opts.limit) && (opts.limit as number) > 0 ? (opts.limit as number) : DEFAULT_LIMIT;
    try {
      const rows = (this.prepare("messages").all(limit) ?? []) as Array<{
        msg_id: number;
        content_json: string;
      }>;
      return rows.map((r) => ({ msgId: Number(r.msg_id), contentJson: String(r.content_json) }));
    } catch {
      return [];
    }
  }
}

class NullCitationCorpusRepo implements CitationCorpusRepo {
  listBlockTexts(): CitationBlockTextRow[] {
    return [];
  }
  listMessageSnaps(): CitationMessageSnapRow[] {
    return [];
  }
}

let _repo: CitationCorpusRepo | null = null;

export function getCitationCorpusRepo(): CitationCorpusRepo {
  if (_repo) return _repo;
  const db = getDb();
  _repo = db ? new SqliteCitationCorpusRepo(db) : new NullCitationCorpusRepo();
  return _repo;
}

/** 三件套（照 F7/F9）：可注入 fake 供单测。 */
export function setCitationCorpusRepo(repo: CitationCorpusRepo): void {
  _repo = repo;
}

export function __resetCitationCorpusRepoForTests(): void {
  _repo = null;
}
