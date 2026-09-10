# 共享基座（v2）开启 checklist / 组合矩阵 / DB 清理

> 配套：`attribution-base-design.md`（下称 design，§4 设计 / **§4.8 基座-c** / §5 单测 / §6 验收）。
> 用途：编码侧实作完成后**逐步实测**用；本清单只描述"跑什么、断言在哪、怎么清"，**不重复设计**。

---

## 1. 开工前置（环境，非缺陷）

| # | 前置 | 为什么 |
|---|---|---|
| 1 | Node **v22.19.0**（`export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"`） | 否则 `better-sqlite3` 可能不可用 ⇒ `getDb()` 返回 null（design F1）⇒ **静默降级 ⇒ 假绿** |
| 2 | 必要时 `npm rebuild better-sqlite3` | 本机环境既有前置（s0-s2 review 记录在案） |
| 3 | `npm test` / `npm run typecheck:baseline` 先跑一遍基线 | 确认起点（v1 基线 16 files / 247、`PASS — 55`；**基座-c 交付后 = 28 files / 364、`PASS — 55`**） |

**铁律（防假绿）**：任何"绿"都必须带**正向证据**（行数 ≥1、退出码、字段值），
不接受"没报错 = 通过"。SQLite 落库断言一律**直查表**（照 S4 冒烟：测试自带落地断言）。

---

## 2. 开启 checklist（按序执行）

- [x] **C1 DDL additive 生效**：起 proxy 后
      `SELECT name FROM sqlite_master WHERE name IN ('attribution_judge_queue','attribution_judgement_details');`
      → 2 行；且 `SCHEMA_VERSION` 仍为 1（design F3）
      —— ✅ 实测：`npx tsx` 临时脚本（用后即删）落临时库 →
      `tables: [{"name":"attribution_judge_queue"},{"name":"attribution_judgement_details"}]`、
      `SCHEMA_VERSION const: 1`、`meta.schema_version: 1`
- [x] **C2 缺省 off 零访问**：不配任何 `attribution.judge.*` 起 proxy + 打 1 次真实请求
      → 两张表 **0 行**、无 `[attribution-judge]` 日志、v1 足迹与开 toggle 前逐项相同（design §6 步 6）
      —— ✅ 实测（三跳冒烟第 4 例，`enqueue=false` 代理同库同请求）：
      `pending/processing/done/failed` **四种状态全 0**、该会话 details 0 行；
      **正向对照**：同一请求的档① 归档 ≥1 ⇒ 证明"零入队"不是"请求没走通"的假绿。
      ⚠️ 未断言项：「无 `[attribution-judge]` 日志」与「v1 足迹逐项相同」本装置**没覆盖**
      （前者由 C9 的"每次消费恰好 +1 行"从反面覆盖；后者需与开 toggle 前快照对比，留人工）
- [x] **C3 入队（三跳第 1 跳）**：`attribution.judge.enqueue=true` + `decisionUnitExtractor.enabled=true`
      + `injectors: ["knowledge"]`（保证 injection pipeline 真跑，S4 勘正口径）
      → 打 1 次真实请求 → `SELECT status, COUNT(*) FROM attribution_judge_queue GROUP BY status;`
      → **`pending ≥ 1`**（正向证据）
      —— ✅ 实测（三跳冒烟第 1 例）：`pending ≥ 1` + `payload.kind ∈ {code_change,key_tool_call,restraint}`
      + S2 `injection.hook.done` ≥ 1（注入面正向控制）。
      ⚠️ **口径偏差（有意）**：injectors 用 `["skill"]` 而非本行的 `["knowledge"]` ——
      写 `["knowledge"]` 时注入面被 `knowledge.enabled=false` 挡住（不产块 ⇒ 无 `visibleAssets`），
      `["skill"]` + kernel stub 才能真出渲染块（S4b 已证），对本条断言**更强**
- [x] **C4 消费（第 2 跳）**：`npm run worker:attribution -- --config <yaml> --once`
      → 退出码 0；`SELECT COUNT(*) FROM attribution_judgement_details;` → **恰好 1 行**；
      且 `judge_impl='mock:v1'`、`prompt_sha256` 非空且 == `sha256(JUDGE_PROMPT_V1.text)`
      —— ✅ 实测（三跳冒烟第 2 例，worker 是**真子进程**）：退出码 0；details **恰好 1 行**；
      `judge_impl='mock:v1'`；`prompt_sha256 === sha256Hex(ATTRIBUTION_JUDGE_PROMPT_V1.text)`；
      队列该行 `status='done'` 且 `unit_id` 与落点行一致（跨进程认领对得上）
