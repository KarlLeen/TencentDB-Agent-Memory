/**
 * c-4 排他性检查的**输入源**（design §4.8.5）—— 取数，**不判定**。
 *
 * 边界（这是本模块存在的全部意义）：
 *   - **只读**：全路径零写 —— 不 upsert、不动水位、不建表（T25 用"写计数全 0 +
 *     水位行不变"锁）；只 SELECT。
 *   - **不判定**：`sessionAssetTexts` 只给"同会话各资产的可见文本集合"；
 *     "引文同时也出现在别的资产里 ⇒ 不算排他"这一步属 50 spec，基座不碰。
 *   - 基座只到"把判定需要的原料摆齐"为止。
 *
 * 数据来源（全部沿用 P0 已落地的事实，不新造口径）：
 *   - `sessionWindow` → `windowVisibleText`（F25：档①+档② 按 (turn_seq, tier, seq) 拼接）；
 *   - `sessionAssetTexts` → 档① occurrence 的 `asset_ids`（F26：`[{assetId, assetType}]` JSON）
 *     ⋈ `attribution_block_text.content_utf8`。**不 JOIN 档②消息** —— 消息面没有资产身份，
 *     硬凑只能猜，猜就是自造漂移源；
 *   - `rarityTable` → 档① `content_utf8` ∪ 档② `content_json` 的**文本投影**
 *     （档②投影复用生产侧 `messageTextFingerprint` 口径，F32；不新造另一套）。
 */
import type { VisibleTextRepo, VisibleWindow, VisibleWindowReadOpts } from "../../db/visibleTextRepo.js";
import { getVisibleTextRepo, windowVisibleText } from "../../db/visibleTextRepo.js";
import { messageTextFingerprint } from "../../decision-units/message-increment-archive.js";
import type { CitationCorpusRepo } from "./corpus-repo.js";
import { getCitationCorpusRepo } from "./corpus-repo.js";
import type { RarityTable } from "./ngram.js";
import { buildRarityTable } from "./ngram.js";

/** 每档语料条数上限（design §4.8.4：blocks 2000 / messages 2000，**各自独立**）。 */
export const DEFAULT_BLOCK_CORPUS_LIMIT = 2000;
export const DEFAULT_MESSAGE_CORPUS_LIMIT = 2000;

export interface CitationSourceProvider {
  /** 只读，复用 P0 §5 API（F25）。 */
  sessionWindow(sessionKey: string, opts?: VisibleWindowReadOpts): VisibleWindow;
  /** assetId → 该资产在**同一会话**的可见文本片段（去重后，首次出现序）。 */
  sessionAssetTexts(sessionKey: string): Map<string, string[]>;
  /** 懒构建 + 进程内缓存（key = `tableSha256`）。 */
  rarityTable(): RarityTable;
  /** excluded 类别（= EXCLUDED_CATEGORIES，常量；59 落点，见 50 spec §14 C5）。 */
  excludedCategories(): readonly string[];
}

/**
 * 59 · excluded 类别常量（40 spec §3a 两类；A5 改判 = 类别常量，不做逐条枚举）。
 * 语义：这两类字节**不属本代理注入面** ⇒ 归因完整性对账时从"注入面"里排除。
 */
export const EXCLUDED_CATEGORY_CLIENT_SYSTEM = "client-system"; // body.system 既有项（客户端自带 system）
export const EXCLUDED_CATEGORY_USER_ORIGINAL = "user-original"; // 非注入用户文本（用户原语）
export const EXCLUDED_CATEGORIES: readonly string[] = [
  EXCLUDED_CATEGORY_CLIENT_SYSTEM,
  EXCLUDED_CATEGORY_USER_ORIGINAL,
];

export interface ArchiveCitationSourceOptions {
  /** 语料读口（缺省走 `getCitationCorpusRepo()`）；测试注入 fake 语料。 */
  corpusRepo?: CitationCorpusRepo;
  blockCorpusLimit?: number;
  messageCorpusLimit?: number;
}

interface AssetIdEntry {
  assetId?: unknown;
  assetType?: unknown;
}

/** `asset_ids` JSON → assetId 列表（畸形/非数组 → 空，绝不 throw）。 */
function assetIdsOf(assetIdsJson: string | null): string[] {
  if (!assetIdsJson) return [];
  try {
    const parsed: unknown = JSON.parse(assetIdsJson);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const entry of parsed) {
      const assetId = (entry as AssetIdEntry | null)?.assetId;
      if (typeof assetId === "string" && assetId.length > 0) out.push(assetId);
    }
    return out;
  } catch {
    return [];
  }
}

