/**
 * v2：ストリーミング処理 + まとめて INSERT
 * - CSVを少しずつ読みながら処理する（ファイル全体をメモリに載せない）
 * - createMany で複数件をまとめて INSERT する（DBとの往復を減らす）
 * - Prisma のデバッグ用の履歴を毎回消す（消さないとメモリが約200MB多く残る）
 *
 * 使い方: npm run import:v2 -- [--limit 件数] [--batch 1回の件数] [CSVのパス]
 */
import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
import { clearLogs } from "@prisma/debug";
import { createPrisma } from "./lib/db.js";
import { report } from "./lib/measure.js";
import { toRsdt, type RsdtCsvRow } from "./lib/rsdt.js";
import type { Prisma } from "./generated/prisma/client.js";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const limit = Number(opt("--limit") ?? Infinity);
const batchSize = Number(opt("--batch") ?? 1000);
const file =
  args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ??
  "data/mt_rsdtdsp_rsdt_pref13.csv";

const prisma = createPrisma();
const startedAt = process.hrtime.bigint();

try {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE mt_rsdtdsp_rsdt");

  const parser = createReadStream(file).pipe(parse({ columns: true }));

  let batch: Prisma.RsdtdspRsdtCreateManyInput[] = [];
  let count = 0;
  for await (const row of parser as AsyncIterable<RsdtCsvRow>) {
    if (count >= limit) break;
    batch.push(toRsdt(row));
    count++;
    if (batch.length >= batchSize) {
      await prisma.rsdtdspRsdt.createMany({ data: batch });
      batch = [];
      // Prisma のデバッグ部品は、ログを出さない設定でも直近100回分のSQLと引数を
      // メモリに取っておく。まとめて INSERT すると1回分が大きいので、毎回消す
      clearLogs();
    }
  }
  if (batch.length > 0) {
    await prisma.rsdtdspRsdt.createMany({ data: batch });
  }
  report(`v2 stream+createMany batch=${batchSize}`, count, startedAt);
} finally {
  await prisma.$disconnect();
}
