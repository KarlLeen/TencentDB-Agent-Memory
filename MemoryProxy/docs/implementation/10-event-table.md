# S1 Spec — 事件表 schema + SQLite repo

> 隶属：[00-master-spec.md](./00-master-spec.md) 的切片 S1。本 spec 只覆盖"事件表 + repo"，
> 每类事件的 payload 结构归各自的生产者 spec 定（S2 生命周期行、S3 决策单元行）。
> 实现仓库分支：`feature/attribution-event-capture`。

## 1. 目标

在 MemoryProxy 本地 SQLite 中落一张 `attribution_events` 事件表，作为捕获链路（S1-S3）的
统一落点：**先有接收端，生产者（EventObserver/抽取器）再往这里写**。S1 本身无行为、
无风险：表建好后没人写、没人读，等于不存在。

## 2. 非目标（明确不做）

- 不做任何事件消费/查询 UI（v2 信用分、S7 回执再读）。
- 不改 SCHEMA_VERSION 迁移机制：见 §5.1 的取舍说明。
- 不定义 payload 语义字段（每类事件的 payload JSON 结构由 S2/S3 spec 定）。
- 不自造资产命名空间：事件的 `asset_id` 必须回指可经现有 meta/knowledge/skill/tdai client
  回查的真实资产，契约见 §4.1。

## 3. 已精读的源码锚点（风格来源，改前不必再读整文件）

- `MemoryProxy/src/db/schema.ts`：`SCHEMA_SQL` 纯 `IF NOT EXISTS` 追加式；`meta` 表存
  `schema_version`；现表 `sessions` / `hook_cache`；当前 `SCHEMA_VERSION = 1`。
- `MemoryProxy/src/db/index.ts`：
  - `getDb()` 单例（better-sqlite3 同步加载，PRAGMA WAL/foreign_keys/busy_timeout）。
  - `runSchema()` 每次启动 `db.exec(SCHEMA_SQL)`；`schema_version` 仅当 meta 无此 key 时插入。
  - 初始化失败不致命 → `getDb()` 返回 null → repo 层退化为 Null。
- `MemoryProxy/src/db/sessionRepo.ts`、`hookCacheRepo.ts`（repo 模板，必须照抄的纪律）：
  - **接口层**：`interface XRepo`（方法签名带注释语义：upsert/get 是否 write-through 等）。
  - **实现层**：`class SqliteXRepo`，构造器收 `db`、把所有 SQL 预编译为 `private xxxStmt`。
  - **降级层**：`class NullXRepo` 静默 no-op（写失败不 throw、读返回 null/[]）。
  - **单例层**：模块级 `_repo` + `getXRepo()`（`db ? Sqlite : Null`）+ `setXRepo()`（多后端替换）+ `__resetXRepoForTests()`。
  - 同步 API 用 async 签名包裹仅为对齐跨节点后端契约；本 repo 是纯本地 SQLite。

## 4. DDL 提案（进 `schema.ts` 的 `SCHEMA_SQL` 尾部）

### 4.1 真实资产匹配契约（先于 DDL，防语义漂移）

事件里出现的 `asset_id` **不是本系统自造的键**，必须回指资产体系里的真实实体、且能被现有
client 回查：

- **身份来源**（S0 已核实）：meta 资产目录 `/v3/meta/asset/list-accessible`
  （`AccessibleAssetItem.asset_id`，含 `version` 字段）+ 各产资产 injector 现在手里已有的 id：
  - `skill`：`asset_id === skill_id`（meta 约定，见 skill-bridge.ts:434）；
  - `llm_wiki` / `code_graph`：`asset_id === knowledge_id`（knowledge-tools-injector 的
    per-agent 绑定路径，render 出的 `<knowledge ... id="{knowledge_id}">`）；
  - `chat_memory`：复合 id `chat_memory-{teamId}-agt{agentId}`（tdai-fixed-asset 的解析路径）。
- **可回查性**：v2 消费端（corrected 规则 / 信用分 / 回执）要拿事件里的 `asset_id` 经
  `meta/client.ts` / `knowledge/core-client.ts` 重新取到资产本体（content、version、status）。
  取不到 = 事件降级为不可解析，绝不用事件侧自造名充数。
