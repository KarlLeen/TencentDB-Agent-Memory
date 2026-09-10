/**
 * R1 双向 tripwire 的**唯一权威源**（s4-smoke-design.md §5.1）。
 *
 * 动机：漂移只活在代码里。修 R1 的人只看代码，不会翻聊天记录或 issue，所以"人工记得
 * 回来改断言"是不可靠的。本表把"已知漂移"编码成用例生成源，任何一层被动到都会红。
 *
 * 登记规则：
 *   - `KNOWN_DRIFT` 为空数组是**合法的终态**，不是"还没查"（设计侧裁决 2026-09-10，
 *     见 s4-smoke-design.md「设计侧裁决」§遗留）：S4a 首跑 R1 **未复现** ⇒ 该漂移**不存在**。
 *     此时主用例直接写成正面断言（重建块 === 实际注入块），不需要工单、也不需要写进本表。
 *     只有**新**漂移被复现时才往本表加条目。
 *   - 一旦某条漂移被复现，登记进来。用例由本表**生成**（见 smoke 用例的
 *     `known-drift tripwire` describe），不手写，避免"用例与登记表各说各话"。
 *   - `it.fails` 是**期望失败**，因此它是双向的：
 *       漂移存续 → 绿（满足"先进默认 npm test"）；
 *       有人修好 → `expected to fail but passed` → 套件立刻红，逼你把该条删掉并翻转成
 *       正面断言（销案）。
 *   - `doc` 会被联动断言读取：该文件必须存在且**含该 id 字面量**。于是
 *       「删用例 → 必须动登记表」「删登记表 → 必须动文档」，评审可见，无法静默消失。
 *   - 每条登记项**必须**自带 `check`（漂移修好后"必须通过"的断言）。**不许**恒假占位：
 *     `expect(false)` 在 `it.fails` 下是"永恒绿"，登记项等于空转（与 S4b 连撞的恒假/恒真
 *     同族）。见 s4-smoke-design.md §9.2。
 *   - `check` **必须**用 `makeCheck(判据函数)` 构造（断言层固化，登记项**无从漏写断言**），
 *     且判据函数**必须读 `root` 下的真实文件**。两条硬约束对应两条用例：
 *       ① 判据不依赖 root（恒过 / 忽略 root 去读真实仓库）⇒ smoke 的「反向自证」用例红；
 *       ② 漏写断言 ⇒ 不可能——`makeCheck` 由类型固定，登记项只提供"看"的纯函数。
 *     判据函数抽成**命名导出**，同时是**销案脚手架**（§10 推荐 3）：销案时把它原样 import
 *     进一条正面 `it`，写 `expect(判据(root)).toEqual([])`，判据只有一份、不会"抄漏一条"。
 *
 * 诚实边界：本机制保证"漂移不能静默消失"，**不保证**"漂移必须被修"——bug 存续期间
 * npm test 仍是绿的。要真正"强制修"只能让用例一直红且不进默认 npm test，那与
 * "S4 进默认 npm test"的决策直接冲突，故取前者。若以后想要更响的提醒，可加一条
 * 周期性 automation 把 `[known-drift]` 行捞出来推送（本次不做，仅记选项）。
 */
import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";

export interface KnownDrift {
  /** 稳定短 id，同时作为 `it.fails` 标题与 doc 锚点（例："R1"）。 */
  id: string;
  /**
   * 关联工单（可追溯串）；未开工可先写 "pending"。
   *
   * 本仓是 fork-local、无外部 tracker ⇒ 取仓内锚（design §12.6 裁决 2）。
   */
  ticket: string;
  /** 仓库内相对路径（相对 MemoryProxy 包根）+ 锚点，必须含 id 字面量。 */
  doc: string;
  /** 一句话描述漂移现象，进 `it.fails` 标题。 */
  summarize: () => string;
  /**
   * 漂移被修好后**必须通过**的断言（必填，见 design §9.2）。`root` = 包根，由生成器在
   * describe 作用域解析并**硬校验**后传入 —— 不能拿到 `undefined`：那会让 `path.join`
   * 抛错、而抛错在 `it.fails` 语义下也算"期望失败" ⇒ 假绿。
   *
   * **构造方式**：`makeCheck(判据函数)`，不要手写断言（见 `makeCheck` 与文件头两条硬约束）。
   */
  check: (root: string) => void;
}

