/**
 * v5：ストリーミング処理 + まとめて INSERT（Prisma を使わず、mariadb ドライバーの query で送る）
 * - v2 と同じく、CSVを少しずつ読みながら、複数件をまとめて INSERT する
 * - v2 との違いは SQL の作り方と送り方だけ
 *   - SQL は自分で組み立てる（INSERT INTO ... VALUES (?, ...), (?, ...), ...）
 *   - query で送る（ドライバーが値を SQL に埋め込んで 1 回で送る。プリペアドステートメントは使わない）
 *
 * 使い方: npm run import:v5 -- [--limit 件数] [--batch 1回の件数] [CSVのパス]
 */
import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
import { createConnection } from "./lib/mariadb.js";
import { report } from "./lib/measure.js";
import { ALL_COLUMNS, normalizeCsvRow, type Row } from "./lib/rsdt-columns.js";

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

const COLS_SQL = ALL_COLUMNS.map((c) => `\`${c}\``).join(", ");
const ROW_PLACEHOLDER = `(${ALL_COLUMNS.map(() => "?").join(", ")})`;

const conn = await createConnection();
const startedAt = process.hrtime.bigint();

async function insert(rows: Row[]): Promise<void> {
  await conn.query(
    `INSERT INTO mt_rsdtdsp_rsdt (${COLS_SQL}) VALUES ${rows.map(() => ROW_PLACEHOLDER).join(", ")}`,
    rows.flatMap((r) => ALL_COLUMNS.map((c) => r[c])),
  );
}

try {
  await conn.query("TRUNCATE TABLE mt_rsdtdsp_rsdt");

  const parser = createReadStream(file).pipe(parse({ columns: true }));

  let batch: Row[] = [];
  let count = 0;
  for await (const row of parser as AsyncIterable<Record<string, string>>) {
    if (count >= limit) break;
    batch.push(normalizeCsvRow(row));
    count++;
    if (batch.length >= batchSize) {
      await insert(batch);
      batch = [];
    }
  }
  if (batch.length > 0) {
    await insert(batch);
  }
  report(`v5 stream+query batch=${batchSize}`, count, startedAt);
} finally {
  await conn.end();
}
