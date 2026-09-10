/**
 * c-2 渲染包装剥离（design §4.8.3）—— 模板**数据集** + 可审计剥离（`removed[]`）。
 *
 * 目的：把"模型实际看到的注入文本"（P0 归档）与"资产自身正文"对齐。对齐之前必须先
 * 剥掉 handler/渲染器**拼上去的包装**（块标签、资产标记、列表前缀、接缝胶水）。
 *
 * 三条纪律（design §4.8.3，违反即返工）：
 *   1. **首稿只收录 F24 实测形态** —— 形态全部来自 render-golden 四 case 的真实渲染串与
 *      handler 源码，不凭想象扩模板。渲染器改了形态而表未同步 ⇒ T27 会红（这是有意的）。
 *   2. **剥离可审计**：`removed[{rawStart,rawEnd,templateId}]` 每段都必须由某条模板认领
 *      （模板**只负责删**，没有"顺手删"的路径）；`removed[]` 是给人核的账。
 *   3. **未知形态不猜不剥**：R8 的防过度剥离。见下方成对判定 / 上下文要求 / 白名单三条实现。
 *
 * R8（防过度剥离）在本文件的具体落点，逐条对应真实 golden 里的"像包装但不是包装"：
 *   a. **栈式成对判定**：只有成对的 `<name>` … `</name>` 才剥。case 2 里 `<l3_core_memory>`
 *      出现 2 次而 `</l3_core_memory>` 只有 1 次（第二次出现在 memory-tools-guide 的**正文散文**里）——
 *      按"全局计数相等"判会**整组拒剥**，按"就近成对"判则只剥真正成对的那一对。
 *   b. **列表前缀要有块上下文**：`1. [episodic] [self score=0.900] ` 这种形状太普通，
 *      只在已进入 `tdai_recalled_l1_memories` 块内才剥 ⇒ 资产正文首行写 `1. something` 原样保留。
 *   c. **缝胶只认文本边界**：仅剥"文首/文末紧贴已剥标签"的 SEAM_GLUE。文档中间的 `\n\n`
 *      无法证明是 handler 加的（可能是正文排版）⇒ **宁留不误删**。
 *   d. **不认识的标签一律不动**：case 1 正文里的 `<url>` / `<Step1返回的name>`、
 *      case 2 里的 `<tdai_memory_tools>`（在反引号散文里）/ `<bridge>` / `<sid>`、
 *      case 4 里散文提到的 `<skill_tools>`（无反引号外的成对闭合）都**原样保留**。
 *
 * ⚠️ 剥离产物**只用于比较**，绝不入库、绝不回写（与 c-1 同纪律；T17 锁）。
 */
import { SEAM_GLUE } from "./visible-text.js";

export type WrapperKind = "block-tag" | "marker-tag" | "list-prefix" | "seam-glue";

export interface WrapperTemplate {
  /** 审计账里的标签（`removed[].templateId`）。命名含形态与对象，便于人工核对。 */
  templateId: string;
  kind: WrapperKind;
  /** 人类可读的"这条模板认领什么形态、为什么收它"。 */
  describe: string;
  /** 复核谓词：`text.slice(rawStart, rawEnd)` 是否确为本模板的一个实例（T18 用）。 */
  claims(raw: string): boolean;
}

export interface WrapperRegistry {
  readonly templates: readonly WrapperTemplate[];
}

export interface RemovedSpan {
  rawStart: number;
  rawEnd: number;
  templateId: string;
}

export interface StripResult {
  /** 剥掉包装后的文本（= 档案正文 + 未识别形态原样）。 */
  text: string;
  /** 账：每一段被删字节的位置与认领模板。空数组 = 一个包装都没识别到。 */
  removed: RemovedSpan[];
}

