/**
 * judge 工厂（design §4.4；60 起 fail-closed）。
 *
 * ── 方向反转登记（60 · 50 spec §15 C1；原理由保留、新理由并排，不覆盖）──────────────
 * 旧口径（原头注，52 前起）：
 *   "provider 解析口径：**不抛**。未知 provider ⇒ 降级 mock + warn。
 *    理由：worker 是独立进程，配置写错就让进程起不来（crash-loop）比'降级 mock 并留 warn'
 *    危险得多 —— 且 mock 的产出带 `judge_impl="mock:v1"`，落表可见，不会被误当真实判定。"
 * 新口径（A6 推翻）：
 *   判定的消费方是人类与后续汇总，"落表可见"不足以对冲"**假判定被当真实归因**"——
 *   尤其 `asset_used`（§14）已开始把 confirmed 当"使用"汇总 ⇒ **fail-closed**：
 *   未知 / 缺参 ⇒ 启动失败（`EXIT_CONFIG_INVALID`），绝不降级。
 *   crash-loop 顾虑改由"配置校验在 `getDb()` **之前**、一次性判死、**不重试**"处理。
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { DeterministicMockJudge, type MockJudgeScript } from "./deterministic-mock-judge.js";
import { MechanicalJudge } from "./mechanical-judge.js";
import { RealProviderJudge, type RealProviderOptions } from "./real-provider-judge.js";
import type { Judge } from "./types.js";

export type AttributionJudgeProviderId = "mock" | "mechanical" | "real";

/** 配置不合法（未知 provider / 真 provider 缺必需参数）——启动期 fail-closed，绝不降级。 */
export class JudgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeConfigError";
  }
}

/** 只依赖到最小结构，避免把整个 ProxyConfig 拖进来（worker 与纯单测都能用）。 */
export interface JudgeFactoryConfig {
  attribution?:
    | {
        judge?:
          | {
              provider?: string;
              real?: {
                baseUrl?: string;
                apiKey?: string;
                model?: string;
                timeoutMs?: number;
              };
            }
          | undefined;
      }
    | undefined;
}

export interface CreateJudgeDeps {
  /** 测试 / golden 用：覆盖确定性规则的显式脚本。 */
  script?: MockJudgeScript;
  /** 测试用：env 兜底注入（缺省读 process.env）。 */
  env?: Record<string, string | undefined>;
}

/** C2 env 兜底（config 优先于 env）。 */
export const JUDGE_ENV_BASE_URL = "TDAI_ATTRIBUTION_JUDGE_BASE_URL";
export const JUDGE_ENV_API_KEY = "TDAI_ATTRIBUTION_JUDGE_API_KEY";
export const JUDGE_ENV_MODEL = "TDAI_ATTRIBUTION_JUDGE_MODEL";

function resolveRealOptions(config: JudgeFactoryConfig, env: Record<string, string | undefined>): RealProviderOptions {
  const real = config?.attribution?.judge?.real;
  const baseUrl = real?.baseUrl?.trim() || env[JUDGE_ENV_BASE_URL]?.trim() || "";
  const apiKey = real?.apiKey?.trim() || env[JUDGE_ENV_API_KEY]?.trim() || "";
  const model = real?.model?.trim() || env[JUDGE_ENV_MODEL]?.trim() || "";
  const missing: string[] = [];
  if (!baseUrl) missing.push("baseUrl");
  if (!apiKey) missing.push("apiKey");
  if (!model) missing.push("model");
  if (missing.length > 0) {
    // 绝不"用缺省值去连空地址"（C2）：缺参数 = 配置不合法 = fail-closed。
    throw new JudgeConfigError(
      `judge provider "real" 缺必需参数: ${missing.join(", ")}（config.attribution.judge.real 或 env ${JUDGE_ENV_BASE_URL}/${JUDGE_ENV_API_KEY}/${JUDGE_ENV_MODEL}）`,
    );
  }
  return { baseUrl, apiKey, model, timeoutMs: real?.timeoutMs };
}

/**
 * 启动期配置校验（C1；不联网）。`main()` 在 `getDb()` **之前**调用；
 * 不合法 ⇒ throw `JudgeConfigError` ⇒ stderr + `EXIT_CONFIG_INVALID`，**不重试**。
 */
export function validateJudgeConfig(config: JudgeFactoryConfig, deps: CreateJudgeDeps = {}): void {
  const provider = config?.attribution?.judge?.provider ?? "mock";
  if (provider === "mock" || provider === "mechanical") return;
  if (provider === "real") {
    resolveRealOptions(config, deps.env ?? process.env);
    return;
  }
  throw new JudgeConfigError(
    `unknown judge provider "${provider}"（合法值: mock | mechanical | real；60 起 fail-closed，不降级 mock）`,
  );
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
  // 60 · real（50 spec §15）；缺参数 ⇒ throw JudgeConfigError（fail-closed，防御非 main 入口）。
  if (provider === "real") {
    return new RealProviderJudge(resolveRealOptions(config, deps.env ?? process.env));
  }
  throw new JudgeConfigError(
    `unknown judge provider "${provider}"（合法值: mock | mechanical | real；60 起 fail-closed，不降级 mock）`,
  );
}
