/**
 * 62 · 判定侧边界与成本闸门测试矩阵（50 spec §17）T1–T5。
 *
 * T1 tombstone 分支（+ 对照格"unknown 但无 resultMissing 走正常判定"）；T2 不调 judge（三 provider）；
 * T3 top-N 闸门（溢出保持 pending）；T4 饿死机制（溢出者下轮 FIFO 优先、无永久排除）；T5 溢出文案落点。
 * 反向控制（手工、用后即还原）：R1 tombstone 走正常判定 ⇒ T2 红；R2 tombstone 写 asset_used ⇒ T1 红；
 * R3 溢出永久排除 ⇒ T4 红。
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getAttributionStatusEventsRepo } from "../status-events-repo.js";
import { DeterministicMockJudge } from "../judge/deterministic-mock-judge.js";
import { MechanicalJudge } from "../judge/mechanical-judge.js";
import { RealProviderJudge } from "../judge/real-provider-judge.js";
import {
  DEFAULT_TOP_N_PER_CYCLE,
  TOMBSTONE_RATIONALE_REF,
  isTombstoneUnit,
  main,
  runWorker,
} from "../worker.js";
import { detailsRepo, queueRepo, teardownTempDb, withTempDb, workerDeps } from "./_helpers/base-harness.js";

/** 造一个 tombstone key_tool_call 单元（判据：unknown + resultMissing）。 */
function seedTombstone(unitId: string, sessionKey: string, text = "见 asset-a"): void {
  queueRepo().enqueue({
    unitId,
    sessionKey,
    payload: {
      kind: "key_tool_call",
      turnSeq: 1,
      msgSeq: 9,
      payload: {
        unitType: "key_tool_call",
        toolName: "git push",
        resultStatus: "unknown",
        resultMissing: true, // ← tombstone 判据
        visibleAssets: [{ assetId: "asset-a", assetType: "skill" }],
        text,
      },
    },
  });
}

