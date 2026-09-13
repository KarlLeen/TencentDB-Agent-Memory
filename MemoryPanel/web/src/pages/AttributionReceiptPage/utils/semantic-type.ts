/**
 * `144 · C1`（**单一落点**）：技术类 `asset_type` → 题目**语义类** 映射表。
 *
 * - 首次消费者 = `145` 的摘要层（每项 "语义类：用途短语"）；`144` 的展开层复用同一函数
 *   （`R3` 专钉：映射表写成两份 ⇒ 红），**不得**在两处各写一份；
 * - 现有技术类枚举（生产）= `skill / llm_wiki / code_graph / chat_memory`
 *   （见 `MemoryProxy/src/meta/client.ts` AccessibleAssetItem.asset_type 与注入侧
 *   `src/injection/types.ts` 的资产能力开关）；题目 6 个语义类**不是同一套**；
 * - **映射不到 ⇒ `other`（"其他"）**：不猜（`R2` 专钉）。题目 6 类中的
 *   `projectConvention`（项目约定）/ `failureLesson`（失败经验）在当前技术类里
 *   **没有来源** —— 保留词表位，但不会由现有数据自动产生（如实登记，见 `145`/`144` 报告）。
 */

/** 题目 6 语义类 + 兜底 `other`（顺序 = 展示/枚举顺序）。 */
export const SEMANTIC_TYPES = [
  'projectConvention',
  'historicalPlan',
  'failureLesson',
  'skill',
  'codeKnowledge',
  'productKnowledge',
  'other',
] as const;

export type SemanticType = (typeof SEMANTIC_TYPES)[number];

/** 技术类 → 语义类（**唯一定义处**；新增技术类时必须在此登记，否则落 `other`）。 */
const TECH_TO_SEMANTIC: Readonly<Record<string, SemanticType>> = {
  skill: 'skill',
  code_graph: 'codeKnowledge',
  llm_wiki: 'productKnowledge',
  chat_memory: 'historicalPlan',
};

/** 映射（纯函数；`null`/空/未知 ⇒ `other`）。 */
export function semanticTypeOf(assetType: string | null | undefined): SemanticType {
  if (typeof assetType !== 'string' || assetType.length === 0) return 'other';
  return TECH_TO_SEMANTIC[assetType] ?? 'other';
}

/** 语义类的 i18n key（`attribution.receipt.semanticType.*`；zh/en 双侧同批）。 */
export function semanticTypeKey(semanticType: SemanticType): string {
  return `attribution.receipt.semanticType.${semanticType}`;
}
