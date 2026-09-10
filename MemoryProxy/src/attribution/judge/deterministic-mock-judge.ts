/**
 * DeterministicMockJudge — 基座唯一 judge 实现（design §4.4）。
 *
 * **确定性**是硬要求（T7）：同输入两次 verdict 逐字节相同；输出不含时间/随机/浮点字段
 * （时间与耗时只进日志，不进 verdict）。默认规则：
 *   按 candidates 顺序，取第一个 assetId 出现在 unit.payload 文本里的候选；
 *   都没有 ⇒ `{ assetId: null, verdict: "unconfirmed" }`。
 * 注意默认规则**永不产出 refuted**，也永不抛错 —— 这两件事只能由 MockJudgeScript 显式指定
 * （golden / 边界用例，如 C6 的必然失败消费）。
 *
 * ⚠️ 这条规则不是"真判定"，只是把链路跑通的最低限度规则；真 provider 属 50 spec。
 */

import { buildAttributionJudgePromptRef } from "../prompts/judge-prompt.js";
import type { Judge, JudgeInput, JudgeVerdict, PromptRef } from "./types.js";

/** 显式脚本条目：覆盖确定性规则，或强制抛错（边界用例）。 */
export type MockJudgeScriptEntry =
  | {
      kind: "verdict";
      verdict: JudgeVerdict["verdict"];
      /** 缺省 null（未归因）。 */
      assetId?: string | null;
      rationaleRef?: string;
    }
  | { kind: "throw"; message: string };

export interface MockJudgeScript {
  /** key = unitId。未命中 ⇒ 回落确定性规则。 */
  byUnitId?: Record<string, MockJudgeScriptEntry>;
}

export interface DeterministicMockJudgeOptions {
  promptRef?: PromptRef;
  script?: MockJudgeScript;
}

/**
 * 把 payload 投影成可搜索文本。字符串原样；其余 JSON 序列化。
 * 用 JSON.stringify 而非手写遍历：同一对象两次序列化逐字节相同（T7 依赖此点）。
 */
export function judgePayloadText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload === null || payload === undefined) return "";
  try {
    return JSON.stringify(payload) ?? "";
  } catch {
    return "";
  }
}

export class DeterministicMockJudge implements Judge {
  readonly impl = "mock:v1";
  readonly promptRef: PromptRef;
  private readonly script: MockJudgeScript;

  constructor(opts: DeterministicMockJudgeOptions = {}) {
    this.promptRef = opts.promptRef ?? buildAttributionJudgePromptRef();
    this.script = opts.script ?? {};
  }

  async judge(input: JudgeInput): Promise<JudgeVerdict> {
    const scripted = this.script.byUnitId?.[input.unitId];
    if (scripted) {
      if (scripted.kind === "throw") {
        // 故意抛出：供 worker 的失败/死信路径（T4 / C6）使用。
        throw new Error(scripted.message);
      }
      return {
        assetId: scripted.assetId ?? null,
        verdict: scripted.verdict,
        rationaleRef: scripted.rationaleRef ?? `mock:scripted:${scripted.verdict}`,
      };
    }

    const text = judgePayloadText(input.unit.payload);
    for (const candidate of input.candidates) {
      if (candidate.assetId.length > 0 && text.includes(candidate.assetId)) {
        return {
          assetId: candidate.assetId,
          verdict: "confirmed",
          rationaleRef: `mock:payload-contains:${candidate.assetId}`,
        };
      }
    }

    return {
      assetId: null,
      verdict: "unconfirmed",
      rationaleRef: "mock:no-candidate-in-payload",
    };
  }
}
