# 资产归因链部署指南（题目任务三 + 任务四）

> 本指南回答：**如何从零部署并看到「资产使用回执」**（面板里「本次应用 N 项团队资产 + 每项是否被实际使用」）。
> 归因链能力在 proxy 里**默认关闭**（fail-closed 设计），需要按本指南手动开启，并且**数据不会凭空出现**——要自己注册资产、跑一条真实会话，才会产生回执。

---

## 0. 这套系统做了什么（30 秒理解）

题目要求区分资产六阶段：`recalled → selected → injected → used → validated → corrected`，并防止"只被召回过就宣称有效"。

本系统的链路：

```
资产（Skill / 知识 / 历史记忆）
  → 注入 Agent 上下文（injected）
  → Agent 做决策/改代码/调工具
  → 独立裁判判定"这个动作到底是不是资产影响的"（used / corrected / 背景参考）
  → 面板「归因回执」展示 asset → decision → outcome 证据链
```

关键设计：**三道机械锚点只挡假话，独立裁判做语义判断**——所以"模型真的遵循了资产"（如资产约定 `git commit -s` 签名，模型就真的 `--signoff`）会被判 `used`；而"只是主题相关"（如资产讲构建环境，模型跑了 pytest）不会被记功。

---

## 1. 前置：起三件套

```bash
cd TencentDB-Agent-Memory/deploy/global-images
./start-all.sh          # 交互式：自动复制 .env → 填两组 LLM → 校验通路 → 拉起三件套
```

起完后：

| 组件 | 端口 | 用途 |
|---|---|---|
| memory-core | 8420 | 内核：记忆、鉴权、Skill/RAG 数据面 |
| memory-hub（面板） | 8125 | 管理面板（含「归因回执 / 抽查池」页） |
| knowledge | 8424 | 知识服务 |
| proxy | 8096 | coding agent 的 LLM 转发入口 |

---

## 2. 启用归因链（关键，5 步）

### 2.1 开 proxy 四个开关

编辑 proxy 的 `config.yaml`（容器内 `/data/config.yaml`，由 `start-proxy.sh` 从 `.env` 生成）。在 `injection:` 段下加三键，在文件末尾加 `attribution:` 段：

```yaml
injection:
  enabled: true
  # ↓↓↓ 归因链三个开关（默认 false，必须显式开）↓↓↓
  attributionEvents:          # 写归因事件（hook.done / asset_fetched / agent.tool.change）
    enabled: true
  decisionUnitExtractor:      # 把 agent 每轮动作切成「决策单元」
    enabled: true
  visibleArchive:             # 归档「agent 当时看到的」正文切片（只喂可公开内容）
    enabled: true
    maxBlockChars: 32768
    maxMessageChars: 65536

# ↓↓↓ 判官总开关（文件末尾）↓↓↓
attribution:
  judge:
    enqueue: true             # 只有显式 true 才把决策单元入队
    provider: mechanical      # 见 2.2 选型
```

> 完整骨架见 `MemoryProxy/config.example.yaml`（`injection:` 段 + 文件末尾 `attribution:` 段）。
> 每个开关的代价：写库（事件行增长）+ CPU（抽取/解析）+ **正文落库（隐私敏感，只喂可公开内容）**；改后必须重启 proxy。

### 2.2 选判官 provider（决定能不能判出「已采用」）

| provider | 费用 | 能判什么 | 建议 |
|---|---|---|---|
| `mechanical` | 零（本地规则） | 只认「整段逐字引用」——模型几乎不会整段照抄资产，所以**基本判不出 used** | 先跑通链路用 |
| `real` | 要配 LLM | 做**语义对照**——能判「实质遵循」（如 `git commit --signoff` 对应「DCO 签名」约定），**能判出 used** | 想要真实回执用 |

选 `real` 时补上（`baseUrl/apiKey/model` 无缺省，缺任一启动即失败）：

```yaml
attribution:
  judge:
    enqueue: true
    provider: real
    real:
      baseUrl: "https://<openai-兼容端点>"
      apiKey: "<密钥>"
      model: "<模型名>"
      timeoutMs: 30000
```

### 2.3 起判官 worker（独立进程，栈不会自动拉起）

```bash
docker exec -d -w /app tdai-proxy npm run worker:attribution
# 或源码部署： cd MemoryProxy && npm run worker:attribution
```

worker 与 proxy **同库**、常驻轮询队列，认领 → 判定 → 写 `asset_used` / `asset_corrected`。

