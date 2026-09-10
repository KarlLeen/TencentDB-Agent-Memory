/**
 * S4 真链路冒烟的两个外部接缝 stub（s4-smoke-design.md §5.2）。
 *
 *   1. 上游 stub（转发目标）：记录**实际被转发**的 rawBody —— 这是"模型真正收到的字节"，
 *      也是与归档重建串做硬比对的唯一对手方。
 *   2. kernel stub（会话身份来源）：MetadataClient 的 /v3/meta/* 端点，让 session-init 的
 *      debugForceIdentity 旁路能真正拿到 agent/task detail（否则 detail 全 undefined、
 *      注入块为空、用例假绿 —— 见 §5.2 纪律 2）。**同一个 stub 也承载 S4b 的
 *      `/v3/skill/listing`**（`cfg.coreSkill.endpoint` 已指向它，见该分支注释；S4a 不可达）。
 *
 * 三条纪律：
 *   - 一律 `listen(0)`（内核分配端口），不写死 8096 / 8420 —— 避免与真服务或并行 CI 撞端口。
 *   - 上游 stub **只记录、不参与判定**，也不做 forward proxy（否则把透明性变量带进来）。
 *   - kernel 响应形状必须**按 MetadataClient 的真实拆包规则**给：`{code, message, data}`
 *     且 `data` **直接是实体本身**（不是 `{agent:{...}}` 再包一层）。包错一层不抛错，
 *     只会让 detail 字段静默变 undefined → 假绿。
 */
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  /** JSON.parse 成功时的对象；否则 null（stub 不因此失败，便于诊断非 JSON 流量）。 */
  json: unknown;
}

export interface HttpStub {
  /** `http://127.0.0.1:<port>` */
  url: string;
  port: number;
  /** 按发生顺序累积。 */
  requests: RecordedRequest[];
  /** 路径以后缀匹配，按发生顺序返回。 */
  requestsTo(pathSuffix: string): RecordedRequest[];
  lastRequest(): RecordedRequest | undefined;
  close(): Promise<void>;
}

type StubResponder = (req: http.IncomingMessage, rawBody: string) => {
  status?: number;
  body: unknown;
};

async function startStub(responder: StubResponder): Promise<HttpStub> {
  const requests: RecordedRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let json: unknown = null;
      try {
        json = rawBody.length > 0 ? JSON.parse(rawBody) : null;
      } catch {
        json = null;
      }
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        rawBody,
        json,
      });

      let out: { status?: number; body: unknown };
      try {
        out = responder(req, rawBody);
      } catch (err) {
        out = { status: 500, body: { code: 500, message: String(err) } };
      }
      const payload = JSON.stringify(out.body ?? {});
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(payload);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    requestsTo: (suffix) => requests.filter((r) => r.path.endsWith(suffix)),
    lastRequest: () => requests[requests.length - 1],
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * 上游 stub：按路径识别协议并回一个最小合法响应。
 * 路径判定优先（确定性），仅当路径无法判定时回落 body 特征。
 */