/** 造 restraint 单元（正常判定路径）。 */
function seedRestraint(unitId: string, sessionKey: string): void {
  queueRepo().enqueue({
    unitId,
    sessionKey,
    payload: {
      kind: "restraint",
      turnSeq: 1,
      msgSeq: 5,
      payload: { visibleAssets: [{ assetId: "asset-a", assetType: "skill" }], text: "见 asset-a" },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("62 · T1 tombstone 分支（直接 unconfirmed、不写 asset_used、judgement 照落）", () => {
  it("tombstone ⇒ unconfirmed + rationaleRef 标记 + status 0 行 + 对照格走正常判定", async () => {
    withTempDb();
    try {
      seedTombstone("u-t61", "sess-t61");
      // 对照格：unknown 但**无** resultMissing（结果到达但空文本）⇒ 正常判定 ⇒ mock 命中 asset-a ⇒ confirmed
      queueRepo().enqueue({
        unitId: "u-t61-ctrl",
        sessionKey: "sess-t61",
        payload: {
          kind: "key_tool_call",
          turnSeq: 1,
          msgSeq: 10,
          payload: {
            unitType: "key_tool_call",
            toolName: "git push",
            resultStatus: "unknown",
            // 无 resultMissing —— 对照
            visibleAssets: [{ assetId: "asset-a", assetType: "skill" }],
            text: "见 asset-a",
          },
        },
      });

      const result = await runWorker(workerDeps(), { drain: true });
      const rows = detailsRepo().listBySession("sess-t61");
      const tomb = rows.find((r) => r.unit_id === "u-t61")!;
      const ctrl = rows.find((r) => r.unit_id === "u-t61-ctrl")!;
      console.log(
        `T1 观测 → tombstone: verdict=${tomb.verdict} asset=${tomb.asset_id} rationale=${JSON.parse(tomb.detail_json).rationaleRef}；` +
          `对照格: verdict=${ctrl.verdict} asset=${ctrl.asset_id}；status 行(两者)=` +
          `${getAttributionStatusEventsRepo().count()}；tombstoned=${result.tombstoned}`,
      );
      // tombstone：unconfirmed + 标记 + status 0 行（不写 asset_used）
      expect(tomb.verdict).toBe("unconfirmed");
      expect(tomb.asset_id).toBe(null);
      expect(JSON.parse(tomb.detail_json).rationaleRef).toBe(TOMBSTONE_RATIONALE_REF);
      expect(getAttributionStatusEventsRepo().listByUnit("u-t61").length).toBe(0);
      expect(result.tombstoned).toBe(1);
      // 对照格：正常判定路径（若判据误伤 ⇒ 这里会是 unconfirmed）
      expect(ctrl.verdict).toBe("confirmed");
      expect(ctrl.asset_id).toBe("asset-a");
      expect(getAttributionStatusEventsRepo().listByUnit("u-t61-ctrl").length).toBe(1);
    } finally {
      teardownTempDb();
    }
  });

  it("isTombstoneUnit 纯判据：只认 payload 两字段（形态矩阵）", () => {
    const cases: Array<[string, string, unknown, boolean]> = [
      ["tombstone", "key_tool_call", { resultStatus: "unknown", resultMissing: true }, true],
      ["unknown 无 resultMissing（对照）", "key_tool_call", { resultStatus: "unknown" }, false],
      ["resultMissing 但 status=success（对照）", "key_tool_call", { resultStatus: "success", resultMissing: true }, false],
      ["resultMissing 非 true（对照）", "key_tool_call", { resultStatus: "unknown", resultMissing: false }, false],
      ["kind 非 key_tool_call（对照）", "restraint", { resultStatus: "unknown", resultMissing: true }, false],
      ["payload 非对象", "key_tool_call", null, false],
    ];
    for (const [label, kind, payload, expected] of cases) {
      expect(isTombstoneUnit(kind, payload), label).toBe(expected);
    }
    // 文本启发式的反例：没有两字段、只有"看起来像失败"的文本 ⇒ 不判 tombstone
    expect(isTombstoneUnit("key_tool_call", { resultSnippet: "", toolParamText: "error: unknown" })).toBe(false);
  });
});

describe("62 · T2 不调 judge（tombstone 全程 0 次 provider 调用；三 provider 各一格）", () => {
  it("mock / mechanical / real：judge 调用计数 = 0", async () => {
    const cases: Array<[string, () => { judge: unknown; calls: () => number }]> = [
      [
        "mock",
        () => {
          const j = new DeterministicMockJudge();
          const spy = vi.spyOn(j, "judge");
          return { judge: j, calls: () => spy.mock.calls.length };
        },
      ],
      [
        "mechanical",
        () => {
          const j = new MechanicalJudge();
          const spy = vi.spyOn(j, "judge");
          return { judge: j, calls: () => spy.mock.calls.length };
        },
      ],
      [
        "real",
        () => {
          const j = new RealProviderJudge({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m" });
          const spy = vi.spyOn(j, "judge");
          return { judge: j, calls: () => spy.mock.calls.length };
        },
      ],
    ];
    for (const [label, make] of cases) {
      withTempDb();
      try {
        seedTombstone(`u-t62-${label}`, `sess-t62-${label}`);
        const { judge, calls } = make();
        const result = await runWorker(
          workerDeps({ judge: judge as never }),
          { drain: true },
        );
        console.log(`T2 ${label} → judge 调用=${calls()} verdict=${detailsRepo().listByUnit(`u-t62-${label}`)[0]!.verdict}`);
        expect(calls(), `${label} 不得调用 judge`).toBe(0);
        expect(result.tombstoned).toBe(1);
        expect(detailsRepo().listByUnit(`u-t62-${label}`)[0]!.verdict).toBe("unconfirmed");
      } finally {
        teardownTempDb();
      }
    }
  });
});

describe("62 · T3 top-N 闸门（溢出保持 pending、未被 claim）", () => {
  it("topN=2 + 5 个 pending ⇒ completed=2、溢 3 保持 pending（attempts 全 0）、overflowed=3", async () => {
    withTempDb();
    try {
      for (let i = 1; i <= 5; i += 1) seedRestraint(`u-t63-${i}`, "sess-t63");
      const result = await runWorker(workerDeps({ topNPerCycle: 2 }), { drain: true });
      const pending = queueRepo().listByStatus("pending");
      console.log(
        `T3 观测 → completed=${result.completed} claimed=${result.claimed} overflowed=${result.overflowed}；` +
          `pending=${pending.length}（attempts=${JSON.stringify(pending.map((r) => r.attempts))}）`,
      );
      expect(result.completed).toBe(2);
      expect(result.claimed).toBe(2);
      expect(result.overflowed).toBe(3);
      expect(pending.length).toBe(3);
      // 溢出者从未被 claim：状态/attempts 零改动
      expect(pending.every((r) => r.attempts === 0 && r.status === "pending")).toBe(true);
      // FIFO：完成的是 queue_id 最小的两个
      const done = queueRepo().listByStatus("done");
      expect(done.map((r) => r.unit_id)).toEqual(["u-t63-1", "u-t63-2"]);
      // 缺省值（30 spec 口径）与"未配置不变"的配置链
      expect(DEFAULT_TOP_N_PER_CYCLE).toBe(30);
    } finally {
      teardownTempDb();
    }
  });

  it("缺省 30 端到端：35 个 pending（不传 topNPerCycle）⇒ 单轮恰处理 30、溢 5（语义变更的行为面实测）", async () => {
    withTempDb();
    try {
      for (let i = 1; i <= 35; i += 1) seedRestraint(`u-t63c-${i}`, "sess-t63c");
      const result = await runWorker(workerDeps(), { drain: true }); // workerDeps 缺省 topNPerCycle=30
      console.log(`T3 缺省 30 观测 → completed=${result.completed} overflowed=${result.overflowed} pending=${queueRepo().countByStatus().pending}`);
      expect(result.completed).toBe(30);
      expect(result.overflowed).toBe(5);
      expect(queueRepo().countByStatus().pending).toBe(5);
    } finally {
      teardownTempDb();
    }
  });

  it("常驻模式：额度耗尽 = 节流一拍（不冷停）——溢出者下一拍被处理", async () => {
    withTempDb();
    try {
      for (let i = 1; i <= 5; i += 1) seedRestraint(`u-t63b-${i}`, "sess-t63b");
      const overflowSeq: number[] = [];
      let rounds = 0;
      const result = await runWorker(workerDeps({ topNPerCycle: 2 }), {
        drain: false,
        shouldStop: () => {
          rounds += 1;
          return rounds > 6; // 3 个处理拍 + 空转拍后停
        },
        onRound: (r) => overflowSeq.push(r.overflowed),
      });
      console.log(`T4 常驻观测 → completed=${result.completed} 每拍 overflowed=${JSON.stringify(overflowSeq)}`);
      expect(result.completed).toBe(5); // 节流而非冷停：全部被处理
      expect(overflowSeq).toContain(3); // 第一拍后溢出 3
    } finally {
      teardownTempDb();
    }
  });
});

describe("62 · T4 饿死机制（溢出者下轮 FIFO 优先、无永久排除）", () => {
  it("第二轮消化第一轮溢出者（unit 集合精确相等）⇒ 第三轮空", async () => {
    withTempDb();
    try {
      for (let i = 1; i <= 5; i += 1) seedRestraint(`u-t64-${i}`, "sess-t64");
      const r1 = await runWorker(workerDeps({ topNPerCycle: 2 }), { drain: true });
      expect(r1.completed).toBe(2);
      expect(r1.overflowed).toBe(3);

      // 第二轮：额度重置为 2 ⇒ 再处理 2 个，且**溢出者（队头 u3/u4）最先**（FIFO 硬证据）
      const r2 = await runWorker(workerDeps({ topNPerCycle: 2 }), { drain: true });
      const doneUnits2 = queueRepo()
        .listByStatus("done")
        .map((r) => r.unit_id);
      console.log(
        `T4 观测 → r1.completed=${r1.completed} r2.completed=${r2.completed} done 顺序=${JSON.stringify(doneUnits2)} r2.overflowed=${r2.overflowed}`,
      );
      expect(r2.completed, "每 cycle 上限 2（额度每轮重置）").toBe(2);
      expect(doneUnits2, "溢出者最先被处理（FIFO）").toEqual(["u-t64-1", "u-t64-2", "u-t64-3", "u-t64-4"]);

      // 第三轮：消化最后的溢出者 u5；无永久排除
      const r3 = await runWorker(workerDeps({ topNPerCycle: 2 }), { drain: true });
      expect(r3.completed).toBe(1);
      expect(queueRepo().countByStatus().pending).toBeUndefined();
      expect(
        queueRepo()
          .listByStatus("done")
          .map((r) => r.unit_id),
      ).toEqual(["u-t64-1", "u-t64-2", "u-t64-3", "u-t64-4", "u-t64-5"]);

      // 第四轮：无行可做
      const r4 = await runWorker(workerDeps({ topNPerCycle: 2 }), { drain: true });
      expect(r4.claimed).toBe(0);
      expect(r4.overflowed).toBe(0);
    } finally {
      teardownTempDb();
    }
  });
});

describe("62 · T5 溢出文案落点（cycle 摘要；分母 = 实际溢出数）", () => {
  it("main(--once) stderr 含『另有 3 个次要决策未逐一归因』+ overflowed=3", async () => {
    const dir = withTempDb();
    try {
      for (let i = 1; i <= 5; i += 1) seedRestraint(`u-t65-${i}`, "sess-t65");
      const cfgPath = path.join(dir, "cfg-topn2.yaml");
      fs.writeFileSync(
        cfgPath,
        "attribution:\n  judge:\n    enqueue: true\n    provider: mock\n    worker:\n      topNPerCycle: 2\n",
        "utf8",
      );
      const chunks: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
        chunks.push(String(c));
        return true;
      });
      const code = await main(["--once", "--config", cfgPath]);
      const stderrText = chunks.join("");
      const overflowLine = stderrText.split("\n").find((l) => l.includes("次要决策未逐一归因")) ?? "";
      console.log(`T5 观测 → exit=${code}；${overflowLine.trim()}`);
      expect(code).toBe(0);
      expect(stderrText).toContain("overflowed=3");
      expect(overflowLine).toContain("另有 3 个次要决策未逐一归因");
      // 分母 = 实际溢出数（pending 剩 3）
      expect(queueRepo().countByStatus().pending).toBe(3);
    } finally {
      teardownTempDb();
    }
  });
});
