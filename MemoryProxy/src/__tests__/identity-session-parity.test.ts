/**
 * 53 · 会话头解析「同键矩阵」：`identity.ts` 与应用唯一真相 `session/session-key.ts`
 * 必须对同一组 header 产出**同一个键**。
 *
 * 为什么需要这个装置（53 工单 §1.5）：53 之前 `identity.ts` 自带**第 4 份**头名单，且前两名与
 * 唯一真相**互换**（旧副本 `x-session-id` 优先 vs 真相 `x-conversation-id` 优先）⇒ 反例
 * `x-conversation-id=A` + `x-session-id=B` 会产出「归因键 = A / 调试日志 = B」，调试日志会说谎。
 * 本轮把那份名单收敛为对唯一真相的一次调用，本文件把「逐格相等」钉成断言。
 *
 * 结构：
 *   A1  —— 15 格同键矩阵（正向；必须逐格相等，打印全表）
 *   A1b —— 冻结优先级（钉住唯一真相自身的取值顺序，防止「两边一起改」把 A1 变成空转）
 *   A2′ —— 大小写混合键（**需显式声明的语义变更**：取不到 → 命中）
 *   A2″ —— 空串归一（**需显式声明的语义变更**：`""` → `null`，且不再挡住后续头）
 *
 * 边界：A1 的输入域 = **全小写键的 map**（两个生产调用点唯一可能的形状 —— 见 A2′ 的
 * `Headers.entries()` 实测）；大小写混合键下二者**故意不相等**（identity 更宽松），故单独成组。
 */
import { describe, it, expect } from "vitest";
import type { Context } from "hono";
import { extractClientIdentity } from "../identity.js";
import {
  resolveConversationId,
  resolveConversationIdFromHeaders,
} from "../session/session-key.js";

/** 只带 `req.header` 的最小 Context 替身（语义与 Hono 一致：取不到 → undefined）。 */
function ctxOf(headers: Record<string, string>): Context {
  return { req: { header: (name: string) => headers[name] } } as unknown as Context;
}

interface Cell {
  /** 分组（分母按组给出） */
  group: string;
  /** 格名 */
  id: string;
  headers: Record<string, string>;
}

/** A1 格子集：4（共享名）+ 2（真相独有）+ 3（旧副本独有）+ 2（双头优先序）+ 4（空值）= 15 格。 */
const CELLS: Cell[] = [
  { group: "共享名", id: "conversation-id", headers: { "x-conversation-id": "CONV" } },
  { group: "共享名", id: "session-id", headers: { "x-session-id": "SESS" } },
  { group: "共享名", id: "chat-id", headers: { "x-chat-id": "CHAT" } },
  { group: "共享名", id: "thread-id", headers: { "x-thread-id": "THREAD" } },

  { group: "真相独有", id: "claude-code-session-id", headers: { "x-claude-code-session-id": "CC" } },
  { group: "真相独有", id: "deepseek-harness-session-id", headers: { "x-deepseek-harness-session-id": "DSH" } },

  { group: "旧副本独有", id: "cb-session-id", headers: { "x-cb-session-id": "CB" } },
  { group: "旧副本独有", id: "codebuddy-session-id", headers: { "x-codebuddy-session-id": "CBUD" } },
  { group: "旧副本独有", id: "request-session", headers: { "x-request-session": "REQS" } },

  { group: "双头优先序", id: "① 前两名互换格", headers: { "x-conversation-id": "A", "x-session-id": "B" } },
  { group: "双头优先序", id: "同序对照（chat/thread）", headers: { "x-chat-id": "C2", "x-thread-id": "D2" } },

  { group: "空值", id: "空头", headers: {} },
  { group: "空值", id: "空串 session-id", headers: { "x-session-id": "" } },
  { group: "空值", id: "空串 conversation-id", headers: { "x-conversation-id": "" } },
  {
    group: "空值",
    id: "空串挡位（session-id 空 + conversation-id 有值）",
    headers: { "x-session-id": "", "x-conversation-id": "A3" },
  },
];

describe("53 · A1 同键矩阵：identity.sessionId ≡ resolveConversationId", () => {
  it("15 格逐格相等（打印全表 + 分组分母）", () => {
    const rows = CELLS.map((c) => {
      const idSession = extractClientIdentity(c.headers).sessionId;
      const truth = resolveConversationId(ctxOf(c.headers));
      return { ...c, idSession, truth, ok: idSession === truth };
    });

    console.log("A1 同键矩阵（identity.sessionId vs resolveConversationId）：");
    for (const r of rows) {
      console.log(
        `  ${r.ok ? "✓" : "✗"} [${r.group}] ${r.id} headers=${JSON.stringify(r.headers)} ` +
          `identity=${JSON.stringify(r.idSession)} truth=${JSON.stringify(r.truth)}`,
      );
    }
    const groups = [...new Set(rows.map((r) => r.group))];
    console.log(
      `A1 分母 = ${rows.length} 格（${groups
        .map((g) => `${g}:${rows.filter((r) => r.group === g).length}`)
        .join(" / ")}）；不一致 = ${rows.filter((r) => !r.ok).length} 格`,
    );

    expect(rows.filter((r) => !r.ok)).toEqual([]);
    expect(rows.length).toBe(15);
  });

  it("薄包装等价：resolveConversationId(c) ≡ resolveConversationIdFromHeaders(get)", () => {
    for (const c of CELLS) {
      expect(resolveConversationId(ctxOf(c.headers))).toBe(
        resolveConversationIdFromHeaders((n) => c.headers[n]),
      );
    }
  });
});

