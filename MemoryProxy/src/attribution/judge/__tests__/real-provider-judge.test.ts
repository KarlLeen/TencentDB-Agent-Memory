/**
 * 60 · 真 provider 接入测试矩阵（50 spec §15）：
 * T1 白名单解析 golden（好/坏矩阵 + 分类计数）；T4a 超时；T6 缺省关闭 / 配置校验。
 * （T2 幻觉护栏、T3 fail-closed 子进程、T5 e2e 在其它文件。）
 */
import http from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

import {
  JUDGE_RESPONSE_LIMIT_CHARS,
  RealProviderJudge,
  __resetRealProviderMalformedCountersForTests,
  getRealProviderMalformedCounters,
  parseJudgeResponse,
} from "../real-provider-judge.js";
import { JudgeConfigError, validateJudgeConfig } from "../create-judge.js";

const GOOD = JSON.stringify({ asset_id: "asset-a", verdict: "confirmed", rationale_ref: "r-1" });
const GOOD_NULL = JSON.stringify({ asset_id: null, verdict: "unconfirmed", rationale_ref: "r-2" });

describe("60 · T1 白名单解析 golden（任何畸形 ⇒ unconfirmed + 分类计数；不猜不取部分字段）", () => {
  it("好响应：confirmed / unconfirmed(null) 都 ok", () => {
    expect(parseJudgeResponse(GOOD)).toEqual({
      kind: "ok",
      assetId: "asset-a",
      verdict: "confirmed",
      rationaleRef: "r-1",
    });
    expect(parseJudgeResponse(GOOD_NULL)).toEqual({
      kind: "ok",
      assetId: null,
      verdict: "unconfirmed",
      rationaleRef: "r-2",
    });
  });

  it("坏响应矩阵：每格命中对应类别", () => {
    __resetRealProviderMalformedCountersForTests();
    const cases: Array<[string, string, string]> = [
      ["非 JSON（裸文本）", "hello world", "not_json"],
      ["JSON 数组", "[1,2,3]", "not_json"],
      ["截断 JSON", '{"asset_id":"a"', "not_json"],
      ["尾随垃圾", `${GOOD} extra`, "not_json"],
      ["前后解释文字", `Here is the result: ${GOOD}`, "not_json"],
      ["多对象（紧贴）", `${GOOD}${GOOD}`, "multiple_objects"],
      ["多对象（空白隔）", `${GOOD}  ${GOOD}`, "multiple_objects"],
      ["未知字段", JSON.stringify({ asset_id: "a", verdict: "confirmed", rationale_ref: "r", confidence: 0.9 }), "unknown_field"],
      ["缺字段", JSON.stringify({ asset_id: "a", verdict: "confirmed" }), "missing_field"],
      ["asset_id 类型错", JSON.stringify({ asset_id: 42, verdict: "confirmed", rationale_ref: "r" }), "type_error"],
      ["rationale_ref 类型错", JSON.stringify({ asset_id: "a", verdict: "confirmed", rationale_ref: 7 }), "type_error"],
      ["verdict 取值非法", JSON.stringify({ asset_id: "a", verdict: "maybe", rationale_ref: "r" }), "bad_verdict"],
      [
        "超长（> 上限）",
        JSON.stringify({ asset_id: "a", verdict: "confirmed", rationale_ref: "x".repeat(JUDGE_RESPONSE_LIMIT_CHARS) }),
        "too_large",
      ],
    ];
    const observed: Record<string, string> = {};
    for (const [label, raw, expected] of cases) {
      const r = parseJudgeResponse(raw);
      expect(r.kind, `${label} 应为畸形`).toBe("malformed");
      if (r.kind === "malformed") observed[label] = r.category;
      expect(r.kind === "malformed" ? r.category : "", `${label} 类别`).toBe(expected);
    }
    const counters = getRealProviderMalformedCounters();
    console.log(`T1 观测 → 类别=${JSON.stringify(observed)}；计数=${JSON.stringify(counters)}`);
    expect(counters.not_json).toBe(5);
    expect(counters.multiple_objects).toBe(2);
    expect(counters.unknown_field).toBe(1);
    expect(counters.missing_field).toBe(1);
    expect(counters.type_error).toBe(2);
    expect(counters.bad_verdict).toBe(1);
    expect(counters.too_large).toBe(1);
  });

  it("任何畸形 ⇒ judge 返回 unconfirmed + rationaleRef=malformed:<类别>（不 throw）", async () => {
    __resetRealProviderMalformedCountersForTests();
    const { judge } = await startStubLlm(() => "not a json at all");
    const v = await judge.judge(baseInput());
    console.log(`T1 畸形 → verdict=${JSON.stringify(v)}`);
    expect(v.verdict).toBe("unconfirmed");
    expect(v.assetId).toBe(null);
    expect(v.rationaleRef).toBe("malformed:not_json");
  });
});

/** 本地 stub LLM（F7：不碰真网络、不需真凭据）；记录收到的请求供断言。 */
interface StubLlm {
  judge: RealProviderJudge;
  requests: Array<{ url: string; auth: string | undefined; body: Record<string, unknown> }>;
  close: () => Promise<void>;
}