- [x] **C5 幂等（第 3 跳，红线 8）**：再跑一次 `--once`
      → 判定明细**不增行**；队列该行 `status='done'`；日志出现幂等命中（info 级，非错误）
      —— ✅ 实测（三跳冒烟第 3 例）：第二次 `--once` 明细**不增行**。
      ⚠️ **实测形态比本行期望更强**：第二次连**认领**都没发生（`done` 行不被再 claim）⇒
      引用日志也**零新增**，因此**看不到**"幂等命中"那行 —— 那行只在**租约重放**路径出现
      （正例在 `worker.test.ts:174-183`；主键级幂等在 `judgement-details-repo.test.ts:41-52` / R2 用例）
- [x] **C6 死信纪律**：构造一条必然失败的消费（`MockJudgeScript` 抛错）跑满 `maxAttempts`
      → `status='failed'` + `last_error` 非空；再跑 `--once` **不动**它；`--retry-failed` 才复位
      —— ✅ 实测（`judge-queue-repo.test.ts` T4 死信 + `worker.test.ts:86-101` `--retry-failed` **真入口**：
      死信复位并消费成功；不带 flag 时不动它、不增行）
- [x] **C7 租约恢复**：手改 `UPDATE attribution_judge_queue SET lease_expires_ms=0 WHERE status='processing';`
      → 再跑 `--once` 能重新认领并完成（僵尸行自动回收）
      —— ✅ 实测（`judge-queue-repo.test.ts` T3 租约恢复：未过期不可再认领；过期 1ms 即可被另一 owner
      再认领且 `attempts` 递增；边界 `lease_expires_ms == now` **不**算过期）
- [x] **C8 golden**：`judge-golden.test.ts` 绿；**故意改一个字 prompt** → 必须**红**（门禁非空转），改回 → 绿
      —— ❌→✅ **发现并修复了一处真空洞门禁**：原断言是
      `expect(snapshot.promptRef).toEqual({…字面量…})` = **快照与自己比**，根本没读活模板 ⇒
      改 prompt 文本**不会红**（违反本行 / R6）。已修为
      `expect(buildAttributionJudgePromptRef()).toEqual(snapshot.promptRef)` + 整文件重建改用**活** promptRef。
      变异验证：把 `"You are an attribution judge."` 末字改成 `!` ⇒ **2 例红**（逐字节比 + 活模板比）；
      还原后绿；`git diff judge-prompt.ts` **为空** ⇒ 已完全还原
- [x] **C9 引用日志**：`PROXY_DATA_DIR` 下 `attribution-judge.log` 每次消费 1 行；字段最小集齐
      （`log_id/generation_id/layer/status/prompt_ref/input_refs/output_refs/latency_ms`）
      —— ✅ 实测（三跳冒烟第 2 例）：本次消费**恰好 +1 行**；8 个最小字段全在；
      `layer='attribution_judge'`、`status='ok'`、`generation_id == 落点行 judgement_id`
      （子进程退出前 flush，`spawnSync` 返回后即可读）
- [x] **C10 回归**：`npm test` 全量数字 ≥ 基线且**新增用例全绿**；`typecheck:baseline` → `PASS — 55`；
      `git status` **生产语义零改动**（只有新文件 + additive DDL）
      —— ✅ 实测：`Test Files 28 passed / Tests 364 passed`（基线 16 files / 247）；
      `tsc-baseline: PASS — 55 errors, all within allow-list`；
      `git status` 待提交项 = **1 个改测试 + 1 个新测试**，生产代码零改动
- [x] **C11 基座-c 上移零漂移**（design §4.8.1 / T26）：`visible-archive-golden` + `visible-archive-http-smoke`
      **复跑逐字节绿**；`src/injection/__tests__/_helpers/attribution-window.ts` 只剩 **re-export**（防两份实现并存）
      —— ✅ 实测：`visible-archive-golden` **5 passed** + `visible-archive-http-smoke` **10 passed**
      （两者均含逐字节断言）；`attribution-window.ts` 仅 re-export，T26 用 `Object.is` 断言"同一份实现"
