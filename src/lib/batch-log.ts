/**
 * 実行ログ（logs/batch.log）：バッチの開始と終了を 1 行ずつ追記する
 * - いつ始まっていつ終わったか、成功か失敗か、失敗したときのエラー内容を残す
 * - 異常終了しても残るよう、同期書き込み（appendFileSync）で書く
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { nowJst } from "./time.js";

const PATH = "logs/batch.log";

function write(level: "START" | "END", fields: Record<string, unknown>): void {
  mkdirSync("logs", { recursive: true });
  const kv = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v)}`)
    .join(" ");
  appendFileSync(PATH, `${nowJst()} [${level}] ${kv}\n`);
}

export function logStart(batch: string, fields: Record<string, unknown> = {}): void {
  write("START", { batch, pid: process.pid, args: process.argv.slice(2).join(" "), ...fields });
}

export function logEnd(
  batch: string,
  status: "SUCCESS" | "FAILED",
  startedAt: bigint,
  fields: Record<string, unknown> = {},
): void {
  const sec = Number(process.hrtime.bigint() - startedAt) / 1e9;
  write("END", { batch, pid: process.pid, status, sec: Number(sec.toFixed(2)), ...fields });
}