/** `content_json` → 可见文本；解析失败按空串（口径同 `messageTextFingerprint`，绝不 throw）。 */
function messageVisibleText(contentJson: string): string {
  try {
    return messageTextFingerprint(JSON.parse(contentJson));
  } catch {
    return "";
  }
}

/** 进程内表缓存：key = tableSha256（同语料 ⇒ 同一张表对象，验证"表可复现"）。 */
const rarityTableCache = new Map<string, RarityTable>();

export function archiveCitationSource(
  repo: VisibleTextRepo,
  opts: ArchiveCitationSourceOptions = {},
): CitationSourceProvider {
  const blockLimit =
    Number.isInteger(opts.blockCorpusLimit) && (opts.blockCorpusLimit as number) > 0
      ? (opts.blockCorpusLimit as number)
      : DEFAULT_BLOCK_CORPUS_LIMIT;
  const messageLimit =
    Number.isInteger(opts.messageCorpusLimit) && (opts.messageCorpusLimit as number) > 0
      ? (opts.messageCorpusLimit as number)
      : DEFAULT_MESSAGE_CORPUS_LIMIT;

  let cachedTable: RarityTable | null = null;

  return {
    sessionWindow(sessionKey: string, windowOpts?: VisibleWindowReadOpts): VisibleWindow {
      return windowVisibleText(repo, sessionKey, windowOpts);
    },

    sessionAssetTexts(sessionKey: string): Map<string, string[]> {
      const out = new Map<string, string[]>();
      // 只读档①：occurrence ⋈ block_text（repo.listBlockSeen 已 JOIN 好）。
      const rows = repo.listBlockSeen(sessionKey);
      const seenContent = new Map<string, Set<number>>();
      for (const row of rows) {
        const assetIds = assetIdsOf(row.asset_ids);
        if (assetIds.length === 0) continue;
        for (const assetId of assetIds) {
          let contents = seenContent.get(assetId);
          if (!contents) {
            contents = new Set<number>();
            seenContent.set(assetId, contents);
          }
          // content_hash 全局唯一（F29）⇒ 按 content_id 去重即可，无需比字符串。
          if (contents.has(row.content_id)) continue;
          contents.add(row.content_id);
          const list = out.get(assetId) ?? [];
          list.push(row.content_utf8);
          out.set(assetId, list);
        }
      }
      return out;
    },

    rarityTable(): RarityTable {
      if (cachedTable) return cachedTable;
      const corpusRepo = opts.corpusRepo ?? getCitationCorpusRepo();
      const blockRows = corpusRepo.listBlockTexts({ limit: blockLimit });
      const messageRows = corpusRepo.listMessageSnaps({ limit: messageLimit });
      const corpus = [
        ...blockRows.map((r) => r.contentUtf8),
        ...messageRows.map((r) => messageVisibleText(r.contentJson)),
      ];
      const table = buildRarityTable(corpus, {
        // 兜底安全阀取总数：per-source 的 2000 已由 SQL LIMIT 把关，这里不能再截。
        cap: Math.max(1, corpus.length),
        rows: {
          blocks: blockRows.length,
          messages: messageRows.length,
          // cap 是 per-source 的 ⇒ 只有 c-4 知道是否真被截。
          capped: blockRows.length >= blockLimit || messageRows.length >= messageLimit,
        },
      });
      const hit = rarityTableCache.get(table.tableSha256);
      cachedTable = hit ?? table;
      rarityTableCache.set(table.tableSha256, cachedTable);
      return cachedTable;
    },

    excludedCategories(): readonly string[] {
      // 59 · 50 spec §14 C5 落点：40 spec §3a 两类常量（缺口消除；类别只作对账声明，不进判定）。
      return EXCLUDED_CATEGORIES;
    },
  };
}

let _provider: CitationSourceProvider | null = null;

export function getCitationSourceProvider(): CitationSourceProvider {
  if (_provider) return _provider;
  _provider = archiveCitationSource(getVisibleTextRepo());
  return _provider;
}

/** 三件套（照 F7/F9）：可注入 fake provider 供单测。 */
export function setCitationSourceProvider(provider: CitationSourceProvider): void {
  _provider = provider;
}

export function __resetCitationSourceProviderForTests(): void {
  _provider = null;
  rarityTableCache.clear();
}
