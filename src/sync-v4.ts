/**
 * v4：差分更新（LOAD DATA を使えない場面向け）
 *
 * 1. CSV を主キー順に並べ替える（OS の sort コマンド。配布ファイルの並び順には頼らない）
 * 2. DB を主キー順に 1,000 件ずつ読む（キーセット方式：前回の最後のキーより後ろを読む）
 * 3. 両方を先頭から同時に読み進めて比べる（マージ比較。メモリは件数によらずほぼ一定）
 *    - CSV にだけある → 追加
 *    - 両方にあって値が違う → 更新
 *    - DB にだけある → 削除
 * 4. 追加・更新は INSERT ... ON DUPLICATE KEY UPDATE、削除は DELETE で、1,000 件ずつ反映する
 * 5. 反映した内容を logs/ に JSON Lines（1 行に 1 件の JSON）を gzip で圧縮して残す（zgrep で探せる）
 *
 * 使い方: npm run sync:v4 -- [--dry-run] [--batch 件数] [--max-delete-ratio 割合] [--force] [CSVのパス]
 *   --dry-run           DB を変えずに、ログだけ出す
 *   --max-delete-ratio  CSV の件数が DB よりこの割合以上少ないときは止める（既定 0.1 = 10%）
 *   --force             上の安全装置を無視して実行する
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream, createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { createGzip, type Gzip } from "node:zlib";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { parse } from "csv-parse";
import { createConnection } from "./lib/mariadb.js";
import { report } from "./lib/measure.js";
import {
  ALL_COLUMNS, KEY_COLUMNS, VALUE_COLUMNS, compareKey, diffValues, keyOf, normalizeCsvRow,
  type Row,
} from "./lib/rsdt-columns.js";

const TABLE = "mt_rsdtdsp_rsdt";

// ---- 引数 ----
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string): boolean => args.includes(name);
const VALUE_OPTS = new Set(["--batch", "--max-delete-ratio"]);
const dryRun = flag("--dry-run");
const force = flag("--force");
const batchSize = Number(opt("--batch") ?? 1000);
const maxDeleteRatio = Number(opt("--max-delete-ratio") ?? 0.1);
const file = resolve(
  args.find((a, i) => !a.startsWith("--") && !VALUE_OPTS.has(args[i - 1] ?? "")) ??
    "data/mt_rsdtdsp_rsdt_pref13.csv",
);

// ---- CSV ----

/** ヘッダー行（列名）と、データ行の件数を数える */
async function scanCsv(path: string): Promise<{ header: string[]; rows: number }> {
  let header = "";
  let lines = 0;
  let headLen = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    if (headLen < 4096) {
      header += chunk.subarray(0, 4096).toString("utf8");
      headLen = header.length;
    }
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) lines++;
  }
  return { header: header.split(/\r?\n/)[0]!.split(","), rows: lines - 1 };
}

/** CSV を主キー順に並べ替えて、1 行ずつ返す */
async function* sortedCsvRows(path: string, header: string[]): AsyncGenerator<Row> {
  const keyFields = KEY_COLUMNS.map((c) => header.indexOf(c) + 1);
  if (keyFields.some((f, i) => f !== i + 1)) {
    throw new Error("CSV の先頭 5 列が主キーになっていない");
  }
  // LC_ALL=C：文字コードの順で並べる（DB の ORDER BY と同じ順になる。主キーは数字だけ）
  // -k1,5：先頭 5 列（主キー）で並べる。区切りの ',' は数字より小さいので、列ごとに比べたのと同じ順になる
  const sort = spawn("sort", ["-t", ",", "-k1,5", "-S", "256M"], {
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const sortDone = new Promise<void>((ok, ng) =>
    sort.on("close", (code) => (code === 0 ? ok() : ng(new Error(`sort が失敗: ${code}`)))),
  );

  // ヘッダー行を外して sort に渡す
  let skipped = false;
  const dropHeader = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (skipped) return cb(null, chunk);
      const eol = chunk.indexOf(10);
      if (eol === -1) return cb();
      skipped = true;
      cb(null, chunk.subarray(eol + 1));
    },
  });
  const feeding = pipeline(createReadStream(path), dropHeader, sort.stdin);

  const parser = sort.stdout.pipe(parse({ columns: header }));
  for await (const r of parser as AsyncIterable<Record<string, string>>) {
    yield normalizeCsvRow(r);
  }
  await feeding;
  await sortDone;
}

