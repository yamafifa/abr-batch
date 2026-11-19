/**
 * 差分更新の動作確認用に、元の CSV から「一部を削除・変更・追加した CSV」を作る
 * - データ行の 1,000 行に 1 行を削除
 * - 500 行に 1 行（上と重ならない行）の remarks を変更
 * - 1,700 行に 1 行、rsdt2_id を「T + 連番」にした新しい行を追加
 *
 * 使い方: npx tsx src/tools/make-diff-csv.ts [元のCSV] [出力先]
 */
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

const src = process.argv[2] ?? "data/mt_rsdtdsp_rsdt_pref13.csv";
const dst = process.argv[3] ?? "data/test_modified.csv";

const out = createWriteStream(dst);
const lines = createInterface({ input: createReadStream(src), crlfDelay: Infinity });

let header: string[] | undefined;
let i = 0;
let added = 0;
const counts = { deleted: 0, updated: 0, added: 0 };

for await (const line of lines) {
  if (!header) {
    header = line.split(",");
    out.write(line + "\r\n");
    continue;
  }
  i++;
  const f = line.split(",");
  if (i % 1000 === 0) {
    counts.deleted++;
    continue;
  }
  if (i % 500 === 250) {
    f[header.indexOf("remarks")] = "テスト更新";
    counts.updated++;
  }
  out.write(f.join(",") + "\r\n");
  if (i % 1700 === 0) {
    const g = line.split(",");
    g[header.indexOf("rsdt2_id")] = `T${String(++added).padStart(4, "0")}`;
    out.write(g.join(",") + "\r\n");
    counts.added++;
  }
}
await new Promise((ok) => out.end(ok));
console.log(counts);
