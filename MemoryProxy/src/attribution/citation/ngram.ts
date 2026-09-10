/**
 * c-3 区分性 char n-gram + 稀有度查表（design §4.8.4）。
 *
 * 目的：给"引文是不是这段记忆特有的措辞"提供一个**可复现的度量**。
 *
 * 三条纪律：
 *   1. **只出度量、不出阈值/布尔**：`gramCoverage` 返回覆盖率数字，**不返回**"是否命中"；
 *      `minIdf` / `topK` 只是过滤参数。"覆盖率多少算过"属 50 spec（§1.2）。
 *   2. **表必须可复现**：`tableSha256` = sha256(n + corpusRows + 排序后的 gram|df 列表)
 *      ⇒ 语料**打乱顺序**结果不变（df 是集合语义、输出列表按 gram 升序），golden 可锁。
 *      换 `n` 必换 sha（n 进了哈希）。
 *   3. **无依据就说无依据**：空语料（`docCount=0`）下 idf / coverage 一律取
 *      `Number.NaN` **哨兵** —— 既不是 0（"完全不覆盖"）也不是 1（"全覆盖"）。
 *      基座不抛（F1 降级纪律），由调用方走"无表"分支。
 *
 * 为什么是 char n-gram 而不是分词：仓内无分词器，中文按**字**切更稳（不引入词典依赖），
 * `n=4` 对中文短语的区分度够用；且这个 n 是哈希的一部分，改它就是换表。
 *
 * ⚠️ 产物只用于比较，绝不入库、绝不回写（与 c-1/c-2 同纪律）。
 */
import { createHash } from "node:crypto";

/** 默认阶数（CJK 友好）。 */
export const DEFAULT_NGRAM_N = 4;
/** 默认语料条数上限（design §4.8.4：blocks 2000 / messages 2000）。 */
export const DEFAULT_CORPUS_CAP = 2000;

export interface RarityTable {
  /** 阶数（参与 sha256）。 */
  n: number;
  /** 文档数（文档 = 一条归档行）。 */
  docCount: number;
  /** gram → 文档频次。 */
  df: ReadonlyMap<string, number>;
  /** 表指纹：`sha256(n + corpusRows + 排序后的 gram|df 列表)`。 */
  tableSha256: string;
  /** 语料出处计数 + 是否触发 cap（cap 触发 ⇒ "打乱顺序不改表"不再成立，见文件头）。 */
  corpusRows: { blocks: number; messages: number; capped: boolean };
}

export interface BuildRarityTableOptions {
  n?: number;
  /** 从**已按稳定序**给出的语料里最多取多少条（超出部分丢弃，`capped=true`）。 */
  cap?: number;
  /**
   * 语料出处覆盖（缺省 `{blocks: docCount, messages: 0}`）。c-4 按 per-source cap 选好后传入。
   *
   * `capped` 可显式覆盖：c-4 的 cap 是**按档位各自 2000**（SQL LIMIT），合并后的总数可能
   * 超过 2000 —— 此时本函数的 `cap` 只是兜底安全阀（c-4 传 total），真正的"是否被截"只有
   * c-4 知道，所以由它上报。
   */
  rows?: { blocks: number; messages: number; capped?: boolean };
}

/**
 * 取 char n-gram（去重、保序 —— 保序是为了 `distinctiveGrams` 的结果只由 idf 决定，
 * 不引入集合迭代序这第四个变量）。
 */
export function charNgrams(text: string, n: number): string[] {
  const order = Math.trunc(n);
  if (order <= 0) return [];
  const chars = [...text]; // 按码点切，不切坏增补平面字符
  if (chars.length < order) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i + order <= chars.length; i += 1) {
    const gram = chars.slice(i, i + order).join("");
    if (seen.has(gram)) continue;
    seen.add(gram);
    out.push(gram);
  }
  return out;
}

/** 阶数 n 的去重 gram 集合（不给顺序语义，供集合运算）。 */
export function charNgramSet(text: string, n: number): Set<string> {
  return new Set(charNgrams(text, n));
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * 构建稀有度表。语料**由调用方按稳定序给出**（c-4 用 content_id/msg_id 升序），
 * 本函数只做"取前 cap 条 + 数文档频次 + 算 sha"。
 *
 * `buildRarityTable([])` 合法：`docCount=0`、`df` 空、idf/coverage 走哨兵，**不抛**。
 */
export function buildRarityTable(
  corpus: Iterable<string>,
  opts: BuildRarityTableOptions = {},
): RarityTable {
  const n = Number.isInteger(opts.n) && (opts.n as number) > 0 ? (opts.n as number) : DEFAULT_NGRAM_N;
  const cap = Number.isInteger(opts.cap) && (opts.cap as number) > 0 ? (opts.cap as number) : DEFAULT_CORPUS_CAP;

  const supplied: string[] = [];
  for (const row of corpus) {
    supplied.push(row);
    if (supplied.length > cap) break; // 早停：语料可能很大
  }
  const capped = supplied.length > cap;
  const docs = capped ? supplied.slice(0, cap) : supplied;

  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const gram of charNgramSet(doc, n)) {
      df.set(gram, (df.get(gram) ?? 0) + 1);
    }
  }

  const docCount = docs.length;
  const corpusRows = {
    blocks: opts.rows?.blocks ?? docCount,
    messages: opts.rows?.messages ?? 0,
    capped: opts.rows?.capped ?? capped,
  };

  // 稳定序：gram 升序（code unit 序，与 locale 无关 ⇒ 跨机器一致）。
  const gramList = [...df.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const tableSha256 = sha256Hex(
    [
      `n=${n}`,
      `blocks=${corpusRows.blocks}`,
      `messages=${corpusRows.messages}`,
      `capped=${corpusRows.capped}`,
      `docCount=${docCount}`,
      ...gramList.map((gram) => `${gram}:${df.get(gram)}`),
    ].join("\n"),
  );

  return { n, docCount, df, tableSha256, corpusRows };
}

