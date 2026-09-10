/**
 * 引用式日志（design §4.5）。
 *
 * **复用** `src/report/file-logger.ts`，不另写日志器（硬约束）。每条消费一行。
 * 字段取 `MemoryGenerationLog` 最小子集：
 *   `log_id / generation_id / layer="attribution_judge" / status / prompt_ref /
 *    input_refs[{unit_id, queue_id}] / output_refs[{judgement_id}] / latency_ms`
 *
 * 「引用式」的含义：只记 id 与引用，**不记自由文本**（不把 prompt 内容 / 判定正文写进日志），
 * 需要正文时按 id 去表里取。
 *
 * 目录口径与 P0 一致（src/injection/index.ts:225）：
 * `PROXY_DATA_DIR` → `config.storage.fs.fsRoot` → `~/.memory-tencentdb/proxy-state`。
 */

import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { FileLogger } from "../report/file-logger.js";
import type { PromptRef } from "./judge/types.js";

export const ATTRIBUTION_JUDGE_LOG_FILENAME = "attribution-judge.log";

export interface JudgeLogInputRef {
  unit_id: string;
  queue_id: number;
}

export interface JudgeLogOutputRef {
  judgement_id: string;
}

export type JudgeLogStatus = "ok" | "idempotent" | "error";

export interface JudgeLogRecord {
  status: JudgeLogStatus;
  promptRef: PromptRef;
  inputRefs: JudgeLogInputRef[];
  outputRefs: JudgeLogOutputRef[];
  latencyMs: number;
  /** 仅在 status==="error" 时写；截断防爆行。 */
  error?: string;
  judgeImpl?: string;
}

export interface JudgeLogDirConfig {
  attribution?: unknown;
  storage?: { fs?: { fsRoot?: string } } | undefined;
}

export function resolveAttributionJudgeLogDir(config?: JudgeLogDirConfig): string {
  const fromEnv = process.env.PROXY_DATA_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  const fromConfig = config?.storage?.fs?.fsRoot;
  if (fromConfig && fromConfig.trim().length > 0) return fromConfig.trim();
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return path.join(home, ".memory-tencentdb", "proxy-state");
}

let _logger: FileLogger | null = null;
let _logFilePath = "";

/**
 * 初始化（幂等）。空目录 ⇒ FileLogger 自行 disabled（静默，不影响业务）。
 * `flushThreshold: 1` + 每条写后显式 flush：证据文件必须落盘可查，不能躺在 200ms 缓冲里。
 */
export function initAttributionJudgeLogger(dir: string): void {
  if (_logger) return;
  _logger = new FileLogger({
    dir,
    filename: ATTRIBUTION_JUDGE_LOG_FILENAME,
    flushThreshold: 1,
    flushIntervalMs: 1000,
  });
  _logFilePath = dir ? path.join(dir, ATTRIBUTION_JUDGE_LOG_FILENAME) : "";
}

/** 当前日志文件路径（空串 = 未初始化 / 已禁用）。供 checklist C9 取证。 */
export function getAttributionJudgeLogFilePath(): string {
  return _logFilePath;
}

/** 写一行消费日志。任何异常都被 FileLogger 吞掉，这里再兜一层 try。 */
export function writeAttributionJudgeLog(record: JudgeLogRecord): void {
  if (!_logger) return;
  try {
    _logger.write("INFO", "attribution_judge", {
      log_id: randomUUID(),
      // generation_id ↔ output_refs 对齐（MemoryGenerationLog 口径）：产出即判定明细。
      generation_id: record.outputRefs[0]?.judgement_id ?? "",
      layer: "attribution_judge",
      status: record.status,
      prompt_ref: record.promptRef,
      input_refs: record.inputRefs,
      output_refs: record.outputRefs,
      latency_ms: record.latencyMs,
      ...(record.judgeImpl ? { judge_impl: record.judgeImpl } : {}),
      ...(record.error ? { error: record.error.slice(0, 500) } : {}),
    });
    _logger.flush();
  } catch {
    // Silent — 日志绝不阻断消费（与 FileLogger 同源纪律）。
  }
}

/** worker 退出前必调：flush + close。 */
export async function shutdownAttributionJudgeLogger(): Promise<void> {
  if (!_logger) return;
  try {
    await _logger.shutdown();
  } catch {
    // Silent
  }
}

/** Reset singleton — tests only. */
export function __resetAttributionJudgeLoggerForTests(): void {
  _logger = null;
  _logFilePath = "";
}
