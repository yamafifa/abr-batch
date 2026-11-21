/**
 * es:index：MySQL の mt_rsdtdsp_rsdt から、Elasticsearch の検索用インデックスを作り直す
 * - 新しいインデックス（rsdt_日時）に全件を入れてから、別名 rsdt を付け替える。作り直し中も AP の検索は止まらない
 * - MySQL は主キー順にキーセット方式で読む（v4 と同じ）。Elasticsearch には Bulk API でまとめて送る
 * - 件数が MySQL と合わなければ別名を付け替えず、作りかけのインデックスを消して止める
 * - 付け替えたあと、古いインデックス（rsdt_ で始まるもの）を消す
 *
 * 使い方: npm run es:index -- [--batch 1回に送る件数]
 */
import type { Connection } from "mariadb";
import { logEnd, logStart } from "./lib/batch-log.js";
import { ALIAS, INDEX_PREFIX, aliasTargets, es } from "./lib/es.js";
import { fold } from "./lib/fold.js";
import { createConnection } from "./lib/mariadb.js";
import { report } from "./lib/measure.js";
import { ALL_COLUMNS, KEY_COLUMNS, type Row } from "./lib/rsdt-columns.js";
import { stampJst } from "./lib/time.js";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const batchSize = Number(opt("--batch") ?? 5000);

const TABLE = "mt_rsdtdsp_rsdt";

/** 部分一致で探す列（AP の LIKE '%…%' と同じように探せる wildcard 型） */
const WILDCARD_COLUMNS = ["city", "ward", "oaza_cho", "koaza", "chome"] as const;
/** 完全一致で探す列 */
const EXACT_COLUMNS = ["blk_num", "rsdt_num"] as const;

const MAPPING = {
  dynamic: "strict",
  properties: {
    // 主キー 5 列を _ でつないだもの（例：131016_0001001_006_001_）。Rails の to_param と同じ形。
    // 主キーの各列は桁数が決まっていて数字だけなので、この文字列の順 = 主キーの順。並べ替えと search_after に使う
    key: { type: "keyword" },
    // 検索に使う値（fold.ts で文字をそろえたもの）。MySQL の utf8mb4_unicode_ci と同じように見つけるため
    fold: {
      properties: {
        ...Object.fromEntries(WILDCARD_COLUMNS.map((c) => [c, { type: "wildcard" }])),
        ...Object.fromEntries(EXACT_COLUMNS.map((c) => [c, { type: "keyword" }])),
      },
    },
    // 元の 22 列は表示に使うだけなので、検索用の索引を作らない
    ...Object.fromEntries(ALL_COLUMNS.map((c) => [c, { type: "keyword", index: false, doc_values: false }])),
  },
};

const keyString = (r: Row): string => KEY_COLUMNS.map((c) => r[c] ?? "").join("_");

/** キーセット方式の WHERE 句（v4 と同じ。行値の比較は範囲検索にならないので展開する） */
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

async function* dbPages(conn: Connection, pageSize: number): AsyncGenerator<Row[]> {
  let last: Row | undefined;
  for (;;) {
    const where = last ? keysetWhere(last) : { sql: "1", params: [] };
    const rows: Row[] = await conn.query(
      `SELECT ${COLS_SQL} FROM ${TABLE} WHERE ${where.sql} ORDER BY ${ORDER_SQL} LIMIT ${pageSize}`,
      where.params,
    );
    if (rows.length > 0) yield rows;
    if (rows.length < pageSize) return;
    last = rows[rows.length - 1];
  }
}

type BulkResponse = { errors: boolean; items: { index: { _id: string; status: number; error?: unknown } }[] };

async function bulk(index: string, rows: Row[]): Promise<void> {
  const lines: string[] = [];
  for (const r of rows) {
    const key = keyString(r);
    const folded = Object.fromEntries(
      [...WILDCARD_COLUMNS, ...EXACT_COLUMNS].filter((c) => r[c] !== null).map((c) => [c, fold(r[c]!)]),
    );
    lines.push(JSON.stringify({ index: { _id: key } }), JSON.stringify({ key, ...r, fold: folded }));
  }
  const res = await es<BulkResponse>("POST", `/${index}/_bulk`, lines.join("\n") + "\n", "application/x-ndjson");
  if (res.errors) {
    const failed = res.items.filter((i) => i.index.error);
    throw new Error(`Bulk で ${failed.length} 件失敗しました。最初の 1 件: ${JSON.stringify(failed[0])}`);
  }
}

// ---- 本体 ----

const BATCH = "es:index";
const startedAt = process.hrtime.bigint();
const index = `${INDEX_PREFIX}${stampJst()}`;
logStart(BATCH, { index, batchSize });

let conn: Connection | undefined;
let created = false;
let count = 0;

try {
  conn = await createConnection({ dateStrings: true });

  // 取り込み中は refresh（検索に出す処理）を止めて速くする。1 台なので複製は作らない
  await es("PUT", `/${index}`, {
    settings: { number_of_shards: 1, number_of_replicas: 0, refresh_interval: "-1" },
    mappings: MAPPING,
  });
  created = true;

  // DB から次のページを読む間に、前のページを Elasticsearch に送る
  let sending: Promise<void> | undefined;
  for await (const rows of dbPages(conn, batchSize)) {
    await sending;
    sending = bulk(index, rows);
    count += rows.length;
  }
  await sending;

  await es("PUT", `/${index}/_settings`, { index: { refresh_interval: null } });
  await es("POST", `/${index}/_refresh`);

  // 確かめる：MySQL と件数が同じか
  const dbCount = Number(((await conn.query(`SELECT COUNT(*) AS n FROM ${TABLE}`)) as { n: bigint }[])[0]?.n ?? 0);
  const esCount = (await es<{ count: number }>("GET", `/${index}/_count`)).count;
  console.log(`MySQL: ${dbCount.toLocaleString()} 件  Elasticsearch: ${esCount.toLocaleString()} 件`);
  if (esCount !== dbCount || esCount !== count) {
    throw new Error(`件数が合いません（MySQL ${dbCount}、送った件数 ${count}、Elasticsearch ${esCount}）`);
  }

  // 別名を付け替える（外すのと付けるのを 1 回で行うので、AP から見て別名が無くなる瞬間は無い）
  const olds = await aliasTargets();
  await es("POST", "/_aliases", {
    actions: [...olds.map((o) => ({ remove: { index: o, alias: ALIAS } })), { add: { index, alias: ALIAS } }],
  });

  // 古いインデックスを消す（このバッチが作った rsdt_ で始まるものだけ）
  const all = Object.keys(await es<Record<string, unknown>>("GET", `/${INDEX_PREFIX}*?expand_wildcards=open,closed`));
  const deleted = all.filter((i) => i !== index && i.startsWith(INDEX_PREFIX));
  for (const d of deleted) await es("DELETE", `/${d}`);

  report(`es:index batch=${batchSize}`, count, startedAt);
  console.log(`別名 ${ALIAS} → ${index}${deleted.length ? `（消した古いインデックス: ${deleted.join(", ")}）` : ""}`);
  logEnd(BATCH, "SUCCESS", startedAt, { index, count, deleted });
} catch (e) {
  // 作りかけのインデックスは消す（別名はまだ古いほうを指している）
  if (created) await es("DELETE", `/${index}`).catch(() => {});
  logEnd(BATCH, "FAILED", startedAt, { index, count, error: String(e) });
  throw e;
} finally {
  await conn?.end();
}