// ── 块标签规格（F24：render-golden 四 case 实测出现）──────────────────────────────
//
// 来源逐个可溯：
//   knowledge_tools / tdai_profile_memory / memory-tools-guide /
//   tdai_recalled_l1_memories / l3_core_memory / l2_scene_index — render-golden.snap.json 实测
//   agent（嵌套，带 name/role/agent_id 属性）                    — 同上（profile case）
//   skill_tools                                                 — s4 smoke B1/B2 实测（block 形态）
interface TagSpec {
  name: string;
  /** 开标签正则源（**不带 flag**，扫描时补 g）。 */
  openSource: string;
  closeSource: string;
  describe: string;
}

const BLOCK_TAG_SPECS: readonly TagSpec[] = [
  {
    name: "knowledge_tools",
    openSource: "<knowledge_tools>",
    closeSource: "</knowledge_tools>",
    describe: "知识库块标签（knowledge injector 渲染；render-golden knowledge case 实测）",
  },
  {
    name: "tdai_profile_memory",
    openSource: "<tdai_profile_memory>",
    closeSource: "</tdai_profile_memory>",
    describe: "长期工作记忆块标签（render-golden profile case 实测）",
  },
  {
    name: "memory-tools-guide",
    openSource: "<memory-tools-guide>",
    closeSource: "</memory-tools-guide>",
    describe: "记忆工具用法块标签（render-golden profile case 实测）",
  },
  {
    name: "tdai_recalled_l1_memories",
    openSource: "<tdai_recalled_l1_memories>",
    closeSource: "</tdai_recalled_l1_memories>",
    describe: "L1 召回记忆块标签（render-golden l1 case 实测；其内部条目前缀另有 list-prefix 模板）",
  },
  {
    name: "l3_core_memory",
    openSource: "<l3_core_memory>",
    closeSource: "</l3_core_memory>",
    describe: "L3 核心记忆段标签（render-golden profile case 实测）",
  },
  {
    name: "l2_scene_index",
    openSource: "<l2_scene_index>",
    closeSource: "</l2_scene_index>",
    describe: "L2 场景索引段标签（render-golden profile case 实测）",
  },
  {
    name: "agent",
    openSource: "<agent\\b[^>]*>",
    closeSource: "</agent\\s*>",
    describe: "分段/借入归属标签（**带属性**：name/role/agent_id；render-golden profile case 实测）",
  },
  {
    name: "skill_tools",
    openSource: "<skill_tools>",
    closeSource: "</skill_tools>",
    describe: "skill 列表块标签（s4 smoke B1/B2 实测）",
  },
];

/** 自闭合资产标记（`<knowledge … />`）。**要求含 `type=` 与 `id=`**，否则不认（R8-d）。 */
const MARKER_KNOWLEDGE_SOURCE = "<knowledge\\b[^>]*\\/>";
const MARKER_KNOWLEDGE_REQUIRED_ATTRS = [/\btype\s*=/, /\bid\s*=/];

const MARKER_SPECS: ReadonlyArray<{ templateId: string; source: string; describe: string }> = [
  {
    templateId: "marker-tag:knowledge-self-closing",
    source: MARKER_KNOWLEDGE_SOURCE,
    describe:
      "自闭合知识资产标记 `<knowledge type=… id=… url=… name=… about=… />`（render-golden knowledge case 实测；" +
      "要求同时出现 type= 与 id= 属性 —— 光有 <knowledge 形状不算，防正文散文误命中）",
  },
];

// ── 列表前缀规格 ────────────────────────────────────────────────────────────────

/**
 * L1 记忆条目前缀（render-golden l1 case 实测三态）：
 *   `1. [episodic] [self score=0.900] `
 *   `2. [semantic] [self score=0.800] `
 *   `3. [memory] [from Bob score=0.500] `
 * 行首锚定 + **要求块上下文**（见 R8-b）。
 */
const L1_ITEM_PREFIX_SOURCE =
  "^\\d+\\. \\[(?:episodic|semantic|memory)\\] \\[(?:self|from [^\\]\\n]+) score=[\\d.]+\\] ";