// ---- DB ----

/**
 * キーセット方式の WHERE 句。
 * (a, b, c) > (?, ?, ?) と書くと MySQL 8.4 では範囲検索にならず、毎回先頭から読み直すため、
 * a > ? OR (a = ? AND b > ?) OR (a = ? AND b = ? AND c > ?) のように展開する
 */
function keysetWhere(last: Row): { sql: string; params: (string | null)[] } {
  const ors: string[] = [];
  const params: (string | null)[] = [];
  KEY_COLUMNS.forEach((col, i) => {
    const ands = KEY_COLUMNS.slice(0, i).map((c) => {
      params.push(last[c]);
      return `\`${c}\` = ?`;
    });
    ands.push(`\`${col}\` > ?`);
    params.push(last[col]);
    ors.push(`(${ands.join(" AND ")})`);
  });
  return { sql: ors.join(" OR "), params };
}

const COLS_SQL = ALL_COLUMNS.map((c) => `\`${c}\``).join(", ");
const ORDER_SQL = KEY_COLUMNS.map((c) => `\`${c}\``).join(", ");

/** DB を主キー順に、pageSize 件ずつ読んで 1 行ずつ返す */
async function* dbRows(
  conn: Awaited<ReturnType<typeof createConnection>>,
  pageSize: number,
): AsyncGenerator<Row> {
  let last: Row | undefined;
  for (;;) {
    const where = last ? keysetWhere(last) : { sql: "1", params: [] };
    const rows: Row[] = await conn.query(
      `SELECT ${COLS_SQL} FROM ${TABLE} WHERE ${where.sql} ORDER BY ${ORDER_SQL} LIMIT ${pageSize}`,
      where.params,
    );
    for (const r of rows) yield r;
    if (rows.length < pageSize) return;
    last = rows[rows.length - 1];
  }
}

// ---- 本体 ----

const startedAt = process.hrtime.bigint();
const reader = await createConnection({ dateStrings: true });
const writer = await createConnection();

// ログは安全装置のチェックを通ってから作る（止めたときに空のログを残さない）
// gzip で圧縮して書く。全件追加のような大量の変更では、圧縮しないと 1 GB 近くになるため
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const logPath = `logs/sync-${stamp}${dryRun ? "-dryrun" : ""}.jsonl.gz`;
let gzip: Gzip | undefined;
let logFile: WriteStream | undefined;

/** ログをまとめて書く。圧縮が追いつかないときは待つ（メモリに溜めすぎない） */
async function writeLogs(entries: object[]): Promise<void> {
  if (entries.length === 0) return;
  const at = new Date().toISOString();
  const text = entries.map((e) => JSON.stringify({ at, ...e })).join("\n") + "\n";
  if (!gzip!.write(text)) await once(gzip!, "drain");
}

const counts = { compared: 0, unchanged: 0, insert: 0, update: 0, delete: 0 };

/** 追加・更新：反映待ちの行と、反映後に書くログ */
let upserts: { row: Row; log: object }[] = [];
/** 削除：反映待ちの行 */
let deletes: Row[] = [];

const UPSERT_UPDATE_SQL = VALUE_COLUMNS.map((c) => `\`${c}\` = new.\`${c}\``).join(", ");
const ROW_PLACEHOLDER = `(${ALL_COLUMNS.map(() => "?").join(", ")})`;
const KEY_PLACEHOLDER = `(${KEY_COLUMNS.map(() => "?").join(", ")})`;

async function flushUpserts(): Promise<void> {
  if (upserts.length === 0) return;
  if (!dryRun) {
    // VALUES() 関数は MySQL 8.0.20 から非推奨なので、行の別名（AS new）で参照する
    await writer.query(
      `INSERT INTO ${TABLE} (${COLS_SQL}) VALUES ${upserts.map(() => ROW_PLACEHOLDER).join(", ")}
       AS new ON DUPLICATE KEY UPDATE ${UPSERT_UPDATE_SQL}`,
      upserts.flatMap((u) => ALL_COLUMNS.map((c) => u.row[c])),
    );
  }
  await writeLogs(upserts.map((u) => u.log));
  upserts = [];
}

