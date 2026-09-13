/**
 * `140 · C2`：归档链「一行式存活自检」（**零密钥、零写入**）。
 *
 * 用法（在 MemoryProxy/ 下）：
 *   npx tsx scripts/qa/archive-liveness.ts                 # 默认 127.0.0.1:8098
 *   npx tsx scripts/qa/archive-liveness.ts --port 8098 --host 127.0.0.1
 *
 * 检查① **鉴权活着**：向 `/v1/messages` 发一条**不带任何凭据**的 `POST` ⇒ **必须 `401`**。
 *   —— 这是「模块级 `config` 恒 `null` / 启动器漏 `initAuth`」这类**静默失效**的唯一机械抓手
 *   （`139 §9`：修前实测 **502** —— 请求穿过了一个"没在拦"的鉴权）。
 * 检查② **端口/进程**：`GET /health` ⇒ 必须 `200`（若响应带 `version` 则一并打印）。
 *
 * 输出：一行 `[liveness] auth=401(ok) health=200(ok) port=8098`；失败 ⇒ **非零退出**。
 * 反向要求（`140 · C2`）：**`auth.enabled=false`（或鉴权 passthrough）时本检查拿不到 401 ⇒
 * 脚本必须如实报「鉴权未启用」——不得判绿**（这是本脚本最容易写成假绿的地方，见 `R3`）。
 *
 * 红线：**零密钥**（不读 env / 不读文件 / 不带任何凭据）；**零写入**（只发这一条探测 + `/health`）；
 * 输出**不打印任何 key/凭据**。
 */
const argv = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? dflt) : dflt;
};

const HOST = argOf("--host", "127.0.0.1");
const PORT = argOf("--port", "8098");
const BASE = `http://${HOST}:${PORT}`;

async function main(): Promise<void> {
  // 检查② /health（先探端口，便于区分"不可达"与"鉴权未启用"）
  let health = "unreachable";
  let version = "";
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3_000) });
    health = String(r.status);
    if (r.status === 200) {
      try {
        const j = (await r.json()) as { version?: string };
        version = typeof j.version === "string" ? j.version : "";
      } catch {
        /* 非 JSON 响应：version 留空（不猜） */
      }
    }
  } catch {
    /* health 不可达：保持 "unreachable" */
  }

  // 检查① 鉴权活着：不带任何凭据的 POST /v1/messages ⇒ 必须 401
  let auth = "unreachable";
  try {
    const r = await fetch(`${BASE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" }, // 零凭据：无 user-key / 无 authorization
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5_000),
    });
    auth = String(r.status);
    await r.text(); // 读干响应体（不解析、不打印）
  } catch {
    /* 不可达：保持 "unreachable" */
  }

  const okAuth = auth === "401";
  const okHealth = health === "200";
  console.log(
    `[liveness] auth=${auth}${okAuth ? "(ok)" : "(fail)"} health=${health}${okHealth ? "(ok)" : "(fail)"}` +
      ` port=${PORT}${version ? ` version=${version}` : ""}`,
  );

  if (!okAuth) {
    if (auth === "unreachable") {
      console.error(`✗ 鉴权自检不可达（${HOST}:${PORT} 未在跑？）—— 非零退出`);
    } else {
      console.error(
        `✗ **鉴权未启用**（未拦截"无凭据请求"，得 HTTP ${auth}）—— 本自检**不判绿**（140 · C2 反向要求）；` +
          `期望 401：若为 502/4xx/2xx，说明鉴权层没在拦（如模块级 config 未初始化 / auth.enabled=false）。`,
      );
    }
  }
  if (!okHealth) console.error(`✗ /health 非 200（得 ${health}）—— 非零退出`);
  process.exitCode = okAuth && okHealth ? 0 : 1;
}

void main();