/** idf 哨兵：`docCount === 0` ⇒ 无任何统计依据（不是"无限稀有"）。 */
export const IDF_NO_BASIS = Number.NaN;

/**
 * 查单个 gram 的稀有度。**只出数字**。
 *
 * `idf = ln((docCount + 1) / (df + 1))`（加一平滑：`df=0` 的 gram 在非空语料里也有有限大值，
 * 不会炸成 Infinity）；`docCount === 0` ⇒ 哨兵 NaN。
 */
export function rarity(table: RarityTable, gram: string): { df: number; idf: number } {
  const df = table.df.get(gram) ?? 0;
  if (table.docCount === 0) return { df, idf: IDF_NO_BASIS };
  return { df, idf: Math.log((table.docCount + 1) / (df + 1)) };
}

/**
 * 取 `text` 里 idf 最高的 `topK` 个 gram（**只出度量**）。
 *
 * 排序：idf **降序**，同 idf 按 gram **升序** —— 全序、可复现（T21 锁）。
 * 空表 / 无 gram ⇒ `[]`（不是抛，也不是假装有结果）。
 */
export function distinctiveGrams(
  text: string,
  table: RarityTable,
  opts: { topK?: number } = {},
): Array<{ gram: string; idf: number }> {
  const topK = Number.isInteger(opts.topK) && (opts.topK as number) > 0 ? (opts.topK as number) : 50;
  const grams = charNgrams(text, table.n);
  const scored = grams
    .map((gram) => ({ gram, ...rarity(table, gram) }))
    .filter((entry) => Number.isFinite(entry.idf));
  scored.sort((a, b) => (b.idf - a.idf) || (a.gram < b.gram ? -1 : a.gram > b.gram ? 1 : 0));
  return scored.slice(0, topK).map(({ gram, idf }) => ({ gram, idf }));
}

/** coverage 哨兵：无判定依据（空语料 / 引文过短到没有 n-gram）。 */
export const COVERAGE_NO_BASIS = Number.NaN;

/** 是否需要走"无表"分支（调用方用它代替 `coverage === 0` 之类的误判）。 */
export function isCoverageKnown(coverage: number): boolean {
  return Number.isFinite(coverage);
}

/**
 * 引文在窗口文本里的 n-gram 覆盖率（**只出数字，不判定**）。
 *
 * 定义：
 *   - `distinct` = 引文中 **idf ≥ minIdf** 的去重 gram 数；
 *   - `covered`  = 这些 gram 中**出现在窗口文本里**的个数；
 *   - `coverage` = `covered / distinct`（0 ≤ x ≤ 1）；
 *   - `n`        = 所用阶数（= `table.n`，随读数一起给，便于审计复算）。
 *
 * 哨兵（`COVERAGE_NO_BASIS` = NaN）：三种"分母不可用"的情况 ——
 *   1. `docCount === 0`（无表可用）；
 *   2. 引文过短到没有 n-gram（`quoteGrams.length === 0`）；
 *   3. 引文的 gram 全被 `minIdf` 过滤掉（过滤太严，不是"不覆盖"）。
 *
 * ⚠️ 与两种**合法 0** 严格区分（T22/T24 锁这条边界）：
 *   - 引文有 gram、有 gram 过筛，但一个都没进窗口 ⇒ `coverage = 0`（合法 0，是真实结论）。
 *   - "无依据"永远是 NaN，绝不写成 0（会被读成"确认不覆盖"）或 1（会被读成"完全覆盖"）。
 *
 * `minIdf` 是**调用方**的过滤参数（缺省 0 = 不过滤）。"覆盖率多少算过"属 50 spec。
 */
export function gramCoverage(
  windowText: string,
  quote: string,
  table: RarityTable,
  opts: { minIdf?: number } = {},
): { coverage: number; distinct: number; covered: number; n: number } {
  const minIdf = Number.isFinite(opts.minIdf) ? (opts.minIdf as number) : 0;
  const n = table.n;

  const quoteGrams = charNgrams(quote, n);
  if (table.docCount === 0 || quoteGrams.length === 0) {
    return { coverage: COVERAGE_NO_BASIS, distinct: 0, covered: 0, n };
  }

  const windowGrams = charNgramSet(windowText, n);
  let distinct = 0;
  let covered = 0;
  for (const gram of quoteGrams) {
    const { idf } = rarity(table, gram);
    if (!Number.isFinite(idf) || idf < minIdf) continue;
    distinct += 1;
    if (windowGrams.has(gram)) covered += 1;
  }

  if (distinct === 0) return { coverage: COVERAGE_NO_BASIS, distinct: 0, covered: 0, n };
  return { coverage: covered / distinct, distinct, covered, n };
}