async function flushDeletes(): Promise<void> {
  if (deletes.length === 0) return;
  if (!dryRun) {
    await writer.query(
      `DELETE FROM ${TABLE} WHERE (${ORDER_SQL}) IN (${deletes.map(() => KEY_PLACEHOLDER).join(", ")})`,
      deletes.flatMap((r) => KEY_COLUMNS.map((c) => r[c])),
    );
  }
  await writeLogs(deletes.map((r) => ({ op: "delete", key: keyOf(r), before: r })));
  deletes = [];
}

try {
  // 安全装置：CSV が途中で切れているなどで件数が大きく減っていたら、大量に削除する前に止める
  const { header, rows: csvCount } = await scanCsv(file);
  const [{ n: dbCountRaw }] = await reader.query(`SELECT COUNT(*) AS n FROM ${TABLE}`);
  const dbCount = Number(dbCountRaw);
  console.log(`CSV: ${csvCount.toLocaleString()} 件  DB: ${dbCount.toLocaleString()} 件`);
  if (dbCount > 0 && csvCount < dbCount * (1 - maxDeleteRatio) && !force) {
    throw new Error(
      `CSV の件数が DB より ${(maxDeleteRatio * 100).toFixed(0)}% 以上少ないので止めました。` +
        "CSV が正しいことを確かめてから --force を付けて実行してください",
    );
  }

  mkdirSync("logs", { recursive: true });
  gzip = createGzip();
  logFile = createWriteStream(logPath);
  gzip.pipe(logFile);

  const csvIt = sortedCsvRows(file, header);
  const dbIt = dbRows(reader, batchSize);
  let c = (await csvIt.next()).value as Row | undefined;
  let d = (await dbIt.next()).value as Row | undefined;
  let prevC: Row | undefined;
  let prevD: Row | undefined;

  const nextC = async (): Promise<void> => {
    prevC = c;
    c = (await csvIt.next()).value as Row | undefined;
    if (c && prevC && compareKey(prevC, c) >= 0) {
      throw new Error(`CSV の並びがおかしい（主キーの重複か並べ替えの失敗）: ${JSON.stringify(keyOf(c))}`);
    }
  };
  const nextD = async (): Promise<void> => {
    prevD = d;
    d = (await dbIt.next()).value as Row | undefined;
    if (d && prevD && compareKey(prevD, d) >= 0) {
      throw new Error(`DB の並びが CSV の比べ方と合わない: ${JSON.stringify(keyOf(d))}`);
    }
  };

  while (c || d) {
    const cmp = !d ? -1 : !c ? 1 : compareKey(c, d);
    if (cmp < 0) {
      // CSV にだけある → 追加
      upserts.push({ row: c!, log: { op: "insert", key: keyOf(c!), after: c } });
      counts.insert++;
      await nextC();
    } else if (cmp > 0) {
      // DB にだけある → 削除
      deletes.push(d!);
      counts.delete++;
      await nextD();
    } else {
      // 両方にある → 値を比べる
      counts.compared++;
      const changes = diffValues(d!, c!);
      if (Object.keys(changes).length > 0) {
        upserts.push({ row: c!, log: { op: "update", key: keyOf(c!), changes } });
        counts.update++;
      } else {
        counts.unchanged++;
      }
      await nextC();
      await nextD();
    }
    if (upserts.length >= batchSize) await flushUpserts();
    if (deletes.length >= batchSize) await flushDeletes();
  }
  await flushUpserts();
  await flushDeletes();

  const total = counts.compared + counts.insert + counts.delete;
  report(`v4 sync${dryRun ? " (dry-run)" : ""} batch=${batchSize}`, total, startedAt);
  console.log(
    `変更なし: ${counts.unchanged.toLocaleString()}  追加: ${counts.insert.toLocaleString()}  ` +
      `更新: ${counts.update.toLocaleString()}  削除: ${counts.delete.toLocaleString()}`,
  );
  await writeLogs([{ op: "summary", dryRun, file, ...counts }]);
  console.log(`ログ: ${logPath}`);
} finally {
  if (gzip && logFile) {
    const closed = once(logFile, "close");
    gzip.end();
    await closed;
  }
  await reader.end();
  await writer.end();
}