export async function startUpstreamStub(): Promise<HttpStub> {
  return startStub((req, rawBody) => {
    const path = req.url ?? "";
    const looksAnthropic =
      path.includes("/messages") ||
      (path.includes("/chat/completions") === false && /"max_tokens"/.test(rawBody));

    if (looksAnthropic) {
      return {
        body: {
          id: "msg_s4_stub",
          type: "message",
          role: "assistant",
          model: "s4-stub",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
    }
    return {
      body: {
        id: "chatcmpl-s4-stub",
        object: "chat.completion",
        created: 0,
        model: "s4-stub",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    };
  });
}

/** session-init 的 debugForceIdentity 与 kernel fixture 必须一致。 */
export const S4_KERNEL_FIXTURE = {
  teamId: "team-s4",
  agentId: "agent-s4",
  taskId: "task-s4",
  agent: {
    agent_id: "agent-s4",
    name: "S4 Agent",
    description: "s4 smoke agent",
    prompt: "You are the S4 smoke agent.",
  },
  task: {
    task_id: "task-s4",
    // 两个字段都给：codebuddy 侧映射 `name: t.title`，其他调用方读 `name`。
    name: "S4 Task",
    title: "S4 Task",
    description: "s4 smoke task",
    goal: "prove seam B byte-identity",
  },
  /** 打进归档/上游串里的稳定可识别 id，供正向证据断言。 */
  agentIdToken: "agent-s4",
  taskIdToken: "task-s4",
  /**
   * S4b：skill listing 的**稳定 asset id**。
   *
   * 故意与 agentIdToken / taskIdToken 不同源 —— 后者会（合法地）出现在 session-context 块里，
   * 拿它们做"skill 资产真的进来了"的断言会**误绿**。这个 token 只出现在 `/v3/skill/listing`
   * 返回的 `listing` 正文里，是"渲染块真的进了上游字节"的唯一证据。
   */
  skillId: "skl-s4-smoke-0001",
  skillName: "s4-smoke-skill",
  skillVersion: "1.0.0",
} as const;

/**
 * `/v3/skill/listing` 的最小真实 listing 正文（core 预渲染文本的替身）。
 *
 * 两条硬约束：
 *   - **不得含 `"(none)"`**：`skill-injector.ts:286` 会把它当"无资产"哨兵静默 `return []`；
 *   - 必须含 `S4_KERNEL_FIXTURE.skillId`（唯一进上游字节的通道；`hits[].skill_id` 只进
 *     `metadata.assets`，见 `skill-injector.ts:302-307`）。
 */
export const S4_SKILL_LISTING =
  `- ${S4_KERNEL_FIXTURE.skillId} — ${S4_KERNEL_FIXTURE.skillName} v${S4_KERNEL_FIXTURE.skillVersion}`;

/**
 * kernel stub：/v3/meta/* 按后缀给实体；未知 /v3/* 给空对象（记录在 requests 里，
 * 让"多打了哪些端点"在用例中可见，而不是静默吞掉）。
 */
export async function startKernelStub(): Promise<HttpStub> {
  return startStub((req) => {
    const path = req.url ?? "";
    const ok = (data: unknown) => ({ body: { code: 0, message: "ok", data } });

    if (path.endsWith("/agent/get")) return ok(S4_KERNEL_FIXTURE.agent);
    if (path.endsWith("/task/get")) return ok(S4_KERNEL_FIXTURE.task);
    if (path.endsWith("/participation-log/append")) return ok({ appended: 1 });
    // ── S4b 扩展点：**/v3/skill/listing**（端点勘正 2026-09-10 第三轮，详见 design §5.7）──
    // SkillInjector 走 `CoreSkillClient.listListing` → `POST /v3/skill/listing`
    // （skill-injector.ts:17,269；src/skill/core-client.ts:316-321）。**不是** /v3/skill/search ——
    // 那是 searchSkills（src/skill/core-client.ts:258），本 injector 与 prewarm 都不走。
    // 端点写错 = 落到下面兜底 `ok({})` → `listing` undefined → 0 块 → "归档 === 上游"照样成立
    // ⇒ 与 kernel stub 包错层同类的**静默假绿**（正是本窗口一路在钉的那个机理）。
    //
    // S4b **已落地为 1 条确定资产**（六点原则，形状已核过源码；改动前仍以 src/skill/core-client.ts 为准）：
    //   ① 按 `ListingResult { mode, listing, hits:[{skill_id,version,name}] }`（src/skill/core-client.ts:205-209）。
    //      `listing` 是 core **预渲染文本**，proxy 只 `wrapAvailableSkillsBlock` 原样包裹
    //      （skill-injector.ts:288）⇒ **稳定 asset id 必须写进 `listing` 字符串**才会进上游字节；
    //      `hits[].skill_id` 只落 `metadata.assets`（身份、不带 spans），**别指望它进正文**。
    //   ② **别让 listing 含 "(none)"**：`listing.includes("(none)")` 会静默 `return []`（skill-injector.ts:286）。
    //   ③ 正向断言按钉子 1 加码：`[skill-injector] <trigger> result mode=full hits=1 listingLen>0`
    //      （skill-injector.ts:274-277）+ 上游 rawBody 含稳定 asset id + **无** `degrading to empty`。
    //   ④ **启用本 injector 会连带注册 `SkillToolsInjector`**（`injectors` 含 "skill" 即触发；
    //      injection/index.ts:307-320，注释原文 "Always inject ... Even when there are no skills
    //      to recommend"）⇒ 渲染块是**两个**：`<skill_tools>` + `<available_skills>`。
    //   ⑤ **`body.system` 的形状由锚点解析决定，不是由块数**：`{slot:"skills"}` 命中（真 CC
    //      prompt 含 `# Session-specific guidance`，agents/claude-code/index.ts:41）时
    //      pipeline.ts:362-371 把 system **重建成单块** ⇒ anthropic 侧仍是 **string**；未命中
    //      （S4a 那种朴素 prompt）时 :374-382 打 `anchor slot "skills" unresolved … fallback to
    //      point` → applyByPoint → appendTextToMessage（context.ts:87-89，push 新块）⇒ **array**
    //      （anthropic.ts:198-205）。反例：1 块走 fallback 也 array、2 块走锚点仍 string。
    //      ⇒ S4b **先钉那行 unresolved 在/不在**（沿用 `degrading to empty` 手法）再由分支定形状，
    //      两条分支都加正向证据三件套 —— **别按块数硬编一种形状**（prompt 换真 CC 版会静默翻转）。
    //      另有 handler 层 session-context 直拼一条路（anthropicHandler.ts:939-941 →
    //      context-injector.ts:278-287：string 基座 → 胶水直拼，array 基座 → append），要叠起来看。
    //      完整配方见 design §5.7.1。
    //   ⑥ **本分支现在真的会被打到**：S4b 用 `injectors:["skill"]` 的第三个 proxy 实例
    //      （S4a 的 proxyA/proxyB 仍是 ["knowledge"] / []，不启用它）—— 所以这里的返回值
    //      就是 S4b 判定的"事实来源"，**改它等于改 S4b 的结论**。
    if (path.endsWith("/skill/listing")) {
      // 1 条确定资产。asset id 只写进 `listing` 正文（那才是唯一进上游字节的通道），
      // `hits` 三条字段按 `ListingResult.hits: { skill_id, version, name }` 给全 —— 少一个
      // 字段也不会抛错，只会让 metadata.assets 静默变空（钉子 1 同源的静默假绿）。
      return ok({
        mode: "full",
        listing: S4_SKILL_LISTING,
        hits: [{
          skill_id: S4_KERNEL_FIXTURE.skillId,
          version: S4_KERNEL_FIXTURE.skillVersion,
          name: S4_KERNEL_FIXTURE.skillName,
        }],
      });
    }
    // 本 injector **不走**这个端点（它是 searchSkills，src/skill/core-client.ts:258）；保留分支只为让
    // "谁打到这里"在 requests 里可见，S4b **不要**在这里造资产。
    if (path.endsWith("/skill/search")) return ok({ items: [], total: 0 });
    if (path.endsWith("/team/list") || path.endsWith("/agent/list") || path.endsWith("/task/list")) {
      return ok([]);
    }
    return ok({});
  });
}