/**
 * SKILL-DOC-ALIAS 的**判据**（返回违规清单，`[]` = 漂移已修好）。
 *
 * 为什么是纯函数 + 命名导出（design §10 推荐 3「销案脚手架」）：
 *   - `check` 只是它的包装 ⇒ 判据与用法解耦，销案时**原样搬进正面用例**，不会抄漏一条；
 *   - 用 `root` 而非固定路径 ⇒ 可被冒烟用例的「反向自证」喂空目录（见下②）。
 *
 * 契约：**必须读 `root` 下的真实文件**。因此 root 指向（空）目录时**读不到文件而抛错** ——
 * 这正是「反向自证」的判据：把判据写成恒过或忽略 root 的登记项，会立刻在那儿变红。
 */
export function skillDocAliasViolations(root: string): string[] {
  const violations: string[] = [];

  // 案①：injection/index.ts 的注册注释必须与实现一致（design §9.3/§9.4）。
  const injIndex = fs.readFileSync(path.join(root, "src/injection/index.ts"), "utf8");
  if (!injIndex.includes("/v3/skill/listing")) {
    violations.push(
      "injection/index.ts 注释未写明真端点 /v3/skill/listing（现只写 /v3/skill/search）",
    );
  }
  if (injIndex.includes("/v3/skill/search")) {
    violations.push(
      "injection/index.ts 注释仍称错端点 /v3/skill/search（真端点见 skill-injector 的 listListing）",
    );
  }
  if (injIndex.includes("<cloud_skills>")) {
    violations.push(
      "injection/index.ts 注释仍用旧块名 <cloud_skills>（真块名以 `## Skills (mandatory)` 开头）",
    );
  }

  // 案②：**只查注释行** —— :280 是运行时 warn 文案，且是 expectNoSkillDegradation 的
  // 锚点（"degrading to empty"），属有意例外、另开工单；把它纳入判据会把工单目标指向
  // 一个与断言冲突的位置（字面锚点被改 ⇒ 断言静默恒真的同族）。
  const skillSrc = fs.readFileSync(path.join(root, "src/injection/injectors/skill-injector.ts"), "utf8");
  const commentLines = skillSrc.split("\n").filter((l) => /^\s*(\*|\/\/)/.test(l));
  if (commentLines.join("\n").includes("<available_skills>")) {
    violations.push(
      "skill-injector.ts 注释仍用旧块名 <available_skills>（:280 运行时文案为有意例外）",
    );
  }

  return violations;
}

/**
 * 由"判据函数"生成登记项的 `check` —— 把**断言层固化**，登记项只提供"看"的纯函数，
 * 因此"读了文件却忘了断言"这类空转在类型层面就写不出来（design §10 推荐 1 配套）。
 *
 * 用 `expect.soft` + 数组 diff：半修时一次列全**剩余**违规（销案进度可见，不必逐条跑）。
 */
export function makeCheck(violations: (root: string) => string[]): (root: string) => void {
  return (root) => {
    expect
      .soft(violations(root), "known-drift 判据仍未满足（数组即剩余违规清单）")
      .toEqual([]);
  };
}

/**
 * 当前登记在案的已知漂移。
 *
 * S4a 首跑结论 + 设计侧裁决（2026-09-10）：R1 **未复现** —— openai 侧"重建块"与"实际注入块"
 * 同源同参（archive 侧 buildSessionContextBlockWithToggles 与注入侧 injectSessionContextWithToggles
 * 最终都落到 buildContextBlock，agentDetail/taskDetail 为同一对对象、toggles 同一份 config），
 * ⇒ 该漂移**不存在**，R1 以正面断言形式进主用例（A3）。
 *
 * **`[]` 是合法终态，不是"待填"**（设计侧裁决原文：R1 未复现 ⇒ 漂移不存在，不必为它造登记项）。
 * 只有在**新**漂移被复现时才往这里加条目。
 *
 * 2026-09-10（第八轮）：登记第一条 **SKILL-DOC-ALIAS** —— 误因工单（纯注释/文档漂移，
 * 生产行为零改动）。承载方式、验收口径与销案动作见 s4-smoke-design.md §9。
 */
export const KNOWN_DRIFT: readonly KnownDrift[] = [
  {
    id: "SKILL-DOC-ALIAS",
    ticket: "pending",
    doc: "docs/implementation/s4-smoke-design.md",
    summarize: () =>
      "skill 注入的注释仍用旧块名 <available_skills>；injection/index.ts 仍称错端点 "
      + "/v3/skill/search 与旧块名 <cloud_skills>（runtime 文案 skill-injector.ts:280 为有意例外）",
    // 判据见 skillDocAliasViolations（销案时原样搬成正面断言）；断言层由 makeCheck 固化。
    check: makeCheck(skillDocAliasViolations),
  },
];

/** 提醒前缀：用例生成器会把登记项打成这一行，便于未来 automation 抓取。 */
export const KNOWN_DRIFT_LOG_PREFIX = "[known-drift]";
