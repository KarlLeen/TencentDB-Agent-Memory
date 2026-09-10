# 共享基座（v2）开启 checklist / 组合矩阵 / DB 清理

> 配套：`attribution-base-design.md`（下称 design，§4 设计 / **§4.8 基座-c** / §5 单测 / §6 验收）。
> 用途：编码侧实作完成后**逐步实测**用；本清单只描述"跑什么、断言在哪、怎么清"，**不重复设计**。

---

## 1. 开工前置（环境，非缺陷）

| # | 前置 | 为什么 |
|---|---|---|
| 1 | Node **v22.19.0**（`export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"`） | 否则 `better-sqlite3` 可能不可用 ⇒ `getDb()` 返回 null（design F1）⇒ **静默降级 ⇒ 假绿** |
| 2 | 必要时 `npm rebuild better-sqlite3` | 本机环境既有前置（s0-s2 review 记录在案） |
| 3 | `npm test` / `npm run typecheck:baseline` 先跑一遍基线 | 确认起点（当前全量 16 files / 247、`PASS — 55`） |

**铁律（防假绿）**：任何"绿"都必须带**正向证据**（行数 ≥1、退出码、字段值），
不接受"没报错 = 通过"。SQLite 落库断言一律**直查表**（照 S4 冒烟：测试自带落地断言）。

---

## 2. 开启 checklist（按序执行）

- [ ] **C1 DDL additive 生效**：起 proxy 后
      `SELECT name FROM sqlite_master WHERE name IN ('attribution_judge_queue','attribution_judgement_details');`
      → 2 行；且 `SCHEMA_VERSION` 仍为 1（design F3）
- [ ] **C2 缺省 off 零访问**：不配任何 `attribution.judge.*` 起 proxy + 打 1 次真实请求
      → 两张表 **0 行**、无 `[attribution-judge]` 日志、v1 足迹与开 toggle 前逐项相同（design §6 步 6）
- [ ] **C3 入队（三跳第 1 跳）**：`attribution.judge.enqueue=true` + `decisionUnitExtractor.enabled=true`
      + `injectors: ["knowledge"]`（保证 injection pipeline 真跑，S4 勘正口径）
      → 打 1 次真实请求 → `SELECT status, COUNT(*) FROM attribution_judge_queue GROUP BY status;`
      → **`pending ≥ 1`**（正向证据）
- [ ] **C4 消费（第 2 跳）**：`npm run worker:attribution -- --config <yaml> --once`
      → 退出码 0；`SELECT COUNT(*) FROM attribution_judgement_details;` → **恰好 1 行**；
      且 `judge_impl='mock:v1'`、`prompt_sha256` 非空且 == `sha256(JUDGE_PROMPT_V1.text)`
- [ ] **C5 幂等（第 3 跳，红线 8）**：再跑一次 `--once`
      → 判定明细**不增行**；队列该行 `status='done'`；日志出现幂等命中（info 级，非错误）
- [ ] **C6 死信纪律**：构造一条必然失败的消费（`MockJudgeScript` 抛错）跑满 `maxAttempts`
      → `status='failed'` + `last_error` 非空；再跑 `--once` **不动**它；`--retry-failed` 才复位
- [ ] **C7 租约恢复**：手改 `UPDATE attribution_judge_queue SET lease_expires_ms=0 WHERE status='processing';`
      → 再跑 `--once` 能重新认领并完成（僵尸行自动回收）
- [ ] **C8 golden**：`judge-golden.test.ts` 绿；**故意改一个字 prompt** → 必须**红**（门禁非空转），改回 → 绿
- [ ] **C9 引用日志**：`PROXY_DATA_DIR` 下 `attribution-judge.log` 每次消费 1 行；字段最小集齐
      （`log_id/generation_id/layer/status/prompt_ref/input_refs/output_refs/latency_ms`）
- [ ] **C10 回归**：`npm test` 全量数字 ≥ 基线且**新增用例全绿**；`typecheck:baseline` → `PASS — 55`；
      `git status` **生产语义零改动**（只有新文件 + additive DDL）
