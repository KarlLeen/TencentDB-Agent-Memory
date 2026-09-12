/**
 * 触发源：决策单元落库后入队（design §4.6）。
 *
 * 三条纪律（硬约束）：
 *   1. **fire-and-forget**：绝不 throw 回 runner —— 入队失败不能影响 v1 落库链路；
 *   2. **缺省零访问**：`attribution.judge.enqueue` 非 `true` 时立刻返回，不建/不读队列表；
 *   3. **自足 payload**：worker 只读队列行，不 v1 回查 ⇒ payload 里带齐 judge 需要的全部输入。
 *
 * 【56 · D7 修订】第 3 条自 56 起修订为：**worker 只读队列行 + 只读证据 provider**
 * （provider 零写、不推进水位）—— 契约见 50 spec §11（docs/implementation/50-attribution-judge-worker.md）。
 * 本文件的组包行为不变（payload 仍带齐 kind/turnSeq/msgSeq/payload）。
 *
 * 由 `decision-unit-runner` 用**动态 import** 调用（design §4.6）：关闭时连本模块都不加载。
 */

import { getAttributionJudgeQueueRepo, TRIGGER_DECISION_UNIT } from "./judge-queue-repo.js";

/** 只依赖到最小结构：runner 传的就是整个 ProxyConfig，结构兼容即可。 */
export interface EnqueueGuardedConfig {
  attribution?: { judge?: { enqueue?: boolean } } | undefined;
}

/**
 * judge 需要的单元摘要。`unitId` 是 v1 的内容哈希（30 spec §4.6）⇒ 跨重放稳定，
 * 正是入队幂等键 (unit_id, round) 需要的性质。
 */
export interface EnqueueableUnit {
  unitId: string;
  kind: string;
  turnSeq: number;
  msgSeq: number;
  payload: unknown;
}

export interface EnqueueParams {
  config: EnqueueGuardedConfig;
  units: EnqueueableUnit[];
  sessionKey: string;
  spaceId?: string;
  trigger?: string;
  /**
   * 61 · 轮次（50 spec §16 C1）：缺省 0（首判，行为不变）；`>0` = 重判。
   * 生产首判路径不传（round=0）；重判走 `--rejudge` 入口（`rejudge.ts`）。
   */
  round?: number;
}

export interface EnqueueOutcome {
  /** 未开启（缺省）⇒ 根本没碰库。 */
  skipped: boolean;
  inserted: number;
  dedupeConflicts: number;
}

/**
 * 入队。**调用方无需 try/catch**：本函数保证不抛。
 * 返回值只用于测试/观测，生产路径可忽略。
 */
export function enqueueUnitsForJudge(params: EnqueueParams): EnqueueOutcome {
  // 守卫必须在**任何** DB 接触之前（零访问要求）。
  if (params.config?.attribution?.judge?.enqueue !== true) {
    return { skipped: true, inserted: 0, dedupeConflicts: 0 };
  }
  if (!Array.isArray(params.units) || params.units.length === 0) {
    return { skipped: false, inserted: 0, dedupeConflicts: 0 };
  }
  if (!params.sessionKey) {
    return { skipped: false, inserted: 0, dedupeConflicts: 0 };
  }

  let inserted = 0;
  let dedupeConflicts = 0;
  try {
    const repo = getAttributionJudgeQueueRepo();
    for (const unit of params.units) {
      const ok = repo.enqueue({
        unitId: unit.unitId,
        round: params.round ?? 0, // 61：缺省 0 = 首判（行为不变）；>0 = 重判（--rejudge 入口）
        sessionKey: params.sessionKey,
        spaceId: params.spaceId,
        trigger: params.trigger ?? TRIGGER_DECISION_UNIT,
        payload: {
          kind: unit.kind,
          turnSeq: unit.turnSeq,
          msgSeq: unit.msgSeq,
          payload: unit.payload,
        },
      });
      if (ok) inserted += 1;
      else dedupeConflicts += 1;
    }
  } catch (err) {
    // 双保险：repo 已自吞异常，这里再兜一层 —— 入队永远不能冒泡到 runner。
    console.warn(
      "[attribution-judge] enqueue failed (best-effort, ignored):",
      err instanceof Error ? err.message : String(err),
    );
  }
  return { skipped: false, inserted, dedupeConflicts };
}