- **捕获侧怎么做**（S0/S2 的活，本 spec 只定契约）：注入时产资产 block 带结构化
  `metadata.assets: Array<{assetId, assetType}>`；事件落库时把它摊到 `asset_id` + `asset_type`
  过滤列。**v1 生命周期事件就带真实资产维度，不再是"多为 NULL"**（S0 折叠进 v1，见 00-master-spec §8.3）。

```sql
CREATE TABLE IF NOT EXISTS attribution_events (
  event_id     TEXT PRIMARY KEY,   -- uuid v4（node:crypto randomUUID）
  space_id     TEXT,               -- 权限/回执过滤段，缺省写 "_default"（与 sessionRowId 兜底一致）
  user_id      TEXT,
  agent_source TEXT,               -- codebuddy / claude-code / ...
  session_key  TEXT NOT NULL,      -- 会话隔离键（同 anthropicHandler resolveSessionKey）
  turn_seq     INTEGER,            -- 轮次；同 observer metadata.turnSeq 口径，类型事件可空
  msg_seq      INTEGER,            -- 决策单元首条消息下标（S3 幂等用），非决策事件为 NULL
  event_type   TEXT NOT NULL,      -- v1 词汇表见 00-master-spec §3
  asset_id     TEXT,               -- 真实资产外部 id（§4.1 契约：skill_id / knowledge_id / chat_memory- 复合 id）
  asset_type   TEXT,               -- skill / llm_wiki / code_graph / chat_memory
  unit_id      TEXT,               -- 决策单元 id（S3 写）
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL    -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_ae_session_time ON attribution_events(session_key, created_at);
CREATE INDEX IF NOT EXISTS idx_ae_asset   ON attribution_events(asset_id);
CREATE INDEX IF NOT EXISTS idx_ae_unit    ON attribution_events(unit_id);
CREATE INDEX IF NOT EXISTS idx_ae_type    ON attribution_events(event_type);

-- S3 幂等锚：同一 (session_key, turn_seq, msg_seq) 只允许一条决策单元事件。
-- partial index（WHERE msg_seq IS NOT NULL）让非决策事件（msg_seq=NULL）不受约束。
CREATE UNIQUE INDEX IF NOT EXISTS idx_ae_unit_dedupe
  ON attribution_events(session_key, turn_seq, msg_seq)
  WHERE msg_seq IS NOT NULL;
```

设计取舍（写死，防返工）：

- **payload 归一列 + 少量过滤列**：延续 `sessions.state_json` / `hook_cache.blocks_json`
  的 JSON blob 风格。设计文档 §3.2 的完整事件对象（decision_unit、references、verdict 等）
  原样进 payload_json；`asset_id`/`asset_type`/`unit_id`/`msg_seq` 抽出来只为查索引，不反范式。
- **session_key 为键而非复合身份键**：事件本质跟随会话；`space_id`/`user_id` 仅作
  未来回执 ACL 过滤段。空间隔离的空段兜底用 `_default`，与 `sessionRowId` 一致。
- **幂等靠 partial unique index 而不是先查后插**：S3 抽取是"每请求增量 + 崩溃可能重放"，
  唯一索引保证重放安全；冲突插入由 repo 静默吞掉（见 §5.2）。
- **一个事件行只挂一个 (asset_id, asset_type)**：一个 block 内含多条资产（如
  `<knowledge_tools>` 一次渲染 N 个资源）时，由 S2 摊成多行事件（每行同 unit/session、
  不同 asset），不把数组塞进过滤列；payload 里保留整块摘要。

## 4.2 命名占用检查

block 上已占用键：`metadata.source`、`metadata.cacheKey`（hookCache 去重用）、
`metadata.tool_name`。我们的新键 `metadata.assets` 不冲突（00-master-spec §3 记录）。

## 5. 改动清单

### 5.1 `src/db/schema.ts`

把 §4 DDL 追加到 `SCHEMA_SQL` 尾部。**保持 `SCHEMA_VERSION = 1` 不动**——
现有 `runSchema` 只在 meta 缺行时写版本、没有迁移器；本表是纯追加 DDL（`IF NOT EXISTS`
每次启动幂等），不需要版本号语义。未来某切片要改**已有表**时，再在 schema.ts 引入真正的
迁移机制（那是另一个 spec 的事）。此决定记录在代码注释里，防止后人困惑。

### 5.2 新文件 `src/db/attributionEventRepo.ts`

照 `hookCacheRepo.ts` 模板，命名契约见 00-master-spec §3（`attribution-` 前缀）。

接口与实现要点：