const L1_ITEM_CONTEXT_BLOCK = "tdai_recalled_l1_memories";

/** skill listing 段首标题（render-golden skill case 首行实测：`## Skills (mandatory)\n`）。 */
const SKILLS_HEADING_SOURCE = "^## Skills \\(mandatory\\)\\n";

// ── 构造 registry ──────────────────────────────────────────────────────────────

function compileNoFlags(source: string): RegExp {
  return new RegExp(source);
}

const templates: WrapperTemplate[] = [];

for (const spec of BLOCK_TAG_SPECS) {
  templates.push({
    templateId: `block-tag:${spec.name}`,
    kind: "block-tag",
    describe: `${spec.describe}（成对时才剥；单边出现一律原样保留 —— R8-a/R8-d）`,
    // 审计用：raw 必须**整段**是开标签或闭标签（不是"含一下"）
    claims: (raw) =>
      new RegExp(`^(?:${spec.openSource})$`).test(raw) ||
      new RegExp(`^(?:${spec.closeSource})$`).test(raw),
  });
}

for (const spec of MARKER_SPECS) {
  templates.push({
    templateId: spec.templateId,
    kind: "marker-tag",
    describe: spec.describe,
    claims: (raw) =>
      new RegExp(`^(?:${spec.source})$`).test(raw) &&
      MARKER_KNOWLEDGE_REQUIRED_ATTRS.every((re) => re.test(raw)),
  });
}

templates.push({
  templateId: "list-prefix:l1-memory-item",
  kind: "list-prefix",
  describe:
    "L1 记忆条目前缀 `N. [episodic|semantic|memory] [self|from <who> score=…] `（render-golden l1 case 实测；" +
    "**只在 tdai_recalled_l1_memories 块内生效**，防正文首行 `1. something` 被误吃 —— R8-b）",
  claims: (raw) => compileNoFlags(L1_ITEM_PREFIX_SOURCE).test(raw),
});

templates.push({
  templateId: "list-prefix:skills-heading",
  kind: "list-prefix",
  describe:
    "skill listing 段首标题 `## Skills (mandatory)\\n`（render-golden skill case 首行实测；" +
    "**只认文首或块标签上下文内** —— R8-b）",
  claims: (raw) => compileNoFlags(SKILLS_HEADING_SOURCE).test(raw),
});

templates.push({
  templateId: "seam-glue:leading",
  kind: "seam-glue",
  describe:
    "文首接缝胶水：紧贴第一个**最外层**块标签之前的 `SEAM_GLUE`（= `\\n\\n`，唯一来源 " +
    "visible-text.ts；handler 把被排除前缀与归档块拼在一起时插入）",
  claims: (raw) => raw === SEAM_GLUE,
});

templates.push({
  templateId: "seam-glue:trailing",
  kind: "seam-glue",
  describe: "文末接缝胶水：紧贴最后一个**最外层**块标签之后的 `SEAM_GLUE`",
  claims: (raw) => raw === SEAM_GLUE,
});

/** 唯一内置表（首稿 = F24 实测形态；扩表必须同步 T27 的 golden 覆盖断言）。 */
export const DEFAULT_WRAPPER_REGISTRY: WrapperRegistry = { templates };

// ── 剥离实现 ───────────────────────────────────────────────────────────────────

interface Token {
  name: string;
  open: boolean;
  start: number;
  end: number;
}

