/**
 * corrected 三路机器规则（60 spec §2；S6 单元 A 实现 **L1 版本漂移**；L2/L3 后置）。
 *
 * L1 语义（60 spec §2.1；口径裁定见勘正 3）：
 *   - 输入证据：**版本链**——同一 `(asset_id, session_key)` 在**归档窗口**（该 session 的
 *     fetched 行序）出现 ≥2 个版本，且**首见版本 < 最新版本**（"锚定版本"取窗口内首见——
 *     DR-6a：锚版 = 归档窗口，**不回查当前存储**）；
 *   - 规则：对该 (session, asset) 的**每条 `asset_used` 行**产 **1 条 `asset_corrected`**
 *     （`route="version_drift"`，payload 只回指：used_status_id / judgement_id / versions）；
 *   - 反例：窗口外版本不出现、版本缺失不伪造、无漂移不产、无 used 行无修正对象；
 *   - **不回改**：used 行 / judgement 行零改写（不可变纪律）；**不改 verdict**（§1.1 边界）。
 *
 * 触发条件（登记）：规则本体为纯函数式入口（`applyVersionDriftCorrections(sessionKey)`）；
 * 自动接线（worker post-cycle / CLI / 周期任务）属运营策略，随消费侧（S7）或专项单接入——
 * 本函数可被任何入口调用（60 spec §6 的最小读者 = 审计查询口）。
 */
import type { AttributionEventRepo, AttributionEventRowWithRowid } from "../db/attributionEventRepo.js";
import { getAttributionEventRepo } from "../db/attributionEventRepo.js";
import {
  getAttributionStatusEventsRepo,
  STATUS_EVENT_TYPE_ASSET_CORRECTED,
  STATUS_EVENT_TYPE_ASSET_USED,
  type AttributionStatusEventsRepo,
} from "./status-events-repo.js";

export const CORRECTION_ROUTE_VERSION_DRIFT = "version_drift";

export interface L1Deps {
  eventRepo?: AttributionEventRepo;
  statusRepo?: AttributionStatusEventsRepo;
}

export interface L1Outcome {
  /** 有 fetched 行的资产数（分母）。 */
  assetsScanned: number;
  /** 满足 anchored<latest 的资产数（含无 used 行、故未产事件的）。 */
  assetsWithDrift: number;
  /** 因版本缺失（<2 个可取版本）跳过的资产数（不猜测）。 */
  assetsSkippedNoVersion: number;
  correctedInserted: number;
  correctedDuplicate: number;
  failed: number;
}

function emptyOutcome(): L1Outcome {
  return {
    assetsScanned: 0,
    assetsWithDrift: 0,
    assetsSkippedNoVersion: 0,
    correctedInserted: 0,
    correctedDuplicate: 0,
    failed: 0,
  };
}

/** 从 fetched 行的 payload 里取 version（number 才认；"取不到省略"不伪造）。 */
function versionOf(row: AttributionEventRowWithRowid): number | null {
  try {
    const p = JSON.parse(row.payload_json) as { version?: unknown };
    return typeof p.version === "number" && Number.isFinite(p.version) ? p.version : null;
  } catch {
    return null;
  }
}

function judgementIdOfPayload(payloadJson: string): string | null {
  try {
    const p = JSON.parse(payloadJson) as { judgement_id?: unknown };
    return typeof p.judgement_id === "string" ? p.judgement_id : null;
  } catch {
    return null;
  }
}

/**
 * 对给定 session 跑 L1 版本漂移修正（幂等：同 (unit, asset, round, asset_corrected, route)
 * 重放 ⇒ duplicate）。
 */
export function applyVersionDriftCorrections(sessionKey: string, deps: L1Deps = {}): L1Outcome {
  const eventRepo = deps.eventRepo ?? getAttributionEventRepo();
  const statusRepo = deps.statusRepo ?? getAttributionStatusEventsRepo();
  const out = emptyOutcome();

  // 归档窗口 = 该 session 的事件行（rowid 序 ⇒ 首见/最新按插入序）。
  const rows = eventRepo.listBySessionWithRowid(sessionKey).filter((r) => r.event_type === "asset_fetched");
  const byAsset = new Map<string, number[]>(); // asset_id -> 版本序（按行序，仅 number）
  for (const r of rows) {
    const assetId = r.asset_id;
    if (!assetId) continue;
    const v = versionOf(r);
    if (v === null) continue;
    const list = byAsset.get(assetId);
    if (list) list.push(v);
    else byAsset.set(assetId, [v]);
  }
  out.assetsScanned = byAsset.size;

  const usedRows = statusRepo
    .listBySession(sessionKey, { eventType: STATUS_EVENT_TYPE_ASSET_USED })
    .filter((r) => r.asset_id.length > 0);

  for (const [assetId, versions] of byAsset) {
    if (versions.length < 2) {
      out.assetsSkippedNoVersion += 1;
      continue;
    }
    const anchored = versions[0]!;
    const latest = versions[versions.length - 1]!;
    if (!(anchored < latest)) continue; // 无漂移（含"版本回落"这类异常：不产，不猜）
    out.assetsWithDrift += 1;

    for (const used of usedRows.filter((r) => r.asset_id === assetId)) {
      const res = statusRepo.insertIdempotent({
        unitId: used.unit_id,
        sessionKey,
        spaceId: used.space_id,
        assetId,
        assetType: used.asset_type,
        round: used.round,
        eventType: STATUS_EVENT_TYPE_ASSET_CORRECTED,
        route: CORRECTION_ROUTE_VERSION_DRIFT,
        outcome: null,
        // 只回指、不复制判定内容（60 spec §5）。
        payload: {
          used_status_id: used.status_id,
          judgement_id: judgementIdOfPayload(used.payload_json),
          correction_route: CORRECTION_ROUTE_VERSION_DRIFT,
          anchored_version: anchored,
          latest_version: latest,
          severity: "signal",
        },
      });
      if (res.kind === "inserted") out.correctedInserted += 1;
      else if (res.kind === "duplicate") out.correctedDuplicate += 1;
      else out.failed += 1;
    }
  }
  return out;
}