- [x] **C12 删字节审计**（T18/T19/T20）：`stripRenderWrappers` 对 render-golden 四 case 的 `removed[]` **全部有模板认领**；
      反例必须原样保留 —— 正文首行 `1. something`、正文含 `</knowledge_tools>` 字面量
      —— ✅ 实测：`wrapper-registry.test.ts` **27 passed**（含 T18 每段被删字节必须由传入表内模板**整段**认领、
      T19 幂等、T20 R8 反例、T27 四 case 模板覆盖逐 case 对账）
- [x] **C13 稀有度表确定性**（T21/T22）：同语料两次 `tableSha256` 相同；**打乱语料输入顺序仍相同**；改 `n` 则变；
      超 `cap` 时 `corpusRows.capped=true`
      —— ✅ 实测：`ngram.test.ts` **22 passed**（T21 确定性 / 顺序无关 / 换 n 必变 / corpusRows 入哈希；
      T22 cap 与 `capped` 上报；T23 df/idf 手算对账；T24 哨兵边界）
- [x] **C14 c-4 只读**（T25）：跑 `sessionWindow` / `sessionAssetTexts` / `rarityTable` 后写计数全 0、`readWatermark` 不变
      —— ✅ 实测：`source.test.ts` **11 passed**（T25 用 **真临时 sqlite 库**跑：写计数增量 0、
      水位不变、`sqlite_master` 表清单不变；T17 另证 `content_utf8` 经 repo 与直接 SQL 两路逐字节不变）

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

**实测（本轮）**：行 **1/2/3/4/7** 有证据 —— 行 1+2 由三跳冒烟的 C2 负例覆盖（`enqueue=false` ⇒ 入队侧零访问、
但归档/响应照常）；行 3/4 由三跳冒烟正例覆盖（含"第 2 次连认领都不发生"这一更强形态）；
行 7 由 `worker.test.ts:86-101` 的 `--retry-failed` 真入口覆盖。
行 **5/6（DB 不可用降级）本轮未实测** —— 需人为让 `getDb()` 返回 null（Node 版本/rebuild 前置），
属"未被负面证据覆盖"的缺口，登记在此，留给下一轮或 50 spec 起真 provider 时一并补。

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
| 新增单测 T1–T15（三跳骨架，design §5） | 全绿 | ✅ **36 passed / 6 files**（judge 6 + judgement-details 5 + worker 10 + judge-queue 7 + judge-golden 3 + enqueue-wiring 5） | `npx vitest run src/attribution` |
| 新增单测 T16–T27（基座-c，design §4.8/§5） | 全绿（含 T18 删字节审计、T20 反例、T21 确定性） | ✅ **77 passed / 5 files**（normalize 13 + wrapper-registry 27 + ngram 22 + source 11 + visible-text 4） | `npx vitest run src/attribution/citation` |
| 基座-c 接口形状 | **只返回数字/数组**，无布尔判定（T24） | ✅ `gramCoverage` 键恰 `{coverage,covered,distinct,n}` 且全 number；`describeMatchLevel` 恰 `{level,ops}`；"无依据"走 `NaN` 哨兵 | `ngram.test.ts` / `normalize.test.ts` |
| P0 两套装置（上移后复跑） | 逐字节绿（T26 / C11） | ✅ golden **5** + http-smoke **10** = **15 passed**（零改动复跑） | `npx vitest run src/injection/__tests__/visible-archive-{golden,http-smoke}.test.ts` |
| `npm test` 全量 | ≥ 16 files / 247 + 新增 | ✅ **28 files / 364 passed**（0 fail） | `npm test` |
| `npm run typecheck:baseline` | `PASS — 55`（触达文件零新增） | ✅ `tsc-baseline: PASS — 55 errors, all within allow-list` | `npm run typecheck:baseline` |
| 三跳冒烟（design §6 步 1–4） | 入队 ≥1 → 消费 1 行 → 再跑不增行 | ✅ **4 tests passed**；真 HTTP 入队 ≥1 → **真 worker 子进程**消费**恰好 1 行** → 再跑不增行；另含 C2 负例与 C9 日志 | `src/attribution/__tests__/base-three-hop-smoke.test.ts`（装置即证据，可复跑） |
| 缺省 off 回归（§6 步 6） | 队列 0 行、其余逐项相同 | ✅ 队列四状态全 0 + details 0；同请求档① ≥1（正向对照）。⚠️ "v1 足迹逐项相同"未做（见 C2 注） | `base-three-hop-smoke.test.ts` 第 4 例 |
| 生产语义改动 | **0**（新文件 + additive DDL 除外） | ✅ 待提交项 = 1 改测试 + 1 新测试；生产代码 `git diff` 为空 | `git status` / `git diff --stat` |
| golden 门禁 | 改 prompt 必红（已变异验证并还原） | ✅ **修复后**验证：改 `"…judge."`→`"…judge!"` ⇒ **2 例红**；还原 ⇒ 绿、diff 空 | `judge-golden.test.ts`（原断言为空转，已修，见 C8） |
| 文档待办 M2（design §9） | 00 spec §1 L21-22 / §9 L135 + handoff §2 L55 三处勘正 | ✅ 三处已勘正（随基座-c 文档轮落地） | `git log --oneline`（docs commit ① ） |

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