function scanTokens(text: string, source: string, name: string, open: boolean): Token[] {
  const re = new RegExp(source, "g");
  const out: Token[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1; // 防零宽匹配死循环
      continue;
    }
    out.push({ name, open, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

interface Pair {
  name: string;
  openStart: number;
  openEnd: number;
  closeStart: number;
  closeEnd: number;
}

/** 栈式就近成对（R8-a）：同名开/闭标签按文档序配对，落单的任一边永不剥。 */
function pairUp(tokens: readonly Token[]): { pairs: Pair[]; unpaired: Token[] } {
  const pairs: Pair[] = [];
  const unpaired: Token[] = [];
  const stacks = new Map<string, Token[]>();

  for (const token of tokens) {
    const stack = stacks.get(token.name) ?? [];
    if (token.open) {
      stack.push(token);
      stacks.set(token.name, stack);
      continue;
    }
    const openToken = stack.pop();
    stacks.set(token.name, stack);
    if (!openToken) {
      unpaired.push(token); // 只有闭：正文里的字面量 ⇒ 保留（R8-c/d）
      continue;
    }
    pairs.push({
      name: token.name,
      openStart: openToken.start,
      openEnd: openToken.end,
      closeStart: token.start,
      closeEnd: token.end,
    });
  }
  for (const stack of stacks.values()) unpaired.push(...stack); // 只有开：同上

  pairs.sort((a, b) => a.openStart - b.openStart);
  unpaired.sort((a, b) => a.start - b.start);
  return { pairs, unpaired };
}

function isOutermost(pair: Pair, pairs: readonly Pair[]): boolean {
  return !pairs.some(
    (other) => other !== pair && other.openStart <= pair.openStart && other.closeEnd >= pair.closeEnd,
  );
}

/**
 * 剥离渲染包装。
 *
 * 单遍、基于**原文本偏移**（不对已改动的串再跑正则 —— 那会让 `removed[]` 的偏移失真，
 * 审计账就废了）。收集 → 排序 → 去重叠 → 一次拼接。
 *
 * 幂等：剥完的串里不再有成对标签 / 前缀 / 边界胶水 ⇒ 第二次调用 `removed` 为空。
 */
export function stripRenderWrappers(text: string, registry: WrapperRegistry = DEFAULT_WRAPPER_REGISTRY): StripResult {
  if (text.length === 0) return { text, removed: [] };

  const spans: RemovedSpan[] = [];

  // 1) 块标签（栈式成对）
  const allTokens: Token[] = [];
  for (const spec of BLOCK_TAG_SPECS) {
    allTokens.push(...scanTokens(text, spec.openSource, spec.name, true));
    allTokens.push(...scanTokens(text, spec.closeSource, spec.name, false));
  }
  allTokens.sort((a, b) => a.start - b.start);
  const { pairs } = pairUp(allTokens);

  const contexts: Array<{ start: number; end: number }> = [];
  for (const pair of pairs) {
    spans.push({
      rawStart: pair.openStart,
      rawEnd: pair.openEnd,
      templateId: `block-tag:${pair.name}`,
    });
    spans.push({
      rawStart: pair.closeStart,
      rawEnd: pair.closeEnd,
      templateId: `block-tag:${pair.name}`,
    });
    contexts.push({ start: pair.openEnd, end: pair.closeStart });
  }

  // 2) 资产标记（自闭合）
  for (const spec of MARKER_SPECS) {
    const re = new RegExp(spec.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      if (!MARKER_KNOWLEDGE_REQUIRED_ATTRS.every((attr) => attr.test(m![0]))) continue;
      spans.push({ rawStart: m.index, rawEnd: m.index + m[0].length, templateId: spec.templateId });
    }
  }

  // 3) 列表前缀（块上下文 / 文首）
  const inContext = (offset: number): boolean => contexts.some((c) => offset >= c.start && offset < c.end);

  const l1Re = new RegExp(L1_ITEM_PREFIX_SOURCE, "gm");
  let lm: RegExpExecArray | null;
  while ((lm = l1Re.exec(text)) !== null) {
    if (lm[0].length === 0) {
      l1Re.lastIndex += 1;
      continue;
    }
    const l1ContextPairs = pairs.filter((p) => p.name === L1_ITEM_CONTEXT_BLOCK);
    const inL1 = l1ContextPairs.some((p) => lm!.index > p.openEnd && lm!.index < p.closeStart);
    if (!inL1) continue; // 没在 L1 块内 ⇒ 不剥（R8-b）
    spans.push({ rawStart: lm.index, rawEnd: lm.index + lm[0].length, templateId: "list-prefix:l1-memory-item" });
  }

  const headingRe = new RegExp(SKILLS_HEADING_SOURCE, "gm");
  let hm: RegExpExecArray | null;
  while ((hm = headingRe.exec(text)) !== null) {
    if (hm[0].length === 0) {
      headingRe.lastIndex += 1;
      continue;
    }
    const atStart = hm.index === 0;
    if (!(atStart || inContext(hm.index))) continue;
    spans.push({ rawStart: hm.index, rawEnd: hm.index + hm[0].length, templateId: "list-prefix:skills-heading" });
  }

  // 4) 接缝胶水（**只认第一个/最后一个最外层标签处的那一处**，见 R8-c）
  //
  // 为什么要这么窄：输入是"模型实际看到的一段文本"，本函数无法区分
  //   (i) handler 在【被排除的不归档前缀】与【第一个归档块】之间插的胶水（该剥），
  //   (ii) 归档块**自身正文内部**两个子块之间的 `\n\n`（**不该剥** —— 那属于资产正文，
  //        剥了就等于改动归档内容，与"对齐"目的背道而驰）。
  // 二者文本形状完全一样。可判定的只有位置：只剥**最外层**首/末标签处的那一处，
  // 且至多一处。case 2 的 `</tdai_profile_memory>\n\n<memory-tools-guide>` 属 (ii)：
  // 第一个最外层开标签在 offset 0（其前无内容）⇒ 不触发，中间的 `\n\n` 原样保留。
  const outermost = pairs.filter((p) => isOutermost(p, pairs));
  if (outermost.length > 0) {
    const first = outermost.reduce((a, b) => (a.openStart <= b.openStart ? a : b));
    const glueStart = first.openStart - SEAM_GLUE.length;
    if (glueStart > 0 && text.startsWith(SEAM_GLUE, glueStart)) {
      spans.push({ rawStart: glueStart, rawEnd: first.openStart, templateId: "seam-glue:leading" });
    }
    const last = outermost.reduce((a, b) => (a.closeEnd >= b.closeEnd ? a : b));
    if (last.closeEnd === text.length - SEAM_GLUE.length && text.endsWith(SEAM_GLUE)) {
      spans.push({
        rawStart: text.length - SEAM_GLUE.length,
        rawEnd: text.length,
        templateId: "seam-glue:trailing",
      });
    }
  }

  // 5) 排序 + 去重叠（保留先到者；重叠一律不可能来自同一条模板的两次匹配）
  //    + 审计硬约束：每一段被删字节都必须由**传入表内**的某条模板认领
  //    （表里没有 / 认领谓词不成立 ⇒ 丢弃，宁留不误删）。这道闸让 `removed[]` 不是"记账"
  //    而是**真实约束**：没有"顺手删"的路径，T18 断言的正是这条。
  const ordered = [...spans].sort((a, b) => a.rawStart - b.rawStart || a.rawEnd - b.rawEnd);
  const byTemplateId = new Map(registry.templates.map((t) => [t.templateId, t]));
  const removed: RemovedSpan[] = [];
  let cursor = -1;
  for (const span of ordered) {
    if (span.rawStart < cursor) continue; // 重叠 ⇒ 丢弃（宁可少删）
    if (span.rawEnd <= span.rawStart) continue;
    const template = byTemplateId.get(span.templateId);
    if (!template) continue; // 表外模板 ⇒ 不认领 ⇒ 不剥
    if (!template.claims(text.slice(span.rawStart, span.rawEnd))) continue; // 认领不成立 ⇒ 不剥
    removed.push(span);
    cursor = span.rawEnd;
  }

  let out = "";
  let prev = 0;
  for (const span of removed) {
    out += text.slice(prev, span.rawStart);
    prev = span.rawEnd;
  }
  out += text.slice(prev);

  return { text: out, removed };
}