- [ ] **C11 基座-c 上移零漂移**（design §4.8.1 / T26）：`visible-archive-golden` + `visible-archive-http-smoke`
      **复跑逐字节绿**；`src/injection/__tests__/_helpers/attribution-window.ts` 只剩 **re-export**（防两份实现并存）
- [ ] **C12 删字节审计**（T18/T19/T20）：`stripRenderWrappers` 对 render-golden 四 case 的 `removed[]` **全部有模板认领**；
      反例必须原样保留 —— 正文首行 `1. something`、正文含 `</knowledge_tools>` 字面量
- [ ] **C13 稀有度表确定性**（T21/T22）：同语料两次 `tableSha256` 相同；**打乱语料输入顺序仍相同**；改 `n` 则变；
      超 `cap` 时 `corpusRows.capped=true`
- [ ] **C14 c-4 只读**（T25）：跑 `sessionWindow` / `sessionAssetTexts` / `rarityTable` 后写计数全 0、`readWatermark` 不变

---

## 3. 组合矩阵（期望）

| # | `judge.enqueue` | worker | DB 可用 | 期望 |
|---|---|---|---|---|
| 1 | false（缺省） | 不启 | 是 | 队列 0 行；决策/归档足迹照常（**零回归**） |
| 2 | true | 不启 | 是 | 队列 `pending ≥ 1` 累积；判定明细 0 行；proxy 响应不受影响 |
| 3 | true | `--once` | 是 | 三跳闭合：`pending` → `done` + 明细 1 行（**主验收**） |
| 4 | true | `--once` ×2 | 是 | 第 2 次**不增行**（幂等命中） |
| 5 | true | 不启 | **否**（`getDb()` null） | 入队静默降级、不抛；proxy 照常服务 |
| 6 | true | `--once` | **否** | worker 退出码 0（或明确报错），**不**挂死、不伪造成功 |
| 7 | true | `--retry-failed` | 是 | 仅 `failed` 行复位为 `pending`；`done` 行不被翻动 |

**注意**：矩阵 5/6 是**降级路径**，断言的是"不抛 + 不伪造"，不是"有数据"。

---

## 4. DB 清理 SQL（照 10 spec §10 档位姿势）

```sql
-- 档位 1：整表清空（重跑冒烟前必做）
DELETE FROM attribution_judge_queue;
DELETE FROM attribution_judgement_details;

-- 档位 1b：整表复位（结构靠 IF NOT EXISTS 在下次 getDb() 自动重建）
DROP TABLE attribution_judge_queue;
DROP TABLE attribution_judgement_details;

-- 档位 2：只清某会话
DELETE FROM attribution_judge_queue      WHERE session_key = '<session-key>';
DELETE FROM attribution_judgement_details WHERE session_key = '<session-key>';

-- 档位 3：死信复位（等价 --retry-failed 的 SQL 版）
UPDATE attribution_judge_queue
   SET status='pending', attempts=0, last_error=NULL, lease_owner=NULL, lease_expires_ms=NULL
 WHERE status='failed';

-- 档位 4：只收僵尸租约（worker 被 kill 后）
UPDATE attribution_judge_queue
   SET status='pending', lease_owner=NULL, lease_expires_ms=NULL
 WHERE status='processing'
   AND lease_expires_ms < (strftime('%s','now') * 1000);   -- 时间戳单位 = 毫秒

-- 清前留证：先看分布再删
SELECT status, COUNT(*) FROM attribution_judge_queue GROUP BY status;
```

要点：

- **清表 ≠ 清进程内水位线**（与 10 spec §10 同源精神）：`decision-unit-runner` 的水位是**进程内 Map**
  （design F14）⇒ 只清表**不重启 proxy**，runner 会认为该批消息已密封过而**不再入队** ⇒ 队列恒 0 行。
  **彻底重来 = 清表 + 重启 proxy**（或走测试 reset）。