### 2.4 配面板凭证

面板（memory-hub）要能调 proxy 的归因只读接口，需要两个环境变量：

| 变量 | 说明 |
|---|---|
| `ATTRIBUTION_PROXY_BASE_URL` | proxy 的 admin 面地址，例如 `http://host.docker.internal:8096`（面板容器里 `127.0.0.1` 指自己，不通） |
| `ATTRIBUTION_PROXY_ADMIN_KEY` | proxy `admin.apiKey` 配置的值（默认缺省为空 ⇒ 面板 fail-closed 显示 unavailable） |

给 `tdai-memory-hub` 容器加这两个环境变量后重启面板。

### 2.5 重启 + 自检

```bash
docker restart tdai-proxy
docker exec tdai-proxy sh -lc 'grep -cE "attributionEvents|decisionUnitExtractor|visibleArchive|enqueue" /data/config.yaml'
# 应看到 4 处命中（三个 injection 键 + judge.enqueue）
```

---

## 3. 造一条真实数据（让回执页有内容）

代码和开关就绪后，回执页**仍然是空的**——因为还没有资产、没有会话。按下面三步造一条。

### 3.1 注册一条「可公开」的资产

在面板（`http://localhost:8125`）→ 资产管理 → 新建一条 **Skill**（或 Wiki），内容用**可公开的约定**，例如：

```markdown
# 提交约定
本项目所有 commit 必须 DCO 签名：使用 `git commit -s`（Signed-off-by trailer）。
```

（不要用含个人隐私/密钥的真实历史资产——正文会被归档落库。）

### 3.2 跑一条会「用到这条资产」的会话

让 coding agent 把 API base 指向 proxy（`http://localhost:8096`），做一件会触发该资产的任务（例如「把改动提交成 git commit」）。agent 会：

1. 召回并注入这条 Skill；
2. 执行 `git commit -s`（遵循了资产约定）；
3. proxy 把这一轮动作切成「决策单元」并写入队列。

### 3.3 看判定落库

worker 消费队列后，判定结果落库：

```bash
# 查判定（verdict 应为 confirmed，即"实质使用了资产"）
docker exec tdai-proxy sh -lc 'sqlite3 /data/tdai-memory-proxy/proxy.db \
  "SELECT verdict, asset_id FROM attribution_judgement_details ORDER BY created_at DESC LIMIT 5;"'

# 查 used 状态行
docker exec tdai-proxy sh -lc 'sqlite3 /data/tdai-memory-proxy/proxy.db \
  "SELECT event_type, asset_id FROM attribution_status_events;"'
```

### 3.4 面板验证回执

打开 `http://localhost:8125/#/attribution`，选该会话，应看到：

- **本次应用 N 项团队资产**（含你注册的那条 Skill）；
- 被实际使用的那项标「**已采用**」，展开能看到「判官理由 + 具体动作 + 位置」；
- 其余项标「仅作为背景参考」（判官未检测到实质使用，不记功）。

---

## 4. 验证清单（可复跑）

```bash
# ① 四键已开（应 4 处命中）
docker exec tdai-proxy sh -lc 'grep -cE "attributionEvents|decisionUnitExtractor|visibleArchive|enqueue" /data/config.yaml'

# ② worker 在跑
docker exec tdai-proxy ps aux | grep worker:attribution

# ③ 有判定行（非空）
docker exec tdai-proxy sh -lc 'sqlite3 /data/tdai-memory-proxy/proxy.db "SELECT COUNT(*) FROM attribution_judgement_details;"'

# ④ 面板可达
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8125/health
```

---

## 5. 默认值与代价（诚实说明）

1. **归因链默认关闭**：四键 `enabled: false` + `judge.enqueue: false`。未配置 = 不写、零行为回归，这是刻意 fail-closed（防「静默产生归因数据」）。
2. **validated 档不存在**：`asset_validated` 是 fail-closed 禁写（「谁是验证器」未定），回执页**不会出现「已验证」档**——这是设计，不是 bug。
3. **效果评测（对照实验）属任务五**：本系统只证明「资产影响了决策」，不证明「资产带来了多大增益」。
4. **`visibleArchive` 会正文落库**：只对可公开内容开启；含隐私/密钥的资产不要走真实注入。
5. **mechanical 判官几乎判不出 used**：它只认整段逐字引用。要看到「已采用」，用 `real` 判官（语义对照）并配 LLM。
