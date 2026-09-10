/**
 * 基座-b 单测：judge 实现的确定性与 prompt ref。
 * 覆盖 design §5 的 T7、T8。
 */

import { describe, expect, it } from "vitest";

import { createJudge } from "../judge/create-judge.js";
import { DeterministicMockJudge } from "../judge/deterministic-mock-judge.js";
import type { JudgeInput } from "../judge/types.js";
import {
  ATTRIBUTION_JUDGE_PROMPT_V1,
  buildAttributionJudgePromptRef,
  sha256Hex,
} from "../prompts/judge-prompt.js";

const GOLDEN_PROMPT_SHA256 = "6ed16597732f5a196378e4081d1a2b873271e08fe22172f2add3bb2d5557d0ac";

function input(over: Partial<JudgeInput> = {}): JudgeInput {
  return {
    unitId: "u-1",
    sessionKey: "sess-1",
    round: 0,
    unit: { kind: "restraint", payload: { visibleAssets: [], text: "见 asset-a 的说明" } },
    candidates: [{ assetId: "asset-a", assetType: "skill", evidenceSourceType: "injected" }],
    promptRef: buildAttributionJudgePromptRef(),
    ...over,
  };
}

describe("T7 mock 确定性", () => {
  it("同输入两次 verdict 逐字节相同；输出不含时间/随机字段", async () => {
    const judge = new DeterministicMockJudge();
    const a = await judge.judge(input());
    const b = await judge.judge(input());

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // 字段最小集**恰好**三项 —— 多一个字段就意味着可能夹带时间/随机/浮点
    expect(Object.keys(a).sort()).toEqual(["assetId", "rationaleRef", "verdict"]);
    expect(a).toEqual({
      assetId: "asset-a",
      verdict: "confirmed",
      rationaleRef: "mock:payload-contains:asset-a",
    });
    expect(judge.impl).toBe("mock:v1");
  });

  it("候选都不在 payload 文本里 ⇒ 未归因（assetId null, unconfirmed），不猜", async () => {
    const judge = new DeterministicMockJudge();
    const verdict = await judge.judge(
      input({ unit: { kind: "restraint", payload: { text: "完全无关的正文" } } }),
    );
    expect(verdict).toEqual({
      assetId: null,
      verdict: "unconfirmed",
      rationaleRef: "mock:no-candidate-in-payload",
    });
  });

  it("MockJudgeScript 可覆盖（含 refuted）与强制抛错", async () => {
    const scripted = new DeterministicMockJudge({
      script: { byUnitId: { "u-1": { kind: "verdict", verdict: "refuted", assetId: "asset-a" } } },
    });
    expect((await scripted.judge(input())).verdict).toBe("refuted");

    const boom = new DeterministicMockJudge({
      script: { byUnitId: { "u-1": { kind: "throw", message: "boom" } } },
    });
    await expect(boom.judge(input())).rejects.toThrow("boom");
  });
});

describe("T8 prompt ref", () => {
  it("prompt_sha256 与 golden 字面量一致；改 text → sha256 变", () => {
    const ref = buildAttributionJudgePromptRef();

    expect(ref.memory_prompt_id).toBe("attribution-judge-v1");
    expect(ref.version).toBe(1);
    expect(ref.source).toBe("attribution-judge");
    expect(ref.prompt_sha256).toBe(GOLDEN_PROMPT_SHA256);
    // ref 的 sha256 必须由 text 算出（不是硬编码）
    expect(ref.prompt_sha256).toBe(sha256Hex(ATTRIBUTION_JUDGE_PROMPT_V1.text));
    expect(ATTRIBUTION_JUDGE_PROMPT_V1.text.length).toBe(418);

    const bumped = buildAttributionJudgePromptRef({
      ...ATTRIBUTION_JUDGE_PROMPT_V1,
      version: 2,
      text: `${ATTRIBUTION_JUDGE_PROMPT_V1.text}\nextra`,
    });
    expect(bumped.prompt_sha256).not.toBe(ref.prompt_sha256);
    expect(bumped.version).toBe(2);

    // version 变了但 text 没变 ⇒ sha 不变（sha 只跟文本走，语义正确）
    const sameText = buildAttributionJudgePromptRef({ ...ATTRIBUTION_JUDGE_PROMPT_V1, version: 3 });
    expect(sameText.prompt_sha256).toBe(ref.prompt_sha256);
  });

  it("judge 用同一个 ref（落表与落日志共用一份，不可能漂移）", () => {
    const judge = new DeterministicMockJudge();
    expect(judge.promptRef.prompt_sha256).toBe(GOLDEN_PROMPT_SHA256);
  });

  it("createJudge：mock 正常装配；未知 provider 降级 mock 且不抛（judge_impl 可辨识）", () => {
    expect(createJudge({ attribution: { judge: { provider: "mock" } } }).impl).toBe("mock:v1");
    // 写错 provider 不能让 worker 起不来
    expect(() => createJudge({ attribution: { judge: { provider: "gpt-9" } } })).not.toThrow();
    expect(createJudge({ attribution: { judge: { provider: "gpt-9" } } }).impl).toBe("mock:v1");
    expect(createJudge({}).impl).toBe("mock:v1");
  });
});
