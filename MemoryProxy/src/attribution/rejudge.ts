/**
 * 61 · 重判入口（50 spec §16 C1/C2）。
 *
 * 语义（写死）：
 *   - 新轮 = `max(该 unit 在 queue 表的 round) + 1` —— **queue 是权威轮次账本**；
 *   - 输入从**最新轮 queue 行**复制（payload / session / space —— "旧行不删"使重判可读原始输入）；
 *   - `trigger = "manual"`；
 *   - 并发安全由 `(unit_id, round)` 幂等键兜住（两方同算 k ⇒ 第二方 enqueued=false，非错误）——
 *     **不新增锁**；
 *   - 不改写/删除任何旧轮行（不可变纪律）。
 *
 * 自动触发（版本漂移 / 规则升级）按 A7 留给 S6，不属本模块。
 */
import {
  getAttributionJudgeQueueRepo,
  TRIGGER_MANUAL,
  type AttributionJudgeQueueRepo,
} from "./judge-queue-repo.js";

export interface RejudgeParams {
  unitId: string;
  /** 测试可注入；缺省 getAttributionJudgeQueueRepo()。 */
  repo?: AttributionJudgeQueueRepo;
}

export interface RejudgeOutcome {
  ok: boolean;
  /** 新轮次（ok=false ⇒ -1）。 */
  round: number;
  /** true = 新入队；false = `(unit_id, round)` 幂等命中（并发/重放，非错误）。 */
  enqueued: boolean;
  reason?: "target_missing";
}

function safeParsePayload(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    return {};
  }
}

export function rejudgeUnit(params: RejudgeParams): RejudgeOutcome {
  const repo = params.repo ?? getAttributionJudgeQueueRepo();
  const latest = repo.latestByUnit(params.unitId);
  if (!latest) {
    return { ok: false, round: -1, enqueued: false, reason: "target_missing" };
  }
  const round = latest.round + 1;
  const enqueued = repo.enqueue({
    unitId: latest.unit_id,
    round,
    sessionKey: latest.session_key,
    spaceId: latest.space_id,
    trigger: TRIGGER_MANUAL,
    payload: safeParsePayload(latest.payload_json),
  });
  return { ok: true, round, enqueued };
}
