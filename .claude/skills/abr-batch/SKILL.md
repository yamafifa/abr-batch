---
name: abr-batch
description: abr-batch（ABR 住所データを MySQL に取り込むバッチ）で、計測・検証・原因調査・ドキュメント更新をするときの手順と、これまでに分かった落とし穴。新しい版の追加、計測のやり直し、遅さやメモリの原因調査、docs/ や README の更新をするときに使う。
---

# abr-batch の作業手順と知見

## 前提

- データ：ABR 東京都 住居表示-住居マスター `data/mt_rsdtdsp_rsdt_pref13.csv`（1,752,573 件、約 150 MB、UTF-8、**改行 CRLF**、22 列、主キー 5 列）
- DB：MySQL 8.4（`compose.yaml`、ポート 3307、`--local-infile=1`）。接続先は `.env` の `DATABASE_URL`
- 版：v1 `import:naive` / v2 `import:v2`（Prisma createMany）/ v3 `import:v3`（LOAD DATA）/ v4 `sync:v4`（差分更新）/ v5 `import:v5`（query で INSERT）
- v1・v2・v3・v5 は実行前にテーブルを空にする。作業の最後は `npm run import:v3`（約 15 秒）で元のデータに戻す

## 計測のやり方

1. **全件で測る。** `--limit` で区切るのは v1 と、CPU プロファイルを取るときだけ
2. v2・v5 は、代表値と条件をそろえて **ヒープ上限 512 MB** で測る：`NODE_OPTIONS=--max-old-space-size=512 npm run import:v2`
3. **出力は全部残す**（`> ファイル 2>&1`）。`tail` で数行だけにすると、失敗したときにエラー本文が消える
4. 7 分ほどかかるもの（v2 の全件）は、バックグラウンドで実行する
5. 結果は `CHECKSUM TABLE` で確かめる

```bash
docker compose exec -T db mysql -uabr -pabr abr -e 'select count(*) from mt_rsdtdsp_rsdt; checksum table mt_rsdtdsp_rsdt'
```

| データ | チェックサム |
|---|---|
| 元の CSV（1,752,573 件。どの版でもこの値になる） | 967527444 |
| `data/test_modified.csv` を反映した後（`bash scripts/make-test-csv.sh` で作る） | 1329018278 |

## 原因調査の道具

- **MySQL の中と外の時間を分ける**：[scripts/server-time.sh](scripts/server-time.sh)。計測の直前に `reset`、直後に `show` を実行する。「全体の時間 − MySQL の中の時間」が Node.js 側の時間になる
- **Node.js 側のどこが重いか**：CPU プロファイルを取って、[scripts/analyze-cpuprofile.py](scripts/analyze-cpuprofile.py) で集計する。tsx は複数のプロセスで動くので、プロファイルが複数できる。ほぼ全部が `(idle)` のものは無視して、中身のあるものを見る

```bash
NODE_OPTIONS="--max-old-space-size=512 --cpu-prof --cpu-prof-dir=/tmp/abr-prof" npm run import:v2 -- --limit 200000
python3 -I .claude/skills/abr-batch/scripts/analyze-cpuprofile.py /tmp/abr-prof/CPU.*.cpuprofile
```

- **メモリが増える原因**：ヒープスナップショットを撮って、参照元をたどる

## 分かっている落とし穴（詳しくは docs/）

| 症状 | 原因と対処 | 詳しく |
|---|---|---|
| DB を起動し直した直後だけ `RSA public key is not available` で止まる | `caching_sha2_password` は、再起動直後の最初のログインに TLS か公開鍵が必要。接続設定の `allowPublicKeyRetrieval: true`（`src/lib/db.ts`、`src/lib/mariadb.ts`）で対処済み。新しい接続は必ず `src/lib/mariadb.ts` の `createConnection` を使う | README「動かし方」 |
| Prisma の createMany でメモリが 2 GB を超える | `@prisma/debug` が直近 100 回分の SQL と引数を持っている。毎回 `clearLogs()` を呼ぶ | docs/v2-stream.md |
| Prisma の createMany が遅い（v5 の約 8 倍） | Prisma 7.10.1 は createMany のときクエリプランをキャッシュせず、毎回約 118 万文字の JSON から組み立て直す（CPU 時間の 58.6%）。大量 INSERT には Prisma を使わない | docs/v5-query.md |
| LOAD DATA で最後の列に `\r` が残る | `LINES TERMINATED BY '\r\n'` | docs/v3-load-data.md |
| LOAD DATA が DB に断られる | `max_allowed_packet`（64 MB）を超えている。行の切れ目で 4 MB ずつ区切って送る | docs/v3-load-data.md |
| マージ比較が合わない | 配布 CSV は主キー順ではない（374 か所）。`LC_ALL=C sort -t, -k1,5` で並べ替える | docs/v4-sync.md |
| キーセット方式の読み込みが 1,000 倍以上遅い | `(a,b,c,d,e) > (...)` は範囲検索にならない。`a > ? OR (a = ? AND b > ?) OR ...` に展開する | docs/v4-sync.md |

## ドキュメントの決まり

- README は入口（概要・結果のまとめ・計測環境・見どころ・動かし方・ファイル構成）。版ごとの詳しい説明は `docs/版-名前.md` に置く
- 各版の docs は「← README に戻る → 概要 → 実行コマンド → 計測結果 → 詳しい説明（見つけた問題・仕組み・原因）」の順にそろえる
- **実際に測った数字だけを書く。** 計算した値は「計算上」、測っていない推測は「考えられます」、分からないことは「分かっていないこと」と書き分ける
- 新しい版を足したら、README の結果のまとめ・見どころ・動かし方・オプション・ファイル構成と、`package.json` の scripts も直す
- 直したら、ファイル間のリンクが切れていないか確かめる

```bash
for f in README.md docs/*.md; do d=$(dirname $f); grep -oE '\]\([^)#:]+' $f | sed -E 's/^\]\(//' | grep -v '^http' | while read p; do [ -e "$d/$p" ] || echo "BROKEN $f -> $p"; done; done
```

## コミット

- ユーザーの了解を取ってから、コミットと push をする。内容が分かれるときは、分けてコミットする
- コミットメッセージは日本語。最後に `Co-Authored-By` の行を付ける
- リポジトリは GitHub の非公開リポジトリ。`data/`、`logs/`、`.env` は Git に入れない
