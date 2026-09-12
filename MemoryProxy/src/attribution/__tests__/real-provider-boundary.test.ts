/**
 * 60 · 信任边界测试（50 spec §15）：
 * T2 幻觉护栏（worker 边界，对 mock/mechanical/real 一律生效；纯函数 + worker 层）；
 * T3 fail-closed（未知 provider / real 缺参数 ⇒ 子进程非零码 + 明确 stderr + 零 judgement 行）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getAttributionJudgementDetailsRepo } from "../judgement-details-repo.js";
import { getAttributionStatusEventsRepo } from "../status-events-repo.js";
import { applyHallucinationGuard } from "../worker.js";
import { DeterministicMockJudge } from "../judge/deterministic-mock-judge.js";
import { MechanicalJudge } from "../judge/mechanical-judge.js";
import { buildWorkerDeps, runWorker } from "../worker.js";
import { detailsRepo, queueRepo, teardownTempDb, withTempDb, workerDeps } from "./_helpers/base-harness.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("60 · T2 幻觉护栏（worker 边界；C4）", () => {
  it("纯函数：越界 ⇒ 强制 unconfirmed + 标记；候选内 / null ⇒ 不误伤", () => {
    const candidates = [{ assetId: "asset-a", assetType: "skill", evidenceSourceType: "injected" as const }];
    const ghost = applyHallucinationGuard(
      { assetId: "ghost-asset", verdict: "confirmed", rationaleRef: "r" },
      candidates,
    );
    console.log(`T2 纯函数 → tripped=${ghost.tripped} verdict=${JSON.stringify(ghost.verdict)}`);
    expect(ghost.tripped).toBe(true);
    expect(ghost.verdict).toEqual({
      assetId: null,
      verdict: "unconfirmed",
      rationaleRef: "guard:asset_not_in_candidates:ghost-asset",
    });
    // 不改选其它候选（不猜）：assetId 必须是 null，不是 "asset-a"
    expect(ghost.verdict.assetId).toBe(null);

    expect(
      applyHallucinationGuard({ assetId: "asset-a", verdict: "confirmed", rationaleRef: "r" }, candidates).tripped,
    ).toBe(false);
    expect(applyHallucinationGuard({ assetId: null, verdict: "unconfirmed", rationaleRef: "r" }, candidates)).toEqual({
      verdict: { assetId: null, verdict: "unconfirmed", rationaleRef: "r" },
      tripped: false,
    });
  });

  it("worker 层：mock 注入越界 assetId ⇒ 落库 unconfirmed + result.guarded=1 + status 不落；候选内 ⇒ 不误伤", async () => {
    withTempDb();
    try {
      const mkRow = (unitId: string, text: string): void => {
        queueRepo().enqueue({
          unitId,
          sessionKey: "sess-guard",
          payload: {
            kind: "restraint",
            turnSeq: 1,
            payload: { visibleAssets: [{ assetId: "asset-a", assetType: "skill" }], text },
          },
        });
      };
      mkRow("u-guard-ghost", "见 asset-a");
      mkRow("u-guard-ok", "见 asset-a");
      // mock 脚本注入：u-guard-ghost 报一个不在候选里的 assetId（唯一能构造幻觉的确定性路径）
      const judge = new DeterministicMockJudge({
        script: {
          byUnitId: {
            "u-guard-ghost": { kind: "verdict", verdict: "confirmed", assetId: "ghost-asset" },
            "u-guard-ok": { kind: "verdict", verdict: "confirmed", assetId: "asset-a" },
          },
        },
      });
      const result = await runWorker(workerDeps({ judge }), { drain: true });
      console.log(`T2 worker → guarded=${result.guarded} completed=${result.completed}`);

      const ghostRow = detailsRepo().listByUnit("u-guard-ghost")[0]!;
      const okRow = detailsRepo().listByUnit("u-guard-ok")[0]!;
      console.log(
        `T2 落库 → ghost: verdict=${ghostRow.verdict} asset=${ghostRow.asset_id} detail=${ghostRow.detail_json}；` +
          `ok: verdict=${okRow.verdict} asset=${okRow.asset_id}`,
      );
      expect(ghostRow.verdict, "越界 ⇒ 强制 unconfirmed").toBe("unconfirmed");
      expect(ghostRow.asset_id).toBe(null);
      expect(JSON.parse(ghostRow.detail_json).rationaleRef).toBe("guard:asset_not_in_candidates:ghost-asset");
      expect(result.guarded).toBe(1);
      // 59 联动：护栏后是 unconfirmed ⇒ 不写 status 行
      expect(getAttributionStatusEventsRepo().listByUnit("u-guard-ghost").length).toBe(0);
      // 不误伤：候选内 assetId 照常 confirmed + status 落
      expect(okRow.verdict).toBe("confirmed");
      expect(okRow.asset_id).toBe("asset-a");
      expect(getAttributionStatusEventsRepo().listByUnit("u-guard-ok").length).toBe(1);
    } finally {
      teardownTempDb();
    }
  });

  it("worker 层：mechanical 也过同一道闸（guarded=0 + 落库照常；判定结果与护栏无关）", async () => {
    withTempDb();
    try {
      queueRepo().enqueue({
        unitId: "u-guard-mech",
        sessionKey: "sess-guard-mech",
        payload: {
          kind: "restraint",
          turnSeq: 1,
          payload: { visibleAssets: [{ assetId: "skl-x", assetType: "skill" }], text: "见 skl-x 原文" },
        },
      });
      const result = await runWorker(workerDeps({ judge: new MechanicalJudge() }), { drain: true });
      const row = detailsRepo().listByUnit("u-guard-mech")[0]!;
      console.log(`T2 mechanical → guarded=${result.guarded} verdict=${row.verdict} asset=${row.asset_id}`);
      expect(result.guarded, "mechanical 永不出界（只从 candidates 选）⇒ 护栏不误伤").toBe(0);
      // 无 citationSource ⇒ 无 metrics ⇒ mechanical 的 unconfirmed 是 58 既有正确行为（与护栏无关）。
      // mechanical 的 confirmed 路径"过闸不误伤"由 59 T6 e2e（真链路）承载（回归即证）。
      expect(row.verdict).toBe("unconfirmed");
      expect(row.asset_id).toBe(null);
    } finally {
      teardownTempDb();
    }
  });
});

describe("60 · T4b worker 级超时分桶（C5：不新增重试机制，走既有 fail 路径）", () => {
  it("stub 延迟 > timeoutMs + maxAttempts=1 ⇒ errored=1 / deadLettered=1（进程不 hang）", async () => {
    withTempDb();
    try {
      const { RealProviderJudge } = await import("../judge/real-provider-judge.js");
      const http = await import("node:http");
      const slow = http.createServer((_req, res) => setTimeout(() => res.writeHead(200).end("{}"), 500));
      slow.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => slow.once("listening", resolve));
      const port = (slow.address() as { port: number }).port;
      try {
        queueRepo().enqueue({
          unitId: "u-t4b",
          sessionKey: "sess-t4b",
          payload: {
            kind: "restraint",
            turnSeq: 1,
            payload: { visibleAssets: [{ assetId: "asset-a", assetType: "skill" }], text: "见 asset-a" },
          },
        });
        const judge = new RealProviderJudge({
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "stub-key-t4b",
          model: "slow-model",
          timeoutMs: 50,
        });
        const result = await runWorker(workerDeps({ judge, maxAttempts: 1 }), { drain: true });
        console.log(`T4b 分桶 → ${JSON.stringify({ errored: result.errored, deadLettered: result.deadLettered, requeued: result.requeued })}`);
        expect(result.errored).toBe(1);
        expect(result.deadLettered, "maxAttempts=1 ⇒ 直接死信").toBe(1);
        expect(result.requeued).toBe(0);
      } finally {
        await new Promise<void>((resolve) => slow.close(() => resolve()));
      }
    } finally {
      teardownTempDb();
    }
  });
});

describe("60 · T3 fail-closed（CLI；C1）", () => {
  function runWorkerCli(configYaml: string): { status: number | null; stderr: string } {
    const dir = withTempDb();
    try {
      // 先触发建库（全表在）—— fail-closed 必须"零 judgement 行"，库存在与否都要成立。
      void getAttributionJudgementDetailsRepo().count();
      const cfgPath = path.join(dir, "cfg.yaml");
      fs.writeFileSync(cfgPath, configYaml, "utf8");
      const res = spawnSync(
        process.execPath,
        ["--import", "tsx/esm", path.join(pkgRoot, "src/attribution/worker.ts"), "--once", "--config", cfgPath],
        {
          cwd: pkgRoot,
          env: {
            ...process.env,
            PROXY_DB_PATH: process.env.PROXY_DB_PATH ?? "",
            TDAI_ATTRIBUTION_JUDGE_BASE_URL: "",
            TDAI_ATTRIBUTION_JUDGE_API_KEY: "",
            TDAI_ATTRIBUTION_JUDGE_MODEL: "",
          },
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      const count = getAttributionJudgementDetailsRepo().count();
      console.log(
        `T3 → status=${res.status} stderr=${JSON.stringify((res.stderr ?? "").trim().split("\n").slice(-2).join(" | "))} judgements=${count}`,
      );
      expect(count, "fail-closed ⇒ 零 judgement 行").toBe(0);
      return { status: res.status, stderr: res.stderr ?? "" };
    } finally {
      teardownTempDb();
    }
  }

  it("未知 provider ⇒ EXIT_CONFIG_INVALID(3) + FATAL stderr + 不降级 mock", () => {
    const r = runWorkerCli("attribution:\n  judge:\n    provider: gpt-9\n");
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("FATAL");
    expect(r.stderr).toContain('unknown judge provider "gpt-9"');
    expect(r.stderr).not.toContain("falling back");
  });

  it("real 缺参数 ⇒ EXIT_CONFIG_INVALID(3) + 点名缺哪几个", () => {
    const r = runWorkerCli("attribution:\n  judge:\n    provider: real\n");
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("缺必需参数: baseUrl, apiKey, model");
  });
});
