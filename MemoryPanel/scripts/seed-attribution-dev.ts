/**
 * 76 · S7-c dev 夹具：为归因两页造样例数据（1 会话 × 5 单元）。
 *
 * ⚠️⚠️ **安全硬要求（勿删）**：本脚本**必须**在**显式临时库**上运行；
 *   **严禁**在默认库（`~/.tdai-memory-proxy/proxy.db`）上运行——
 *   `assertSafeTarget()` 会**显式拒绝**（R4 反向控制专门钉这条）。
 *
 * 用法：
 *   tsx scripts/seed-attribution-dev.ts                 # 自动临时库（打印路径）
 *   tsx scripts/seed-attribution-dev.ts --db /tmp/xx/proxy.db
 *
 * 前置：目标库需已由 proxy/worker 初始化过 schema（本脚本**不建表**——DDL 属
 * MemoryProxy，重复一份必漂移）；缺表 ⇒ 明确报错并给指引。
 *
 * 接线：让一个 proxy 实例使用同一库（`PROXY_DB_PATH=<该路径>`），再把面板的
 * `ATTRIBUTION_PROXY_BASE_URL` 指向它、配好 `ATTRIBUTION_PROXY_ADMIN_KEY`，
 * 即可在「归因回执 / 抽查池」两页看到样例数据。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

export function defaultDbPath(): string {
  return path.join(os.homedir(), '.tdai-memory-proxy', 'proxy.db');
}

/** 守卫：拒绝默认真实库（**R4 反向控制钉点**——删掉本检查即测试必红）。 */
export function assertSafeTarget(dbPath: string): string {
  const resolved = path.resolve(dbPath);
  if (resolved === path.resolve(defaultDbPath())) {
    throw new Error(
      `[seed-guard] 拒绝在默认真实库上运行：${resolved}。` +
        `请显式传 --db <临时库路径>（或省略 --db 使用自动临时库）。`,
    );
  }
  return resolved;
}

function sha12(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex').slice(0, 12);
}

const REQUIRED_TABLES = [
  'attribution_events',
  'attribution_judgement_details',
  'attribution_status_events',
  'attribution_judge_queue',
];

export interface SeedResult {
  dbPath: string;
  sessionKey: string;
  counts: Record<string, number>;
}