### 2026-09-10 · 基座-c 交付 + 验收回填

**交付物**（全部 `Signed-off-by`，逐逻辑分 commit）

| 步 | 内容 | 文件 |
|---|---|---|
| ③ | 口径**上移**（§4.8.1）：`SEAM_GLUE` / `visibleTextOfPiece` / `restoredVisibleText` 从测试 helper 移到生产模块；helper 只剩 re-export | `src/attribution/citation/visible-text.ts`（新）、`injection/__tests__/_helpers/attribution-window.ts`（改） |
| c-1 | 三级 `MatchLevel` + **显式**标点表（**明确不用 NFKC**：改动面不可枚举 = 漂移源） | `citation/normalize.ts` |
| c-2 | 渲染包装剥离：模板表 + **可审计 `removed[]`**（每段被删字节必须由表内模板**整段认领**）+ R8 四类防过度剥离 | `citation/wrapper-registry.ts` |
| c-3 | 区分性 char n-gram + 稀有度表（df 口径、`tableSha256` 可复现、`NaN` 哨兵区分"合法 0"与"无依据"） | `citation/ngram.ts` |
| c-4 | 排他性检查**输入源**（全局语料读口 + 会话窗口/资产文本/稀有度表；**只读取数、不判定**） | `citation/corpus-repo.ts`、`citation/source.ts` |
| — | 三跳冒烟装置（本条目的主证据） | `attribution/__tests__/base-three-hop-smoke.test.ts`（新） |

**门禁数字**：`npm test` **28 files / 364 passed**｜`typecheck:baseline` **PASS — 55**｜
P0 两套装置复跑 **15 passed**｜归属子树 **117 tests / 12 files**。

**本轮发现并修掉的真实缺陷（1 个）**

- **C8 空洞门禁**：`judge-golden.test.ts` 原断言是 `expect(snapshot.promptRef).toEqual({…字面量…})`
  —— 快照与自己比，**从未读活模板** ⇒ 改一个字的 prompt 完全不会红（正是 R6 警告的"把 mock 绿讲成链已验"）。
  已改为活模板 vs 快照 + 整文件重建用活 `promptRef`；变异验证（改字 → 2 例红 → 还原 → 绿 → `git diff` 空）通过。
  **这是本轮唯一的生产/门禁语义改动，且只动测试。**

**留给后续的缺口（明确不假装已验）**

1. **`excluded` 清单**仍未落地（40 spec §5 L164）：`windowVisibleText()` 不带 excluded 字段，
   c-4 以 `excludedCategories()` **留位返回 `[]`**；缺口与两种处置见 design **§8.3**，本期**不做选择**。
2. **矩阵 5/6（DB 不可用降级）未实测**（见 §3 注）。
3. **C2 的两条附加期望未覆盖**："无 `[attribution-judge]` 日志"（由 C9 从反面覆盖）、
   "v1 足迹与开 toggle 前逐项相同"（需前快照对比，留人工）。
4. **判定位未接线**：`match_level` / `ngram_table_sha256` / `coverage` 的**出参**已在 c-1/c-3 就绪、
   落 `detail_json` 的**形状**已由 T17 用例演示，但**真实判定链**（谁判定、阈值多少）属 50 spec，基座不接。
5. **三跳冒烟是 mock judge**：只锁"跨进程闭环 + 落点形状 + 幂等 + 日志字段"，
   **不含任何归因正确性**（R6 诚实口径）。

**未改**：P0 已闭验收物（`visibleTextRepo` 等）一行未改；生产语义零改动；DDL 纯 additive（`SCHEMA_VERSION` 仍 1）。