```ts
export interface NewAttributionEvent {
  spaceId?: string;      // 缺省 "_default"
  userId?: string;
  agentSource?: string;
  sessionKey: string;
  turnSeq?: number | null;
  msgSeq?: number | null;
  eventType: string;
  assetId?: string | null;   // 真实资产外部 id（§4.1），无法解析时省略
  assetType?: string | null; // skill / llm_wiki / code_graph / chat_memory
  unitId?: string | null;
  payload: unknown;      // JSON.stringify 存 payload_json
}

export interface AttributionEventRepo {
  /** 追加单条。event_id 由实现生成（randomUUID）。写失败静默降级（console.warn）。 */
  append(e: NewAttributionEvent): void;
  /** 批量追加（事务），供 S3 一轮多单元一次性落库。冲突行静默跳过。 */
  appendMany(events: NewAttributionEvent[]): void;
  /** 按会话倒序取事件，供调试/冒烟断言（v2 消费端另立查询）。 */
  listBySession(sessionKey: string, opts?: { eventType?: string; limit?: number }): AttributionEventRow[];
  /** 按真实资产维度取事件（v1 S0/S2 填充后即有数据）。 */
  listByAsset(assetId: string, opts?: { limit?: number }): AttributionEventRow[];
}
```

实现注意：

- 构造器预编译全部语句；`appendMany` 用 `this.db.transaction(...)`（同 `putMany`）。
- 唯一索引冲突（`idx_ae_unit_dedupe`）在 SQLite 抛 `SQLITE_CONSTRAINT` → catch 后
  **`console.info`** 一次（幂等重放是**预期路径**，v1.1 起 dedupe 冲突降 info 级，
  真实失败才 `console.warn`；不打断写路径）。
- **v1.1 观测补丁（S3 二轮评审 R1，2026-09-09）**：本 repo 追加
  `AttributionWriteCounters { appended; dedupeConflicts; failures }` +
  `getAttributionWriteCounters()`（`append`/`appendMany` 成功、冲突、失败分别计数，
  清零挂在 `__resetAttributionEventRepoForTests`）。详见 30-decision-unit-extractor.md
  §4.10 / §5.6（观测者 = S3 开启 checklist，11.1）。接口行为零变化：仍静默降级不 throw。
- `listBySession` 返回 snake_case 行接口 `AttributionEventRow`，payload_json 解给调用方
  （与 repo 层不解业务对象的既有风格一致；调用方要对象自己 parse）。
- Null/单例/get/set/__reset 五件套与 `hookCacheRepo.ts` 完全同构。
- **新表不需要在 `injection/index.ts` 或任何装配点注册**：schema 在 `getDb()` 初始化时
  自动建表，repo 由 S0/S2/S3 的生产者在构造处 `getAttributionEventRepo()` 惰性取用。

## 6. 测试

- 新表建表 + 幂等：临时 `PROXY_DB_PATH` 指向测试目录，`getDb()` 两次建表不炸。
- repo CRUD：append → listBySession 回读断言字段（含 asset_type）；appendMany 事务语义。
- **幂等锚点测试（重点）**：同 (sessionKey, turnSeq, msgSeq) 写两次 → 第二次被吞、总数不变。
- **asset 维度测试**：两行同 session 不同 asset_id，`listByAsset` 各自回读正确。
- 降级：模拟 DB 不可用 → repo 走 Null、写调用不 throw。
- 参照现有 repo 的测试组织方式与 `__resetXRepoForTests` 用法补齐。

## 7. 真实会话冒烟

S1 无行为，真实会话演示不到——冒烟即"手插一行 → SELECT 断言"：
用一次 `attributionEventRepo.append({... assetId, assetType ...})` 写入，然后按 session_key
查回并核对 (columns, payload round-trip, created_at)。这一步跑通后，S0/S2/S3 才具备真实会话演示的接收端。

## 8. 验收清单（全部通过 = S1 完成）

- [x] schema.ts 追加 DDL；老库（无本表）启动后自动建表，不破坏 sessions/hook_cache。
  - 2026-09-08：DDL 已追加（含 `idx_ae_unit_dedupe` partial unique index），保持 `SCHEMA_VERSION = 1`
    （纯追加 DDL，理由见 §5.1）；单测验证建表幂等 + 索引存在。
