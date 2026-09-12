/**
 * 105 · 资产级切片（**计算层**；D3 锁死：不改 DDL / 不动写侧）—— 把多资产块文本切成
 * 每资产"自己的那一段"，恢复候选间 `coverage` 区分度。
 *
 * **切片"唯一真相"**（C2）= `wrapper-registry`（与 c-2 剥离**同源**）：
 *   - 块形态 = `<available_skills>` … `</available_skills>`（core `/v3/skill/listing`
 *     **预渲染**，见 `core-client.ts:204` 逐字）；
 *   - 条目形态 = 每行 `- <name>: <description>`（`AVAILABLE_SKILL_ITEM_SOURCE`，真库
 *     `content_id=10` 实测；与 `list-prefix:available-skill-item` 模板**共用同一源常量**）。
 *
 * **对齐** = 条目序 ↔ `block_seen.asset_ids` **首见序**（索引对齐）。依据与风险（如实）：
 *   - 依据：`hits` 与 `listing` 出自 core **同一次** listing 响应（`ListingResult`），条目数
 *     应等于 hits 数（真库 12 == 12 实测）；
 *   - 风险：core 侧换序 ⇒ 切错 ⇒ 由 `sessionAssetTexts` 的"条目数不齐即回退块级" +
 *     切片必须仍是原块子串的 sanity（C5 合成夹具）兜底；
 *   - 反限制（skill-injector 注释逐字）："proxy 无 entry↔skill 字节契约" —— 本函数**只**做
 *     结构切分，**不**发明任何 name↔id 映射。
 *
 * **不适用即返回 `null`**（调用方回退块级；**绝不猜切** —— C2 红线）。
 */
import { AVAILABLE_SKILL_ITEM_SOURCE } from "./wrapper-registry.js";

const OPEN = "<available_skills>";
const CLOSE = "</available_skills>";

/**
 * 把 `<available_skills>` 块内的条目行按**出现序**切出来（原行文本，含 `- ` 前缀；
 * 供 `assetOwnText` 的 c-2 剥离对齐）。非 listing 形态 / 空块 ⇒ `null`。
 */
export function sliceAvailableSkillsItems(blockText: string): string[] | null {
  const open = blockText.indexOf(OPEN);
  const close = blockText.indexOf(CLOSE);
  if (open < 0 || close < 0 || close <= open + OPEN.length) return null;
  const inner = blockText.slice(open + OPEN.length, close);
  const re = new RegExp(AVAILABLE_SKILL_ITEM_SOURCE);
  const items: string[] = [];
  for (const line of inner.split("\n")) {
    if (re.test(line)) items.push(line);
  }
  return items.length > 0 ? items : null;
}
