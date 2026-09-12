/**
 * RealProviderJudge — 真 LLM provider 接入（50 spec §15；A6）。
 *
 * 纪律（C3/C5/C6 写死）：
 *   - **白名单解析**：恰好一个 JSON 对象 + 三字段白名单 + 类型/取值校验；任何畸形 ⇒ `unconfirmed`
 *     + 按类别计数（**不 throw、不猜、不"取第一个能解析的"、不取部分字段**）。
 *   - **分界**：HTTP 非 200 / 响应非 OpenAI-compatible 形状 ⇒ **throw**（服务契约破坏 ⇒ 走 fail/重试）；
 *     仅**模型自由文本**畸形 ⇒ unconfirmed（判定产物，重试无意义）。
 *   - **密钥纪律**：apiKey 只从 config/env 读，绝不落库 / 日志 / payload；请求头之外不出现。
 *   - 超时 = AbortController（不引入新依赖）；网络错误原样 throw ⇒ 既有 fail() 路径。
 */
import { ATTRIBUTION_JUDGE_PROMPT_V1, buildAttributionJudgePromptRef } from "../prompts/judge-prompt.js";
import type { Judge, JudgeInput, JudgeVerdict, PromptRef } from "./types.js";

/** 响应文本上限（C3 写死；超限 ⇒ too_large ⇒ unconfirmed）。 */
export const JUDGE_RESPONSE_LIMIT_CHARS = 65_536;

/** 请求 max_tokens（C6 写死；同时是响应体积的第一道闸）。 */
export const JUDGE_REQUEST_MAX_TOKENS = 512;

export type MalformedCategory =
  | "too_large"
  | "not_json"
  | "multiple_objects"
  | "unknown_field"
  | "missing_field"
  | "type_error"
  | "bad_verdict";

export type ParseResult =
  | { kind: "ok"; assetId: string | null; verdict: JudgeVerdict["verdict"]; rationaleRef: string }
  | { kind: "malformed"; category: MalformedCategory };

const FIELD_WHITELIST = new Set(["asset_id", "verdict", "rationale_ref"]);

const malformedCounters: Record<MalformedCategory, number> = {
  too_large: 0,
  not_json: 0,
  multiple_objects: 0,
  unknown_field: 0,
  missing_field: 0,
  type_error: 0,
  bad_verdict: 0,
};

export function getRealProviderMalformedCounters(): Record<MalformedCategory, number> {
  return { ...malformedCounters };
}

/** Reset counters — tests only. */
export function __resetRealProviderMalformedCountersForTests(): void {
  for (const k of Object.keys(malformedCounters) as MalformedCategory[]) malformedCounters[k] = 0;
}

function malformed(category: MalformedCategory): ParseResult {
  malformedCounters[category] += 1;
  return { kind: "malformed", category };
}

/**
 * C3 严格白名单解析。判据顺序即第一张不符的表（多类别同时成立时按此优先级归类）：
 * too_large → not_json(形态) → multiple_objects → not_json(parse/顶层) → unknown_field →
 * missing_field → type_error/bad_verdict。
 */
export function parseJudgeResponse(raw: string): ParseResult {
  if (raw.length > JUDGE_RESPONSE_LIMIT_CHARS) return malformed("too_large");
  const t = raw.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return malformed("not_json"); // 含"前后带解释文字"
  if (/\}\s*\{/.test(t)) return malformed("multiple_objects");

  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    return malformed("not_json");
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return malformed("not_json");

  const rec = obj as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.some((k) => !FIELD_WHITELIST.has(k))) return malformed("unknown_field");
  if (keys.length !== FIELD_WHITELIST.size) return malformed("missing_field");

  const assetId = rec.asset_id;
  if (assetId !== null && typeof assetId !== "string") return malformed("type_error");
  const rationaleRef = rec.rationale_ref;
  if (typeof rationaleRef !== "string") return malformed("type_error");
  const verdict = rec.verdict;
  if (verdict !== "confirmed" && verdict !== "refuted" && verdict !== "unconfirmed") {
    return malformed("bad_verdict");
  }

  return { kind: "ok", assetId: (assetId as string | null) ?? null, verdict, rationaleRef };
}

export interface RealProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export const REAL_PROVIDER_DEFAULT_TIMEOUT_MS = 30_000;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

export class RealProviderJudge implements Judge {
  readonly impl: string;
  readonly promptRef: PromptRef = buildAttributionJudgePromptRef();
  private readonly opts: Required<RealProviderOptions>;

  constructor(opts: RealProviderOptions) {
    this.opts = { ...opts, timeoutMs: opts.timeoutMs ?? REAL_PROVIDER_DEFAULT_TIMEOUT_MS };
    this.impl = `real:${opts.model}`;
  }

  async judge(input: JudgeInput): Promise<JudgeVerdict> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(`${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // ⚠️ 密钥只在请求头；绝不落库/日志/payload（C2 密钥纪律）。
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: this.opts.model,
          temperature: 0,
          max_tokens: JUDGE_REQUEST_MAX_TOKENS,
          messages: [
            {
              role: "user",
              content:
                `${ATTRIBUTION_JUDGE_PROMPT_V1.text}\n\nINPUT:\n` +
                JSON.stringify({ unit: input.unit, candidates: input.candidates }),
            },
          ],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // 服务契约破坏（HTTP 非 200）⇒ throw ⇒ 既有 fail/重试路径。
    if (!resp.ok) {
      throw new Error(`real judge provider HTTP ${resp.status}`);
    }

    // 响应非 OpenAI-compatible 形状 ⇒ throw（同上；不当作"模型文本畸形"）。
    let content: unknown;
    try {
      const body = (await resp.json()) as ChatCompletionResponse;
      content = body?.choices?.[0]?.message?.content;
    } catch {
      throw new Error("real judge provider returned non-JSON envelope");
    }
    if (typeof content !== "string") {
      throw new Error("real judge provider envelope missing choices[0].message.content");
    }

    // 模型自由文本 ⇒ C3 严格白名单；任何畸形 ⇒ unconfirmed（不 throw，不猜）。
    const parsed = parseJudgeResponse(content);
    if (parsed.kind === "malformed") {
      return { assetId: null, verdict: "unconfirmed", rationaleRef: `malformed:${parsed.category}` };
    }
    return { assetId: parsed.assetId, verdict: parsed.verdict, rationaleRef: parsed.rationaleRef };
  }
}
