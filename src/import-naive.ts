/**
 * v1：素直に書いた遅い版
 * - CSVを丸ごとメモリに読み込んでから処理する
 * - 1件ずつ INSERT する（1件ごとにDBと往復する）
 *
 * 使い方: npm run import:naive -- [--limit 件数] [CSVのパス]
 */
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { createPrisma } from "./lib/db.js";
import { report } from "./lib/measure.js";
import { toRsdt, type RsdtCsvRow } from "./lib/rsdt.js";

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
const file =
  args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--limit") ??
  "data/mt_rsdtdsp_rsdt_pref13.csv";

const prisma = createPrisma();
const startedAt = process.hrtime.bigint();

try {
  await prisma.rsdtdspRsdt.deleteMany();

  const rows: RsdtCsvRow[] = parse(readFileSync(file, "utf8"), { columns: true });

  let count = 0;
  for (const row of rows) {
    if (count >= limit) break;
    await prisma.rsdtdspRsdt.create({ data: toRsdt(row) });
    count++;
  }
  report("v1 naive", count, startedAt);
} finally {
  await prisma.$disconnect();
}
