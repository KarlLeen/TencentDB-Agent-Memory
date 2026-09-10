/**
 * S4 · bridge fetched-asset 提取器（纯函数，无副作用，可单测）。
 * 见 MemoryProxy/docs/implementation/45-bridge-telemetry-sink.md §3.2。
 *
 * 职责：从一个**已完成**的 bridge 调用事实里，回答"这次调用真的取了哪个 skill"。
 * 只做单资产语义的提取；多资产 / 无资产语义一律返回 `[]`（不 fan-out，§1 范围守卫）。
 *
 * 输入口径（关键）：
 *   - `inboundBody` / `responseText` 来自 sink 的第二参 ctx（§3.3），**不是**
 *     `row.requestBody` —— 后者是 `slice(0,512)` 的截断串（F3），会静默丢掉
 *     靠后的 `skill_id`，把"硬档"变成"假档"（P5 拍板的直接理由）。
 *   - `upstreamStatus` 属于签名的一部分，但**本期不参与判定**：响应侧由信封
 *     `code === 0` 拦非成功体（4xx/5xx 的 body 天然不是合法信封）；请求侧按
 *     §3.2 表不设状态门 —— 单资产 sub 的请求 id 就是 LLM 点名要取的那个资产。
 *     若日后要改成"仅 2xx 才算取过"，这里是唯一改动点。
 *
 * 与 `tryLazyPin`（skill-bridge.ts:1017-1096）的关系（P4 = 零触碰既有代码）：
 * 同一套响应形状知识在本期存在**两份**（R8），差异见 §3.2 对照表 —— 必须照
 * 对照表断言，否则假红：`search`（lazy-pin 多 pair / 本函数 `[]`）、
 * `files/read`（lazy-pin 显式不 pin / 本函数请求侧更全）。
 */

/** asset 从哪一侧解析出来。`null`（不在本类型内）= 本行无 asset。 */
export type FetchedAssetSource = "request" | "response";

export interface FetchedAsset {
  /** 真实资产外部 id。skill 通道契约：`asset_id === skill_id`（00 spec §3）。 */
  assetId: string;
  /** `skill` / `llm_wiki` / ...；本切片只产出 `skill`。 */
  assetType: string;
  /** 版本号，**仅响应侧**能取到时才填（供 S5 版本锚）。 */
  version?: number;
  /** 从哪一侧取的（null 语义由调用方补，见 payload.assetSource）。 */
  assetSource: FetchedAssetSource;
}

export interface ExtractFetchedAssetsInput {
  bridgeSource: "skill-bridge" | "memory-bridge";
  sub: string;
  inboundBody: Record<string, unknown> | undefined;
  /** 无响应（fetch 失败 / 未传）传 null。 */
  responseText: string | null;
  upstreamStatus: number;
}

const ASSET_TYPE_SKILL = "skill";

/**
 * 响应侧单资产 sub（F7/F13）：响应信封里有 `data.skill_id`（+ `data.version`）。
 * 缺 `skill_id` ⇒ 回退请求侧（§3.2 表）。
 */
const RESPONSE_ASSET_SUBS = new Set<string>([
  "get",
  "update",
  "patch",
  "files/write",
  "files/remove",
]);

/**
 * 请求侧单资产 sub（F13/F17）：响应**没有** `skill_id`（`files/read` 在
 * lazy-pin 里显式 `return`），只能认请求体里的 `skill_id`。
 * `files/download` 上游实为 `/v3/skill/files/read`（同样无 skill_id）⇒ 并入。
 */
const REQUEST_ASSET_SUBS = new Set<string>(["files/read", "files/download"]);

/**
 * 多资产 / 无资产语义 sub ⇒ **不提取**（§1 范围守卫）：
 * `search` / `listing` 的命中集不 fan-out（§8.2），`create` / `delete` /
 * `versions` / `list` / `extract` 也不是"取了一个 skill"。
 *
 * 导出：sink 侧据此填 `payload.multiAsset`（"本行按多资产语义处理、未 fan-out"）。
 */
export const MULTI_ASSET_SUBS = new Set<string>([
  "search",
  "listing",
  "list",
  "versions",
  "create",
  "delete",
  "extract",
]);

/** 该 sub 是否属多资产语义（sink 填 `payload.multiAsset` 用）。 */
export function isMultiAssetSub(sub: string): boolean {
  return MULTI_ASSET_SUBS.has(sub);
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * 解析 core 的 `{code:0, data:{...}}` 信封，取出 `data`。
 *
 * 任何不合规（非 JSON / 非对象 / 数组 / `code!==0` / 缺 `data`）⇒ `null`，
 * **绝不抛、绝不把上游错误当成功空壳**（同 filterTeamSearchResponse 的纪律）。
 */
function parseDataEnvelope(responseText: string | null): Record<string, unknown> | null {
  if (!responseText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const env = parsed as { code?: unknown; data?: unknown };
  if (env.code !== 0) return null;
  if (!env.data || typeof env.data !== "object" || Array.isArray(env.data)) return null;
  return env.data as Record<string, unknown>;
}

/**
 * 提取本次调用取到的单资产。返回 `[]` = 本次没有可归责的单个资产
 * （多资产语义 / memory 通道 / 两侧都拿不到 id）。
 */
export function extractFetchedAssets(input: ExtractFetchedAssetsInput): FetchedAsset[] {
  // memory-bridge 本期不提取（§8.1：响应 shape 两套、单 target 分支透传）
  // ⇒ 只落事实行、asset_id 为 NULL（P2 拍板）。
  if (input.bridgeSource !== "skill-bridge") return [];

  const requestId = asNonEmptyString(input.inboundBody?.skill_id);

  if (RESPONSE_ASSET_SUBS.has(input.sub)) {
    const data = parseDataEnvelope(input.responseText);
    const responseId = data ? asNonEmptyString(data.skill_id) : undefined;
    if (responseId) {
      const version = data ? asFiniteNumber(data.version) : undefined;
      return [
        {
          assetId: responseId,
          assetType: ASSET_TYPE_SKILL,
          ...(version !== undefined ? { version } : {}),
          assetSource: "response",
        },
      ];
    }
    // 响应侧取不到（无响应 / 非成功信封 / 缺 skill_id）⇒ 回退请求侧。
  } else if (!REQUEST_ASSET_SUBS.has(input.sub)) {
    // 多资产 / 无资产语义：不提取（范围守卫）。
    return [];
  }

  return requestId
    ? [{ assetId: requestId, assetType: ASSET_TYPE_SKILL, assetSource: "request" }]
    : [];
}