export function seed(dbPath: string): SeedResult {
  const resolved = assertSafeTarget(dbPath);
  const db = new Database(resolved);
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    const missing = REQUIRED_TABLES.filter((t) => !names.includes(t));
    if (missing.length > 0) {
      throw new Error(
        `[seed] 目标库缺表：${missing.join(', ')}——请先启动一次 proxy/worker（PROXY_DB_PATH=<该路径>）以初始化 schema。`,
      );
    }

    const now = Date.now();
    const sessionKey = 'dev-sess-attribution';
    const space = '_default';
    const assetId = 'dev-asset-1';

    const insEvent = db.prepare(
      `INSERT OR IGNORE INTO attribution_events
        (event_id, space_id, session_key, turn_seq, msg_seq, event_type, asset_id, asset_type, unit_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insJd = db.prepare(
      `INSERT OR IGNORE INTO attribution_judgement_details
        (judgement_id, unit_id, session_key, space_id, asset_id, asset_type, round, verdict, evidence_source_type, prompt_sha256, judge_impl, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insSe = db.prepare(
      `INSERT OR IGNORE INTO attribution_status_events
        (status_id, unit_id, session_key, space_id, asset_id, asset_type, round, event_type, outcome, turn_seq, msg_seq, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    );
    const insQ = db.prepare(
      `INSERT OR IGNORE INTO attribution_judge_queue
        (unit_id, round, session_key, space_id, trigger, payload_json, status, attempts, last_error, created_at, updated_at)
       VALUES (?, 0, ?, ?, 'decision_unit', '{}', 'failed', 3, 'dev fixture: simulated failure', ?, ?)`,
    );

    const units: Array<{ id: string; msg: number }> = [
      { id: 'du_dev_1', msg: 16 }, // confirmed + used
      { id: 'du_dev_2', msg: 32 }, // unconfirmed + 截断（overflowCount>0）
      { id: 'du_dev_3', msg: 48 }, // confirmed + used + corrected（v1→v2）
      { id: 'du_dev_4', msg: 64 }, // 死信（queue failed；无判定）
      { id: 'du_dev_5', msg: 80 }, // tombstone
    ];
    const run = db.transaction(() => {
      for (const [i, u] of units.entries()) {
        insEvent.run(
          `dev_ev_${u.id}`, space, sessionKey, 1, u.msg, 'decision_unit.created',
          null, null, u.id, JSON.stringify({ unitType: 'code_change' }), now + i * 10,
        );
      }
      const jd = (
        unitId: string,
        verdict: string,
        detail: Record<string, unknown>,
        asset: string | null,
        ts: number,
      ): void => {
        insJd.run(
          `jd_${sha12(`${unitId}|${asset ?? ''}|0`)}`, unitId, sessionKey, space, asset, asset ? 'skill' : null,
          0, verdict, asset ? 'injected' : null, 'dev-sha', 'mock:v1', JSON.stringify(detail), ts,
        );
      };
      const metrics = (coverage: number): Array<Record<string, unknown>> => [
        { assetId, matchLevel: 'exact', matchedTier: 'block', coverage, coverageDistinct: 1, coverageCovered: 1, exclusionCount: 0, ngramTableSha256: 'dev' },
      ];
      const shortlist = (overflowCount: number): Record<string, unknown> => ({ k: 1, total: 3, overflowCount, overflowAssetIds: [] });
      jd('du_dev_1', 'confirmed', { rationaleRef: 'dev:r1', candidateCount: 1, unitKind: 'code_change', shortlist: shortlist(0), citationMetrics: metrics(0.9) }, assetId, now);
      jd('du_dev_2', 'unconfirmed', { rationaleRef: 'dev:r2', candidateCount: 3, unitKind: 'code_change', shortlist: shortlist(2), citationMetrics: metrics(0.9) }, assetId, now + 1);
      jd('du_dev_3', 'confirmed', { rationaleRef: 'dev:r3', candidateCount: 1, unitKind: 'code_change', shortlist: shortlist(0), citationMetrics: metrics(0.9) }, assetId, now + 2);
      // du_dev_4 无判定（死信）
      jd('du_dev_5', 'unconfirmed', { rationaleRef: 'tombstone:result_missing', citationMetrics: [] }, null, now + 4);

      const usedId = `se_${sha12(`du_dev_1|${assetId}|0`)}`;
      insSe.run(usedId, 'du_dev_1', sessionKey, space, assetId, 'skill', 0, 'asset_used', null, JSON.stringify({ judgement_id: 'dev' }), now + 5);
      const usedId3 = `se_${sha12(`du_dev_3|${assetId}|0`)}`;
      insSe.run(usedId3, 'du_dev_3', sessionKey, space, assetId, 'skill', 0, 'asset_used', null, JSON.stringify({ judgement_id: 'dev' }), now + 6);
      const corrId = `se_${sha12(`du_dev_3|${assetId}|0|asset_corrected|version_drift`)}`;
      insSe.run(
        corrId, 'du_dev_3', sessionKey, space, assetId, 'skill', 0, 'asset_corrected', null,
        JSON.stringify({ used_status_id: usedId3, judgement_id: 'dev', correction_route: 'version_drift', anchored_version: 1, latest_version: 2, severity: 'signal' }),
        now + 7,
      );
      insQ.run('du_dev_4', sessionKey, space, now + 8, now + 9);
    });
    run();

    const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    const counts = {
      events: one("SELECT COUNT(*) AS n FROM attribution_events WHERE session_key = 'dev-sess-attribution'"),
      judgements: one("SELECT COUNT(*) AS n FROM attribution_judgement_details WHERE session_key = 'dev-sess-attribution'"),
      status_events: one("SELECT COUNT(*) AS n FROM attribution_status_events WHERE session_key = 'dev-sess-attribution'"),
      queue_failed: one("SELECT COUNT(*) AS n FROM attribution_judge_queue WHERE session_key = 'dev-sess-attribution' AND status = 'failed'"),
    };
    return { dbPath: resolved, sessionKey, counts };
  } finally {
    db.close();
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const dbFlag = args.indexOf('--db');
  let dbPath: string;
  let auto = false;
  if (dbFlag >= 0 && args[dbFlag + 1]) {
    dbPath = args[dbFlag + 1]!;
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdai-attribution-seed-'));
    dbPath = path.join(dir, 'proxy.db');
    auto = true;
  }
  try {
    const result = seed(dbPath);
    console.log(`[seed] ✅ 夹具已写入（临时库，非真实库）：${result.dbPath}${auto ? '（自动创建）' : ''}`);
    console.log(`[seed] session=${result.sessionKey} counts=${JSON.stringify(result.counts)}`);
    console.log('[seed] 接线：让 proxy 用 PROXY_DB_PATH=<上面的路径> 启动，并把面板的');
    console.log('       ATTRIBUTION_PROXY_BASE_URL / ATTRIBUTION_PROXY_ADMIN_KEY 指向该 proxy。');
  } catch (err) {
    console.error(`[seed] ✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
