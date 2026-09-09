/**
 * S3 决策单元词表与命令匹配器（docs/implementation/30-decision-unit-extractor.md
 * §4.3–4.4）。常量清单 v1 固定，重排序/加词即换单位身份，须谨慎 ——
 * 判定语义留 v2（§9 开放问题 2 的 risky 词表动态化）。
 *
 * 匹配面分两路：
 *   - `KEY_TOOL_MATCHERS`：key_tool_call 候选面 —— 人类/工具里出现的命令形内容；
 *   - `RISKY_HUMAN_SEEDS`：restraint 口语触发面（口语种子）；
 *   - `RISKY_KEY_TOOL_MATCHERS` = KEY_TOOL_MATCHERS 中 risky:true 子集 —— restraint
 *     的"命令形"触发面与 B3"链内已执行"判定都只认这组。
 *
 * 匹配纪律（2026-09-08 二轮评审收编 N1/N2）：matcher 的 `test(text)` 是纯文本测试，
 * text 只会来自两个面 —— ① 工具侧 = `commandSurfaceTextOf` 产出的**解码后命令串**
 * （工具名/命令字段门控，见下；绝不在 JSON.stringify 转义串上跑 `\b`）；
 * ② 人类侧 = `matchHumanSeeds`/`matchRiskyToolLabels` 直接作用在人类消息原文。
 * 所有 label 确定性可审计，取"首个命中"（数组顺序即优先级）。
 */

export interface KeyToolMatcher {
  label: string;
  risky: boolean;
  test: (text: string) => boolean;
}

function re(pattern: RegExp): KeyToolMatcher["test"] {
  return (text: string) => pattern.test(text);
}

// ── rm 危险形态判定（2026-09-08 拍板②）─────────────────────────────────────────
// v1 词法只做"同一命令段内 recursive 与 force 双旗标并存"判定，不做 shell 语义：
//  - 命令段 = 以 `;` / `&&` / `||` / `|` / 换行 切分 → `rm -r a && rm -f b` 跨段不误报；
//  - 旗标 = 短簇（`-rf`/`-fr`/`-Rf`/`-r`/`-f`…：含 r|R 记 recursive、含 f 记 force）
//    或长旗标 `--recursive` / `--force`（须成 token，免 `--recursiveX` 前缀误判）；
//  - 精度约束①：`rm -f x` / `rm -r x` 只带一个旗标不算；②：两个旗标须属同一 rm 调用；
//  - 命令面外壳文本（`echo 'rm -r -f'` 写文件等）仍命中 —— v1 残余类，spec §4.4 末注。
const RM_SEGMENT_BOUNDARY = /\s*(?:;|&&|\|\||\||\r?\n)\s*/;
const RM_SHORT_FLAG = /(?:^|[\s=])-([A-Za-z]+)(?=[\s=]|$)/g;
const RM_LONG_RECURSIVE = /(?:^|[\s=])--recursive\b/;
const RM_LONG_FORCE = /(?:^|[\s=])--force\b/;

function isRiskyRm(text: string): boolean {
  const segments = text.split(RM_SEGMENT_BOUNDARY);
  for (const segment of segments) {
    const rmAt: number[] = [];
    const kw = /\brm\b/g;
    let m: RegExpExecArray | null;
    while ((m = kw.exec(segment)) !== null) rmAt.push(m.index);
    for (let i = 0; i < rmAt.length; i += 1) {
      // 该 rm 起到下一个 rm 字样或段尾 —— 旗标必须属于同一个 rm 调用（精度约束②兜底）
      const end = i + 1 < rmAt.length ? rmAt[i + 1] : segment.length;
      const tail = segment.slice(rmAt[i], end);
      let recursive = false;
      let force = false;
      RM_SHORT_FLAG.lastIndex = 0;
      let sm: RegExpExecArray | null;
      while ((sm = RM_SHORT_FLAG.exec(tail)) !== null) {
        if (/[rR]/.test(sm[1])) recursive = true;
        if (sm[1].includes("f")) force = true;
      }
      if (RM_LONG_RECURSIVE.test(tail)) recursive = true;
      if (RM_LONG_FORCE.test(tail)) force = true;
      if (recursive && force) return true;
    }
  }
  return false;
}

