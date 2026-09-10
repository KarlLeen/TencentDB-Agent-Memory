/**
 * S4 · §4 用例 1/2/3a：`extractFetchedAssets` 纯函数的形状与边界。
 *
 * 为什么这些断言长这样（口径，别照直觉改）：
 *   - 输入是 **ctx**（`inboundBody` / `responseText` 未截断原文），**不是**
 *     `row.requestBody`（512 截断串，F3）。P5 拍板的整条理由就在这里。
 *   - 用例 2 的"响应不可用"有两层语义，本文件**分别钉住**（见下），因为 spec
 *     §3.2 表（缺则回退请求）与 §4 用例 2 的措辞（返回 []）在"响应不可用但请求
 *     侧有 id"时读法不同 —— 本文件按 §3.2 表实现并显式断言，同时登记勘正。
 *     依据是 §3.3 的调用点表：`skill-bridge.ts:887`（fetch 抛错）明确写着
 *     "无响应 ⇒ **只走请求侧**" —— 若响应不可用就一律返回 []，那一行 `inboundBody`
 *     传值将没有任何读取者。
 *   - 用例 3a 的"预期不同"项（`search` / `files/read`）必须照 §3.2 对照表断言，
 *     否则是假红：它们与 `tryLazyPin` 的一致性要求本来就是"不一致"。
 */
import { describe, expect, it } from "vitest";

import {
  extractFetchedAssets,
  isMultiAssetSub,
  type ExtractFetchedAssetsInput,
} from "../bridge-fetch-assets.js";

const SKILL_ID = "sk-s4-0001";
const VERSION = 7;

/** 构造提取器输入；缺省 = 一次成功的 `get`（请求侧与响应侧都有同一个 skill_id）。 */
function input(over: Partial<ExtractFetchedAssetsInput> = {}): ExtractFetchedAssetsInput {
  return {
    bridgeSource: "skill-bridge",
    sub: "get",
    inboundBody: { skill_id: SKILL_ID },
    responseText: null,
    upstreamStatus: 200,
    ...over,
  };
}

function envelope(data: unknown, code = 0): string {
  return JSON.stringify({ code, data });
}

describe("用例 1 · 提取器形状", () => {
  it("get + 成功信封 ⇒ 响应侧 {assetId, assetType:'skill', version}", () => {
    const got = extractFetchedAssets(
      input({ responseText: envelope({ skill_id: SKILL_ID, version: VERSION }) }),
    );
    expect(got).toEqual([
      { assetId: SKILL_ID, assetType: "skill", version: VERSION, assetSource: "response" },
    ]);
  });

  it("get + 响应合法信封但缺 skill_id ⇒ 回退请求 skill_id（无 version）", () => {
    const got = extractFetchedAssets(input({ responseText: envelope({ version: VERSION }) }));
    expect(got).toEqual([{ assetId: SKILL_ID, assetType: "skill", assetSource: "request" }]);
  });

  it("get + 两侧 id 不同 ⇒ 取响应侧（响应是“真的取到”的那一份）", () => {
    const got = extractFetchedAssets(
      input({ responseText: envelope({ skill_id: "sk-from-response", version: 3 }) }),
    );
    expect(got).toEqual([
      { assetId: "sk-from-response", assetType: "skill", version: 3, assetSource: "response" },
    ]);
  });

  it("响应 version 非数字 ⇒ 省略 version 键（不写 null 冒充）", () => {
    const got = extractFetchedAssets(
      input({ responseText: envelope({ skill_id: SKILL_ID, version: "7" }) }),
    );
    expect(got).toHaveLength(1);
    expect(got[0]).not.toHaveProperty("version");
  });
});

