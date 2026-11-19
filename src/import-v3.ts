/**
 * v3：LOAD DATA LOCAL INFILE
 * - CSVをMySQLに直接読み込ませる（1行ずつのSQLを組み立てない）
 * - Prismaは LOAD DATA LOCAL に対応していないので、mariadb ドライバーを直接使う
 * - 1回の LOAD DATA で送れる量は max_allowed_packet（既定 64MB）までなので、
 *   CSVを行の切れ目で約4MBずつに区切って、何回かに分けて送る
 *   （一時ファイルは作らず、区切ったデータを infileStreamFactory で渡す）
 * - 空文字は NULLIF で NULL に変える（v1・v2 の toRsdt と同じ結果にする）
 * - ABR の CSV は改行が CRLF なので、行の区切りを '\r\n' にする
 *
 * 使い方: npm run import:v3 -- [--chunk-mb 区切る大きさ(MB)] [CSVのパス]
 */
import "dotenv/config";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import mariadb from "mariadb";
import { report } from "./lib/measure.js";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const chunkBytes = Number(opt("--chunk-mb") ?? 4) * 1024 * 1024;
const file = resolve(
  args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ??
    "data/mt_rsdtdsp_rsdt_pref13.csv",
);
const url = new URL(process.env["DATABASE_URL"] ?? "");

// 次の LOAD DATA で送るデータ。infileStreamFactory から読まれる
let pending: Buffer = Buffer.alloc(0);

const conn = await mariadb.createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ""),
  permitLocalInfile: true,
  infileStreamFactory: () => Readable.from([pending]),
});

/** LOAD DATA 文を作る（列の並びはCSVのヘッダー行に合わせる） */
function buildSql(header: string): string {
  const notNull = new Set(["lg_code", "machiaza_id", "blk_id", "rsdt_id", "rsdt2_id", "city"]);
  const csvColumns = header.split(",");
  const nullable = csvColumns.filter((c) => !notNull.has(c));
  const columns = csvColumns.map((c) => (nullable.includes(c) ? `@${c}` : `\`${c}\``));
  return `
    LOAD DATA LOCAL INFILE 'chunk.csv'
    INTO TABLE mt_rsdtdsp_rsdt
    CHARACTER SET utf8mb4
    FIELDS TERMINATED BY ','
    LINES TERMINATED BY '\\r\\n'
    (${columns.join(", ")})
    SET ${nullable.map((c) => `\`${c}\` = NULLIF(@${c}, '')`).join(", ")}
  `;
}

const startedAt = process.hrtime.bigint();
let total = 0;
let warnings = 0;
let loads = 0;

try {
  await conn.query("TRUNCATE TABLE mt_rsdtdsp_rsdt");

  let sql: string | undefined;
  let buf: Buffer = Buffer.alloc(0);

  const load = async (data: Buffer): Promise<void> => {
    pending = data;
    const result = await conn.query(sql!);
    total += Number(result.affectedRows);
    warnings += result.warningStatus;
    loads++;
  };

  for await (const piece of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    buf = Buffer.concat([buf, piece as Buffer]);
    if (sql === undefined) {
      // 先頭のヘッダー行を読み取って、データからは外す
      const eol = buf.indexOf("\r\n");
      if (eol < 0) continue;
      sql = buildSql(buf.subarray(0, eol).toString("utf8"));
      buf = buf.subarray(eol + 2);
    }
    if (buf.length >= chunkBytes) {
      // 行の途中で切らないよう、最後の改行までを送る
      const cut = buf.lastIndexOf("\n") + 1;
      await load(buf.subarray(0, cut));
      buf = buf.subarray(cut);
    }
  }
  if (buf.length > 0) await load(buf);

  report(`v3 LOAD DATA LOCAL INFILE chunk=${chunkBytes / 1024 / 1024}MB`, total, startedAt);
  console.log(`LOAD DATA の回数: ${loads}  警告: ${warnings} 件`);
} finally {
  await conn.end();
}
