/**
 * judge 工厂（design §4.4）。
 *
 * provider 解析口径：**不抛**。未知 provider ⇒ 降级 mock + warn。
 * 理由：worker 是独立进程，配置写错就让进程起不来（crash-loop）比"降级 mock 并留 warn"
 * 危险得多 —— 且 mock 的产出带 `judge_impl="mock:v1"`，落表可见，不会被误当真实判定。
 */

import { DeterministicMockJudge, type MockJudgeScript } from "./deterministic-mock-judge.js";
import { MechanicalJudge } from "./mechanical-judge.js";
import type { Judge } from "./types.js";

export type AttributionJudgeProviderId = "mock" | "mechanical";

/** 只依赖到最小结构，避免把整个 ProxyConfig 拖进来（worker 与纯单测都能用）。 */
export interface JudgeFactoryConfig {
  attribution?: { judge?: { provider?: string } } | undefined;
}

export interface CreateJudgeDeps {
  /** 测试 / golden 用：覆盖确定性规则的显式脚本。 */
  script?: MockJudgeScript;
}

export function createJudge(config: JudgeFactoryConfig, deps: CreateJudgeDeps = {}): Judge {
  const provider = config?.attribution?.judge?.provider ?? "mock";
  if (provider === "mock") {
    return new DeterministicMockJudge({ script: deps.script });
  }
  // 58 · mechanical:v1（50 spec §13；缺省关闭 —— 需显式配置才到这）
  if (provider === "mechanical") {
    return new MechanicalJudge();
  }
  console.warn(
    `[attribution-judge] unknown judge provider "${provider}" → falling back to "mock" (judge_impl=mock:v1)`,
  );
  return new DeterministicMockJudge({ script: deps.script });
}