describe("用例 2 · 提取器边界", () => {
  it("files/read 与 files/download 只认请求侧（响应没有 skill_id）", () => {
    for (const sub of ["files/read", "files/download"]) {
      const got = extractFetchedAssets(
        input({
          sub,
          // 真实 readFile 形状：有 version、有 content，就是没有 skill_id（F13）
          responseText: envelope({ path: "/a.md", content: "hi", version: 9 }),
        }),
      );
      expect(got).toEqual([{ assetId: SKILL_ID, assetType: "skill", assetSource: "request" }]);
    }
  });

  it("多资产 / 无资产语义 sub ⇒ [] 且 multiAsset 标记为真", () => {
    for (const sub of ["search", "listing", "list", "versions", "create", "delete", "extract"]) {
      const got = extractFetchedAssets(
        input({ sub, responseText: envelope({ items: [{ skill_id: "x", version: 1 }] }) }),
      );
      expect(got).toEqual([]);
      expect(isMultiAssetSub(sub)).toBe(true);
    }
  });

  it("memory-bridge 全部 sub ⇒ []（§8.1：本期不解析，只落事实行）", () => {
    for (const sub of ["atomic/search", "conversation/search", "atomic/get"]) {
      expect(
        extractFetchedAssets(
          input({
            bridgeSource: "memory-bridge",
            sub,
            responseText: envelope({ items: [{ skill_id: "x" }] }),
          }),
        ),
      ).toEqual([]);
    }
  });

  it("响应非 JSON / code!==0 / 缺 data / data 非对象 / 顶层数组 ⇒ 不抛；请求侧也无线索时 []", () => {
    const unusableResponses = [
      "this is not json",
      "<html>502 Bad Gateway</html>",
      envelope({ skill_id: SKILL_ID }, 500), // code!==0：不把上游错误当成功
      JSON.stringify({ code: 0 }), // 缺 data
      JSON.stringify({ code: 0, data: null }),
      JSON.stringify({ code: 0, data: [1, 2] }), // data 不是对象
      JSON.stringify([{ code: 0, data: { skill_id: SKILL_ID } }]), // 顶层数组
    ];
    for (const responseText of unusableResponses) {
      expect(() => extractFetchedAssets(input({ responseText }))).not.toThrow();
      // 请求侧也没有 skill_id ⇒ 两侧都无线索 ⇒ []
      expect(extractFetchedAssets(input({ responseText, inboundBody: undefined }))).toEqual([]);
      expect(extractFetchedAssets(input({ responseText, inboundBody: {} }))).toEqual([]);
    }
  });

  it("响应不可用但请求侧有 skill_id ⇒ 回退请求侧（§3.2 表；与 ':887 无响应只走请求侧' 同源）", () => {
    for (const responseText of [
      null,
      "",
      "not json",
      envelope({ skill_id: SKILL_ID }, 500),
      JSON.stringify({ code: 0, data: null }),
    ]) {
      expect(extractFetchedAssets(input({ responseText }))).toEqual([
        { assetId: SKILL_ID, assetType: "skill", assetSource: "request" },
      ]);
    }
  });

  it("skill_id 非字符串 / 空串 / 缺失 ⇒ 不提取（不伪造）", () => {
    for (const inboundBody of [
      { skill_id: 123 },
      { skill_id: "" },
      { skill_id: null },
      { skill_id: { nested: true } },
      {},
    ]) {
      expect(extractFetchedAssets(input({ inboundBody, sub: "files/read" }))).toEqual([]);
      // 响应侧同样取不到 id ⇒ 也 []
      expect(extractFetchedAssets(input({ inboundBody, sub: "get" }))).toEqual([]);
    }
  });

  it("未知 sub ⇒ []（范围守卫，不臆测）", () => {
    expect(extractFetchedAssets(input({ sub: "get-by-name" }))).toEqual([]);
    expect(extractFetchedAssets(input({ sub: "" }))).toEqual([]);
    expect(isMultiAssetSub("get-by-name")).toBe(false);
  });
});

describe("用例 3a · 与 tryLazyPin 的对照表（§3.2，含两处“预期不同”项）", () => {
  it("get / WRITE_LOCK_OPS：两侧同源同一对 {skillId, version}（要求完全一致）", () => {
    const resp = envelope({ skill_id: SKILL_ID, version: VERSION });
    for (const sub of ["get", "update", "patch", "files/write", "files/remove"]) {
      const got = extractFetchedAssets(input({ sub, responseText: resp }));
      expect(got).toHaveLength(1);
      // 这两项就是 tryLazyPin 在 :1071-1077 / :1089-1098 取出的同一个 {data.skill_id, data.version}
      expect(got[0].assetId).toBe(SKILL_ID);
      expect(got[0].version).toBe(VERSION);
      expect(got[0].assetSource).toBe("response");
    }
  });

  it("search：tryLazyPin 出多 pair vs 本函数 []（预期不同：不 fan-out，§8.2）", () => {
    const resp = envelope({
      items: [
        { skill_id: "a", version: 1 },
        { skill_id: "b", version: 2 },
      ],
    });
    // tryLazyPin（:1052-1068）会 pinMany 两个 pair；S4 明确不做（范围守卫）
    expect(extractFetchedAssets(input({ sub: "search", responseText: resp }))).toEqual([]);
    expect(isMultiAssetSub("search")).toBe(true);
  });

  it("files/read：tryLazyPin 显式不产出 vs 本函数请求侧（预期不同：S4 更强）", () => {
    const resp = envelope({ path: "/a.md", content: "hi", version: 9 });
    // tryLazyPin（:1081-1087）直接 return，无产出；S4 从请求侧拿到 skill_id
    expect(extractFetchedAssets(input({ sub: "files/read", responseText: resp }))).toEqual([
      { assetId: SKILL_ID, assetType: "skill", assetSource: "request" },
    ]);
  });

  it("其他 sub（list/versions/create/delete/extract）：两侧都空（一致）", () => {
    const resp = envelope({ skill_id: SKILL_ID, version: 1 });
    for (const sub of ["list", "versions", "create", "delete", "extract"]) {
      expect(extractFetchedAssets(input({ sub, responseText: resp }))).toEqual([]);
    }
  });
});