/**
 * key_tool_call 匹配器（数组顺序 = 优先级，首个命中为 matchedBy）。
 * 同族里更具体的放前面：git.push_force 先于 git.push，git.commit_amend 先于 git.commit。
 */
export const KEY_TOOL_MATCHERS: KeyToolMatcher[] = [
  // ── risky：破坏性/不可逆操作 ────────────────────────────────────────────────
  { label: "shell.curl_pipe_sh", risky: true, test: re(/curl\b[^\n]*?https?:\/\/\S+['"]?[\s\S]*?\|\s*(?:sudo\s+)?(?:ba)?sh\b/i) },
  { label: "git.reset_hard", risky: true, test: re(/\bgit\s+reset\b[^\n]*?--hard\b/) },
  { label: "git.push_force", risky: true, test: re(/\bgit\s+push\b[^\n]*(?:--force|--force-with-lease)\b|\bgit\s+push\s+-f\b/) },
  { label: "git.commit_amend", risky: true, test: re(/\bgit\s+commit\b[^\n]*?--amend\b/) },
  { label: "git.push", risky: true, test: re(/\bgit\s+push\b/) },
  { label: "git.merge", risky: true, test: re(/\bgit\s+merge\b(?!-)/) },
  { label: "git.rebase", risky: true, test: re(/\bgit\s+rebase\b/) },
  { label: "shell.rm_rf", risky: true, test: isRiskyRm },
  { label: "sql.drop", risky: true, test: re(/\bdrop\s+(?:table|database|schema|index|view)\b/i) },
  // ── safe：行为已发生但非破坏性 ───────────────────────────────────────────────
  { label: "git.commit", risky: false, test: re(/\bgit\s+commit\b/) },
  { label: "test.run", risky: false, test: re(/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?\S*(?:test|check)\b|\b(?:pytest|go\s+test|make\s+test|mix\s+test|cargo\s+test|mvn\s+test)\b/) },
];

/** restraint 命令形触发面 / B3 判定面（risky:true 子集）。 */
export const RISKY_KEY_TOOL_MATCHERS: KeyToolMatcher[] = KEY_TOOL_MATCHERS.filter((m) => m.risky);

/** 命中的所有 matcher label（保持定义顺序，确定性可审计）。 */
export function matchKeyToolLabels(testText: string): string[] {
  const labels: string[] = [];
  for (const m of KEY_TOOL_MATCHERS) {
    if (m.test(testText)) labels.push(m.label);
  }
  return labels;
}

/** 命中的第一个 matcher label；未命中返回 undefined。 */
export function matchKeyToolFirst(testText: string): string | undefined {
  for (const m of KEY_TOOL_MATCHERS) {
    if (m.test(testText)) return m.label;
  }
  return undefined;
}

/** restraint 的链内 risky 执行判定：返回命中的 risky label 列表。 */
export function matchRiskyToolLabels(testText: string): string[] {
  const labels: string[] = [];
  for (const m of RISKY_KEY_TOOL_MATCHERS) {
    if (m.test(testText)) labels.push(m.label);
  }
  return labels;
}

/** label 是否属 risky 子集（tombstone 判定用：safe 命令丢结果宁缺，不落 unknown）。 */
export function isRiskyMatcherLabel(label: string): boolean {
  return RISKY_KEY_TOOL_MATCHERS.some((m) => m.label === label);
}

// ── 命令面门控（2026-09-08 评审收编 N1/N2）──────────────────────────────────────

/**
 * 命令承载字段（工具入参里直接放命令文本的键，优先顺序）。只认"字符串值"：
 * 文件工具（Edit/Write…）的 content / new_string / old_string 等一律不在列，
 * 因此文件内容里的命令字面量不会混进命令面（N1 的第一半）。
 */
export const COMMAND_ARG_KEYS: readonly string[] = [
  "command",
  "cmd",
  "command_line",
  "exec_command",
  "shell_command",
  "shell",
  "exec",
];

/**
 * 命令/执行类工具名（lowercase；v1 常量，跨 CC/CB 变体）。名字门控与字段门控
 * 互为补充：名字门控兜"字段非常规"（如 arguments JSON 解析失败落 args.raw）；
 * 字段门控兜"名字不在表内但入参确实带 command 字段"的新工具 —— 两类都算命令面。
 */
export const COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "shell",
  "terminal",
  "console",
  "exec",
  "cmd",
  "command",
  "cli",
  "subprocess",
  "run_command",
  "exec_command",
  "execute_command",
  "command_line",
  "shell_command",
  "code_interpreter",
  "code_execution",
  "python_exec",
  "node_exec",
]);

/**
 * 命令匹配面：返回某次 tool_use 的**解码后命令文本**；非命令面返回 undefined。
 *
 *  - 解码 = 直接用入参对象里的字符串值（真换行）。绝不拿 JSON.stringify 的转义串做
 *    `\b` 正则：转义串把换行写成字面 `"\n"`（反斜杠+n），行首命令
 *    （`if …; then\n git push origin main\nfi`）的 `git` 上一字符是词字符 `n`，
 *    词边界失效而整段漏记（N2）。命令面命中/链扫都必须先过这里再喂 matcher。
 *  - 门控 = 工具名在 COMMAND_TOOL_NAMES，**或**入参含 COMMAND_ARG_KEYS 的字符串字段。
 *    Edit/Write/Read/Grep 等把"文件内容/被读文本"当命令面会被整段排除（N1 的第二半：
 *    文档里写一句 `git push origin main` 不再被记成"破坏性 push 已执行"、也不再
 *    反向抑制同链的 restraint）。
 *  - 兜底只对名字门控的工具放行：已知命令字段都不在时取全部顶层字符串值（仍解码，
 *    真换行），保证非常规 schema 下不因字段名猜测失败而静默漏记。
 */
export function commandSurfaceTextOf(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  const lower = String(toolName ?? "").toLowerCase().trim();
  const byName = COMMAND_TOOL_NAMES.has(lower);
  const parts: string[] = [];
  for (const key of COMMAND_ARG_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) parts.push(v);
  }
  if (!byName && parts.length === 0) return undefined;
  if (parts.length === 0) {
    for (const v of Object.values(args)) {
      if (typeof v === "string" && v.length > 0) parts.push(v);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * 口语种子（v1 固定，英文动词为主，与命令 matcher 互补）。
 * 匹配对 ASCII 词用词边界、其余字面量包含。
 */
export const RISKY_HUMAN_SEEDS: readonly string[] = [
  "push",
  "publish",
  "delete",
  "deploy",
  "force",
  "drop",
  "release",
  "merge",
  "rebase",
  "overwrite",
];

function seedTest(seed: string): (text: string) => boolean {
  if (/^[a-zA-Z]+$/.test(seed)) {
    const rx = new RegExp(`\\b${seed}\\b`, "i");
    return (text) => rx.test(text);
  }
  return (text) => text.includes(seed);
}

/** 命中的种子（保持 RISKY_HUMAN_SEEDS 顺序）。 */
export function matchHumanSeeds(text: string): string[] {
  const hits: string[] = [];
  for (const seed of RISKY_HUMAN_SEEDS) {
    if (seedTest(seed)(text)) hits.push(seed);
  }
  return hits;
}

/** 文件编辑工具（code_change 候选面）。lowercase 名匹配，跨 CC/CB 变体。 */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "str_replace_editor",
  "create",
]);

export function isFileEditTool(toolName: string): boolean {
  return EDIT_TOOL_NAMES.has(String(toolName ?? "").toLowerCase());
}