async function startStubLlm(
  contentOf: (body: Record<string, unknown>) => string,
  opts: { status?: number; delayMs?: number; envelope?: unknown } = {},
): Promise<StubLlm> {
  const requests: StubLlm["requests"] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        auth: req.headers.authorization,
        body: JSON.parse(raw) as Record<string, unknown>,
      });
      const respond = (): void => {
        if (opts.status && opts.status !== 200) {
          res.writeHead(opts.status).end("upstream error");
          return;
        }
        const envelope = opts.envelope ?? { choices: [{ message: { content: contentOf(requests[requests.length - 1]!.body) } }] };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(envelope));
      };
      if (opts.delayMs) setTimeout(respond, opts.delayMs);
      else respond();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address() as { port: number };
  const judge = new RealProviderJudge({
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    apiKey: "stub-key-60",
    model: "stub-model",
    timeoutMs: opts.delayMs && opts.delayMs > 300 ? 100 : undefined,
  });
  return {
    judge,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function baseInput(): Parameters<RealProviderJudge["judge"]>[0] {
  return {
    unitId: "u-60",
    sessionKey: "s-60",
    round: 0,
    unit: { kind: "restraint", payload: { text: "见 asset-a" } },
    candidates: [{ assetId: "asset-a", assetType: "skill", evidenceSourceType: "injected" }],
    promptRef: new RealProviderJudge({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m" }).promptRef,
  };
}

describe("60 · T1b 请求形状（C6）+ T4a 超时 / 包装畸形（C5）", () => {
  it("请求：POST {baseUrl}/chat/completions；prompt 文本 + INPUT；Bearer 密钥只在请求头", async () => {
    const stub = await startStubLlm(() => GOOD);
    try {
      const v = await stub.judge.judge(baseInput());
      const req = stub.requests[0]!;
      console.log(`T1b 请求 → url=${req.url} auth=${req.auth} model=${req.body.model} max_tokens=${req.body.max_tokens}`);
      expect(req.url).toBe("/v1/chat/completions");
      expect(req.auth).toBe("Bearer stub-key-60");
      expect(req.body.model).toBe("stub-model");
      expect(req.body.temperature).toBe(0);
      expect(req.body.max_tokens).toBe(512);
      const msgs = req.body.messages as Array<{ content: string }>;
      expect(msgs[0]!.content).toContain("exactly one JSON object");
      expect(msgs[0]!.content).toContain("INPUT:");
      expect(msgs[0]!.content).toContain('"asset-a"');
      // C6：promptRef 链路不变；impl 可辨识到模型
      expect(stub.judge.impl).toBe("real:stub-model");
      expect(v).toEqual({ assetId: "asset-a", verdict: "confirmed", rationaleRef: "r-1" });
    } finally {
      await stub.close();
    }
  });

  it("超时（delay > timeoutMs）⇒ throw（走既有 fail 路径，不 hang）", async () => {
    const stub = await startStubLlm(() => GOOD, { delayMs: 400 });
    try {
      await expect(stub.judge.judge(baseInput())).rejects.toThrow();
    } finally {
      await stub.close();
    }
  });

  it("包装畸形（HTTP 非 200 / 缺 choices）⇒ throw（服务契约破坏 ⇒ 重试路径，不是 unconfirmed）", async () => {
    const stub500 = await startStubLlm(() => GOOD, { status: 500 });
    try {
      await expect(stub500.judge.judge(baseInput())).rejects.toThrow(/HTTP 500/);
    } finally {
      await stub500.close();
    }
    const stubBad = await startStubLlm(() => GOOD, { envelope: { not_choices: true } });
    try {
      await expect(stubBad.judge.judge(baseInput())).rejects.toThrow(/envelope/);
    } finally {
      await stubBad.close();
    }
  });
});

describe("60 · T6 缺省关闭 / 配置校验（C1）", () => {
  it("validateJudgeConfig：mock / mechanical 通过；real 齐备通过；缺参数 / 未知抛（fail-closed）", () => {
    expect(() => validateJudgeConfig({ attribution: { judge: { provider: "mock" } } })).not.toThrow();
    expect(() => validateJudgeConfig({ attribution: { judge: { provider: "mechanical" } } })).not.toThrow();
    expect(() => validateJudgeConfig({})).not.toThrow(); // 缺省 = mock
    expect(() =>
      validateJudgeConfig({
        attribution: { judge: { provider: "real", real: { baseUrl: "http://x", apiKey: "k", model: "m" } } },
      }),
    ).not.toThrow();
    // 缺参数（三种缺法 + 全缺）
    expect(() => validateJudgeConfig({ attribution: { judge: { provider: "real" } } }, { env: {} })).toThrow(
      /缺必需参数: baseUrl, apiKey, model/,
    );
    expect(() =>
      validateJudgeConfig(
        { attribution: { judge: { provider: "real", real: { baseUrl: "http://x", apiKey: "k" } } } },
        { env: {} },
      ),
    ).toThrow(/缺必需参数: model/);
    // env 兜底（config 优先）
    expect(() =>
      validateJudgeConfig(
        { attribution: { judge: { provider: "real", real: { baseUrl: "http://x", apiKey: "k" } } } },
        { env: { TDAI_ATTRIBUTION_JUDGE_MODEL: "m-env" } },
      ),
    ).not.toThrow();
    expect(() =>
      validateJudgeConfig({
        attribution: { judge: { provider: "real", real: { baseUrl: "http://x", apiKey: "k", model: "m" } } },
      }),
    ).not.toThrow();
    // 未知 provider
    let err: unknown = null;
    try {
      validateJudgeConfig({ attribution: { judge: { provider: "gpt-9" } } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JudgeConfigError);
    console.log(`T6 观测 → 未知 provider 错误原文="${(err as Error).message}"`);
  });
});
