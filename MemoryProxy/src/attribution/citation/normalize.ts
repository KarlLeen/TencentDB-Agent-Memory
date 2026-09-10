/**
 * c-1 归一化（design §4.8.2）—— 三级 `match_level` + **显式映射表**。
 *
 * 三条纪律（违反即失去意义）：
 *   1. **只出比较用产物**：返回的字符串绝不入库、绝不回写。归档永远是原字节（T17 锁）。
 *   2. **判定必须能声明"我靠的是哪一级"**：`MatchLevel` 随判定结果落 `detail_json.match_level`
 *      （不改 DDL），事后可审计"某条 confirmed 是靠原字节还是靠折叠标点判的"。
 *   3. **不用 NFKC**：NFKC 连带折叠连字 / 罗马数字 / 上标 / 半全角字母数字等一大票字符，
 *      改动面**不可枚举** ⇒ 归一化本身成为漂移源。显式表可枚举、可 golden 锁；
 *      新增映射必须改表 + 刷快照（T16 的"表外字符一律不动"就是这条的断言）。
 *
 * `exact` 是默认级：P0 的字节硬比对口径。任何"顺手归一化"都必须显式写明级别。
 */

/** 三级。`exact` ⊂ `whitespace` ⊂ `punctuation`（后者在前者之上叠加）。 */
export type MatchLevel = "exact" | "whitespace" | "punctuation";

/** 全量级别（顺序 = 由弱到强；供审计/遍历用，不用于判定）。 */
export const MATCH_LEVELS: readonly MatchLevel[] = ["exact", "whitespace", "punctuation"];

/**
 * 空白折叠集合：空格 / 制表 / CR / LF / NBSP(U+00A0) / 全角空格(U+3000)。
 *
 * 语义是**折叠为单个半角空格**（只折叠、不删除）—— 删掉会让"ab c"与"a bc"撞成同一个串，
 * 那是另一种（更危险的）归一化。
 */
const WHITESPACE_RUN = /[ \t\r\n\u00a0\u3000]+/g;

/**
 * 标点显式映射表（`punctuation` 级）。
 *
 * 左列 = 全角/CJK 形；右列 = 半角 ASCII 形。每对都带注释列码点 —— 评审时按码点核，不靠肉眼辨形。
 *
 * ⚠️ 偏差记录：design §4.8.3 的表格在文档里渲染后，引号一项的左右列都退化成 ASCII（`""''`），
 * 语义上显然是「全角引号 → 半角引号」。本表按**语义**补回 curly quotes（U+201C/D、U+2018/9），
 * 并照抄文档里可辨认的「」（U+300C/D）。ASCII 引号本身**不入表**（它们已是目标形态，
 * 入表只会让 `describeMatchLevel` 报出无意义的自映射）。
 *
 * ⚠️ **不扩范围**：`、`(U+3001) / `·` / `※` / `…` 等一律**不在表内** —— 表外字符一律不动。
 */
export const PUNCTUATION_FOLD_TABLE: ReadonlyArray<readonly [string, string]> = [
  ["\uFF0C", ","], // ， U+FF0C FULLWIDTH COMMA
  ["\u3002", "."], // 。 U+3002 IDEOGRAPHIC FULL STOP
  ["\uFF1B", ";"], // ； U+FF1B FULLWIDTH SEMICOLON
  ["\uFF1A", ":"], // ： U+FF1A FULLWIDTH COLON
  ["\uFF01", "!"], // ！ U+FF01 FULLWIDTH EXCLAMATION MARK
  ["\uFF1F", "?"], // ？ U+FF1F FULLWIDTH QUESTION MARK
  ["\uFF08", "("], // （ U+FF08 FULLWIDTH LEFT PARENTHESIS
  ["\uFF09", ")"], // ） U+FF09 FULLWIDTH RIGHT PARENTHESIS
  ["\u3010", "["], // 【 U+3010 LEFT BLACK LENTICULAR BRACKET
  ["\u3011", "]"], // 】 U+3011 RIGHT BLACK LENTICULAR BRACKET
  ["\u300C", '"'], // 「 U+300C LEFT CORNER BRACKET
  ["\u300D", '"'], // 」 U+300D RIGHT CORNER BRACKET
  ["\u201C", '"'], // “ U+201C LEFT DOUBLE QUOTATION MARK（见上方偏差记录）
  ["\u201D", '"'], // ” U+201D RIGHT DOUBLE QUOTATION MARK
  ["\u2018", "'"], // ‘ U+2018 LEFT SINGLE QUOTATION MARK
  ["\u2019", "'"], // ’ U+2019 RIGHT SINGLE QUOTATION MARK
];

const PUNCTUATION_LOOKUP: ReadonlyMap<string, string> = new Map(PUNCTUATION_FOLD_TABLE);

/** 单字符折叠：表内 → 目标形；表外 → **原样**。 */
export function foldPunctuationChar(ch: string): string {
  return PUNCTUATION_LOOKUP.get(ch) ?? ch;
}

/** 逐字符（**按码点**，不是 UTF-16 码元 —— 别把增补平面字符切坏）折叠标点。 */
export function foldPunctuation(text: string): string {
  let out = "";
  for (const ch of text) out += foldPunctuationChar(ch);
  return out;
}

/** 空白折叠 + trim。 */
export function collapseWhitespace(text: string): string {
  return text.replace(WHITESPACE_RUN, " ").trim();
}

/**
 * 归一化入口。**产物只用于比较**（见文件头纪律 1）。
 *
 * - `exact`：原字节原样返回（连 trim 都不做 —— P0 字节硬比对口径）。
 * - `whitespace`：空白折叠 + trim。
 * - `punctuation`：在 `whitespace` 之上再折叠标点（顺序固定：先空白后标点，
 *   避免"折叠出的半角标点又被二次折叠"这类顺序依赖）。
 */
export function normalizeForMatch(text: string, level: MatchLevel): string {
  switch (level) {
    case "exact":
      return text;
    case "whitespace":
      return collapseWhitespace(text);
    case "punctuation":
      return foldPunctuation(collapseWhitespace(text));
    default: {
      // 穷尽性自检：新增 MatchLevel 而忘了实现 ⇒ 编译期就红。
      const never: never = level;
      return never;
    }
  }
}

/**
 * 审计用描述：这一级**做了什么**（可读的 ops 列表，供人核对"某条判定靠了什么"）。
 *
 * 故意只描述**操作**，不返回阈值/布尔 —— 基座只出度量与口径，判定属 50 spec（§1.2）。
 */
export function describeMatchLevel(level: MatchLevel): { level: MatchLevel; ops: readonly string[] } {
  switch (level) {
    case "exact":
      return { level, ops: ["identity: 原字节，不做任何改动"] };
    case "whitespace":
      return {
        level,
        ops: [
          "collapse: [ \\t\\r\\n\\u00a0\\u3000]+ → 单空格",
          "trim: 去首尾空白",
        ],
      };
    case "punctuation":
      return {
        level,
        ops: [
          "collapse: [ \\t\\r\\n\\u00a0\\u3000]+ → 单空格",
          "trim: 去首尾空白",
          `fold: 显式表 ${PUNCTUATION_FOLD_TABLE.length} 对全角/CJK 标点 → 半角（表外字符不动）`,
        ],
      };
    default: {
      const never: never = level;
      return never;
    }
  }
}