describe("53 · A1b 冻结优先级（唯一真相自身的取值顺序）", () => {
  // 若有人把唯一真相的取值顺序改回 session-id 优先，A1 会**两边一起变**（仍是绿的），
  // 所以必须另有一条冻结断言把顺序钉住 —— 否则「改序」这个反向控制是空转的。
  it("前两名 = conversation-id → session-id；claude-code / dsh 位次固定", () => {
    expect(resolveConversationId(ctxOf({ "x-conversation-id": "A", "x-session-id": "B" }))).toBe("A");
    expect(resolveConversationId(ctxOf({ "x-session-id": "B", "x-claude-code-session-id": "E" }))).toBe("B");
    expect(resolveConversationId(ctxOf({ "x-claude-code-session-id": "E", "x-chat-id": "C" }))).toBe("E");
    expect(resolveConversationId(ctxOf({ "x-deepseek-harness-session-id": "F", "x-chat-id": "C" }))).toBe("F");
  });
});

describe("53 · A2′ 大小写混合键（需显式声明的语义变更）", () => {
  // 旧副本只按小写键取值（`headers["x-session-id"]`）⇒ 对非小写键的 map 取不到；
  // 收敛后取值器大小写不敏感 ⇒ 命中。**生产路径不受影响**：两个调用点都用
  // `c.req.raw.headers.entries()` 构造 map，而 Headers API 已把名字小写化
  // （实测 `new Headers({'X-Session-Id':'abc'})` → 键为 `x-session-id`）。
  it("X-Session-Id 由『取不到』变为『命中』", () => {
    expect(extractClientIdentity({ "X-Session-Id": "abc" }).sessionId).toBe("abc");
    expect(
      extractClientIdentity({ "X-Conversation-Id": "A", "X-Session-Id": "abc" }).sessionId,
    ).toBe("A");
  });

  it("键名大小写不影响彼此优先级（同一格的两种写法同键）", () => {
    const lower = extractClientIdentity({ "x-conversation-id": "A", "x-session-id": "B" }).sessionId;
    const mixed = extractClientIdentity({ "X-Conversation-Id": "A", "X-Session-Id": "B" }).sessionId;
    expect(mixed).toBe(lower);
    expect(mixed).toBe("A");
  });
});

describe("53 · A2″ 空串归一（需显式声明的语义变更）", () => {
  // 旧副本用 `??` 串联 ⇒ 空串**不会**落到下一个头，且原样返回 ""（不是 null）。
  // 收敛后走唯一真相 ⇒ 空串按「未提供」处理：归 null，且继续用后面的头。
  it("空串 → null（不再返回 \"\"）", () => {
    expect(resolveConversationIdFromHeaders(() => "")).toBe(null);
    expect(extractClientIdentity({ "x-session-id": "" }).sessionId).toBe(null);
    expect(extractClientIdentity({ "x-conversation-id": "" }).sessionId).toBe(null);
  });

  it("空串不再挡住后续头（旧副本此处返回 \"\"）", () => {
    expect(resolveConversationIdFromHeaders((n) => ({ "x-session-id": "", "x-conversation-id": "A3" })[n])).toBe("A3");
    expect(extractClientIdentity({ "x-session-id": "", "x-conversation-id": "A3" }).sessionId).toBe("A3");
  });
});

describe("53 · A2‴ 认名集合 = 唯一真相的名单（需显式声明的效果面变更）", () => {
  // 收敛必然让"认哪些头"变成唯一真相那一份（S2 明令不许自行增删名单）⇒
  // 旧副本独有的 3 名退出、真相独有的 2 名进入。两处都只影响 `[identity]` 调试日志那一行，
  // 但属"需显式声明"的行为变更（工单 §1.5 的日志说谎问题即由此而来）。
  it("旧副本独有 3 名：收敛后不再被认（旧：进日志）", () => {
    for (const h of ["x-cb-session-id", "x-codebuddy-session-id", "x-request-session"]) {
      expect(extractClientIdentity({ [h]: "V" }).sessionId).toBe(null);
    }
  });

  it("真相独有 2 名：收敛后进入日志（旧：null）", () => {
    expect(extractClientIdentity({ "x-claude-code-session-id": "V" }).sessionId).toBe("V");
    expect(extractClientIdentity({ "x-deepseek-harness-session-id": "V" }).sessionId).toBe("V");
  });
});
