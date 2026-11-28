/**
 * es:verify：MySQL の LIKE と Elasticsearch の wildcard で、同じ検索の件数が同じになるか比べる
 * - AP の DB 検索（LIKE '%…%'）と Elasticsearch 検索（fold でそろえてから wildcard）を、同じ検索語で数えて比べる
 * - 検索語は、検索する項目（市区町村・町字・丁目）ごとに作る
 *   - その項目の値に出てくる文字すべて
 *   - 2 文字の並びから、無作為に --pairs 個（既定 300）。乱数の種（--seed、既定 1）が同じなら、DB が同じ限り同じ検索語になる
 *   - 全角・半角・かなの例（EXTRA）
 * - 結果は logs/es-verify-日時.tsv に、検索語ごとに書く（logs/ は Git に入れない）
 * - 先に npm run es:index で、Elasticsearch の中身を今の DB にそろえておく。AP で編集・削除したあとだと、その分も合わなくなる
 *
 * 使い方: npm run es:verify -- [--seed 1] [--pairs 300]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { Connection } from "mariadb";
import { ALIAS, es } from "./lib/es.js";
import { fold } from "./lib/fold.js";
import { createConnection } from "./lib/mariadb.js";
import { stampJst } from "./lib/time.js";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const seed = Number(opt("--seed") ?? 1);
const pairCount = Number(opt("--pairs") ?? 300);

const TABLE = "mt_rsdtdsp_rsdt";

/** 検索する項目と、その項目で探す列（AP と同じ。どれかの列に当たればよい） */
const GROUPS: [string, string[]][] = [
  ["city", ["city", "ward"]],
  ["town", ["oaza_cho", "koaza"]],
  ["chome", ["chome"]],
];

/** 文字の比べ方の違いが出やすい例（全角・半角、かな、濁点、小さい仮名、大文字・小文字） */
const EXTRA = ["3", "１", "あ", "ア", "は", "ﾊﾟ", "ヶ", "が", "A", "ａ"];

/** 種を決められる乱数（mulberry32）。同じ種なら同じ並びになる */
function random(s: number): () => number {
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 並びを混ぜて、先頭から n 個取る（Fisher–Yates） */
function sample<T>(list: T[], n: number, rand: () => number): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

/** LIKE の特別な文字（% _ \）を、ただの文字として探す */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** wildcard の特別な文字（* ? \）を、ただの文字として探す */
const wildcardEscape = (s: string) => s.replace(/[\\*?]/g, (c) => `\\${c}`);

async function terms(conn: Connection, cols: string[], rand: () => number): Promise<string[]> {
  const vals: { v: string }[] = await conn.query(
    cols.map((c) => `SELECT DISTINCT \`${c}\` AS v FROM ${TABLE} WHERE \`${c}\` IS NOT NULL`).join(" UNION "),
  );
  const chars = new Set<string>();
  const pairs = new Set<string>();
  for (const { v } of vals) {
    const a = [...v];
    a.forEach((c) => chars.add(c));
    for (let i = 0; i + 1 < a.length; i++) pairs.add(a[i]! + a[i + 1]!);
  }
  // DB から返る順は決まっていないので、並べてから選ぶ（同じ種で同じ検索語にするため）
  const picked = sample([...pairs].sort(), pairCount, rand);
  return [...new Set([...[...chars].sort(), ...picked, ...EXTRA])];
}

async function mysqlCount(conn: Connection, cols: string[], term: string): Promise<number> {
  const where = cols.map((c) => `\`${c}\` LIKE ?`).join(" OR ");
  const rows: { n: bigint }[] = await conn.query(
    `SELECT COUNT(*) AS n FROM ${TABLE} WHERE ${where}`,
    cols.map(() => `%${likeEscape(term)}%`),
  );
  return Number(rows[0]?.n ?? 0);
}

async function esCount(cols: string[], term: string): Promise<number> {
  const value = `*${wildcardEscape(fold(term))}*`;
  const query = { bool: { should: cols.map((c) => ({ wildcard: { [`fold.${c}`]: { value } } })), minimum_should_match: 1 } };
  return (await es<{ count: number }>("POST", `/${ALIAS}/_count`, { query })).count;
}

// ---- 本体 ----

const conn = await createConnection();
const rand = random(seed);
const lines = ["group\tterm\tmysql\tes\tsame"];
let total = 0;
let bad = 0;

try {
  // 全件の数がずれていたら、Elasticsearch の中身が古い
  const all = Number(((await conn.query(`SELECT COUNT(*) AS n FROM ${TABLE}`)) as { n: bigint }[])[0]?.n ?? 0);
  const esAll = (await es<{ count: number }>("GET", `/${ALIAS}/_count`)).count;
  if (all !== esAll) {
    console.log(`全件の数が違います（MySQL ${all}、Elasticsearch ${esAll}）。先に npm run es:index を実行してください`);
  }

  for (const [group, cols] of GROUPS) {
    for (const t of await terms(conn, cols, rand)) {
      const my = await mysqlCount(conn, cols, t);
      const e = await esCount(cols, t);
      total++;
      lines.push(`${group}\t${t}\t${my}\t${e}\t${my === e ? 1 : 0}`);
      if (my !== e) {
        bad++;
        console.log(`${cols.join("|")} ${JSON.stringify(t)} MySQL=${my} ES=${e}`);
      }
    }
  }
} finally {
  await conn.end();
}

mkdirSync("logs", { recursive: true });
const file = `logs/es-verify-${stampJst()}.tsv`;
writeFileSync(file, lines.join("\n") + "\n");
console.log(`比べた数 ${total}  合わない ${bad}  （seed=${seed} pairs=${pairCount}、検索語ごとの結果: ${file}）`);