- 队列/明细都是**可重建的派生物**（v1 纪律：状态 = 可由全窗口重放重建的缓存）⇒ 本地清表零数据风险。
- 单位是**毫秒**（与 `created_at/updated_at/lease_expires_ms` 一致）；用 `strftime('%s','now')*1000` 别写成秒。

---

## 5. 交接验收表（编码侧回填）

| 项 | 期望 | 实测 | 证据 |
|---|---|---|---|
| 新增单测 T1–T15（三跳骨架，design §5） | 全绿 | | |
| 新增单测 T16–T27（基座-c，design §4.8/§5） | 全绿（含 T18 删字节审计、T20 反例、T21 确定性） | | |
| 基座-c 接口形状 | **只返回数字/数组**，无布尔判定（T24） | | |
| P0 两套装置（上移后复跑） | 逐字节绿（T26 / C11） | | 命令 + 输出 |
| `npm test` 全量 | ≥ 16 files / 247 + 新增 | | |
| `npm run typecheck:baseline` | `PASS — 55`（触达文件零新增） | | |
| 三跳冒烟（design §6 步 1–4） | 入队 ≥1 → 消费 1 行 → 再跑不增行 | | 证据文件路径 |
| 缺省 off 回归（§6 步 6） | 队列 0 行、其余逐项相同 | | |
| 生产语义改动 | **0**（新文件 + additive DDL 除外） | | `git status` / `git diff` |
| golden 门禁 | 改 prompt 必红（已变异验证并还原） | | |
| 文档待办 M2（design §9） | 00 spec §1 L21-22 / §9 L135 + handoff §2 L55 三处勘正 | | |

---

## 6. 风险复看点（评审时优先看这几处）

1. **R1 假绿**：三跳断言里有没有"0 行也通过"的路径？（尤其 C3 与 C4 必须**正向计数**）
2. **R2 NULL 唯一键**：幂等是否**真的**由确定性主键承担？有没有把 `UNIQUE(unit_id, asset_id, round)` 当成主判据？
3. **R3 重复副作用**：租约过期重认领后，真 provider（50 spec 起）会**重复花钱** —— `attempts` 与死信是否正确可见？
4. **R4/R5 锁与僵尸**：单轮事务是否够短？`busy_timeout=2000`（F2）下的退避是否实现？
5. **R6 golden 空洞**：有没有把"mock 绿"讲成"判定链已验"？（诚实口径：基座只锁 prompt bytes + mock verdict 序列）
6. **触发耦合**：入队是否**绝不** throw 回 runner？（否则判定基建故障会打挂用户请求）
7. **R8 剥离过度（基座-c）**：`list-prefix` 类模板有没有**上下文守卫**？反例 golden（正文首行 `1. `、正文含 `</knowledge_tools>`）在不在？（T20）
8. **上移漂移（基座-c）**：`visible-text.ts` 上移后 P0 两套装置是**复跑过**还是"应该没影响"？`attribution-window.ts` 是否只剩 re-export？（F31 的"只能有一份实现"警告是否仍有效）

---

## 7. 与已闭验收的关系

| 前序验收 | 状态 | 基座动作 |
|---|---|---|
| P0（40 spec）§8 五条 | 已闭（等价层 + S4 真 HTTP 冒烟） | 基座-a/b 只**读**其产物（`attribution_block_text` 等）；**基座-c 例外**：需把 `attribution-window.ts` 的口径**上移**到生产模块（唯一触碰点，由 T26 / C11 锁） |
| v1 S0–S3（10/15/20/30 spec） | 已闭（247/247 全量、`PASS — 55`） | **零改动**；基座只在 runner 落库后**追加**一次入队调用（fire-and-forget） |
| S4 冒烟装置（`_helpers/s4-stubs.ts`） | 已在 | **复用**起真 proxy 的姿势（端口纪律见 s4 checklist §1-§2） |
| P0 的 `excluded` 清单承诺 | **未落地**（40 spec §5 L164；缺口登记见 design §8.3） | 本期**不做选择**；c-4 接口先留位（`excludedCategories()` 可先返回 `[]` + TODO 指向 §8.3） |

---

## 处理记录（编码侧回传，正文不改）

（待回传）