- [x] attributionEventRepo.ts 五件套齐全，风格与 hookCacheRepo.ts 同构。
  - `getAttributionEventRepo` / `setAttributionEventRepo` / `__resetAttributionEventRepoForTests` /
    Sqlite/Null 双实现；`append` 冲突静默 warn、`appendMany` 事务内逐行跳过冲突（单事务不因一行重复回滚）。
- [x] append/appendMany/listBySession/listByAsset 单测通过，幂等冲突静默。
  - 11 个用例全绿（`src/db/__tests__/attribution-event-repo.test.ts`）。
- [x] §7 手插一行冒烟通过（含 asset_id + asset_type 回读）。
  - 2026-09-08 实跑：真实 SQLite 落库 → `listBySession` 回读
    `{event_type, asset_id: wiki-1vo353ux, asset_type: llm_wiki, space_id: _default}`，payload round-trip 一致，`SMOKE_ASSERT=PASS`。
- [x] 未接线任何生产者 → 运行行为与改前完全一致（零回归）。
  - 全量 vitest 40/40 通过（4 个文件）；`npm run typecheck` 仅剩基线既有错误
    （anthropicHandler/workbuddyHandler，本次未触碰，与 S1 无关）。
- [x] **v1.1 观测补丁（2026-09-09，S3 二轮评审 R1）**：`getAttributionWriteCounters()`
  + dedupe 冲突降 `console.info` / 真实失败才 `console.warn`；attribution-event-repo
  测试补 spy 断言（`warn` 不被调 + 计数吻合），repo 侧 13 用例全绿。接口行为零变化。

## 9. 开放问题

1. `msg_seq` 的精确含义（S3 用它做单元起始消息下标 + 幂等键）→ 由 `30-*.md` 拍板；
   本表只提供列与 partial index，不预判语义。
2. ~~`asset_id` 列 v1 是否被 S2 用到~~ → **已定**：S2 必须落真实资产维度（依赖 S0：产资产
   injector 附 `metadata.assets`，见 00-master-spec §8.3 与 §4.1）。事件无法解析到真实资产
   时必须显式缺省（asset_id NULL + payload 里标注 `asset_unresolved: reason`），不得伪造。
3. **保留策略 / 过期删除**：v1 契约是**表只增不删**（运行时 append-only + dedupe 跳过，
   绝无 delete 路径）。库被撑大后怎么办（按天分区归档、保留 N 天的清理任务等）属
   v2 S5 消费端的话题；v1 需要重置时按 §10 人工清理即可（本地 SQLite、崩溃重放可重建，
   零数据风险）。

## 10. 观测、DB 清理与运维说明（2026-09-09 v1.1 收编）

> 配套 30-decision-unit-extractor.md §11（S3 开启 checklist / 组合矩阵）。本表是
> `attribution_events` 的唯一属主，清理口径在此定。

**观测入口**：写路径计数 `getAttributionWriteCounters()`（§5.2，append/dedupe/failure
计数）；运行侧（S3 runner 统计、水位线）见 30 spec §4.10。`dedupeConflicts > 0` 是
崩溃重放**预期路径**（info 级），不是告警；`failures > 0` 才需人工介入。

**清理档位**（全部为运维动作；`DROP` 后无需手动重建 —— `runSchema()` 的 `IF NOT
EXISTS` 幂等 DDL 在下次 `getDb()` 初始化自动重建）：

```sql
-- 档位 1：整表清空（演示/开发库重置，最常见）
DELETE FROM attribution_events;
-- 档位 1b：整表复位（含表结构、索引随表重建）
DROP TABLE attribution_events;

-- 档位 2：只清某会话（重跑该会话冒烟；S2 injection.* 行同 session_key 一并删）
DELETE FROM attribution_events WHERE session_key = '<smoke-session-key>';

-- 档位 3：只清决策行（保留 S2 生命周期行，S3 重新抓）
DELETE FROM attribution_events WHERE event_type = 'decision_unit.created';

-- 清前留证：先看分布再删
SELECT event_type, COUNT(*) FROM attribution_events GROUP BY event_type;
```

要点：
- **清表 ≠ 清水位线**：S3 水位线是进程内"已见消息数"，清表后不重启的话下一请求可能
  认为旧消息已密封过而不补落。彻底重来 = 清表 + 重启进程（或测试 reset），见
  30 spec §11.3。
- 事件表无外键被引用（`meta`/`sessions`/`hook_cache` 不指向它），删除顺序无约束。
- v1 不引入任何自动清理/过期删除（见 §9 开放问题 3）；保留策略是 v2 消费端话题。
