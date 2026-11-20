# abr-batch

デジタル庁の「アドレス・ベース・レジストリ」（住所の公式データ）を MySQL に取り込むバッチです。
素直に書いた遅い版から始めて、計測しながら段階的に速くしていった過程を残しています。
後半の v4 では、`LOAD DATA` を使えない場面を想定して、CSV と DB の差分だけを反映する差分更新を作りました。

## 結果のまとめ

東京都の住居表示データ 1,752,573 件を、空のテーブルに取り込む時間：

| 版 | やり方 | 全件の時間 | 速度 | 最大メモリ |
|---|---|---|---|---|
| [v1](docs/v1-naive.md) | CSV を丸ごと読み込み、1 件ずつ INSERT | 約 5 時間（計算上） | 88 件/秒 | 1,453 MB |
| [v2](docs/v2-stream.md) | ストリーミング処理 + 1,000 件ずつまとめて INSERT（Prisma） | 約 7 分（415.26 秒） | 4,220 件/秒 | 562 MB |
| [v3](docs/v3-load-data.md) | `LOAD DATA LOCAL INFILE` で DB に直接読み込ませる | **約 15 秒（15.11 秒）** | 115,976 件/秒 | 154 MB |

- v1 は全件を測っていません。10,000 件の計測結果からの計算です（[v1 の説明](docs/v1-naive.md)を参照）
- v2 は Node.js のヒープ上限を 512 MB にして測った値です
- v2 と v3 で取り込んだテーブルは、`CHECKSUM TABLE`（テーブルの中身から計算する値）が同じ値（967527444）になり、中身が一致することを確かめています

既存のテーブルに差分だけを反映する [v4](docs/v4-sync.md)（`INSERT ... ON DUPLICATE KEY UPDATE`、1,000 件ずつ）：

| 場面 | 時間 |
|---|---|
| 約 6,000 件の差分（全件を比べて、差分だけ反映） | 20.36 秒 |
| 全件を更新 | 93.05 秒 |
| 全件を追加（空のテーブルから） | 66.38 秒 |

v4 が出すログ（実行ログ・変更ログ・SQL ログ）の中身と探し方は [docs/logs.md](docs/logs.md) にあります。

## 計測環境

- CPU：AMD Ryzen 7 5700X（8 コア 16 スレッド）
- メモリ：WSL2 に割り当てられたメモリ 31 GB
- Windows の WSL2 上で Node.js 22 を実行し、MySQL 8.4 は Rancher Desktop（Docker）で実行

## 見どころ

計測と調査で見つけた問題と、その対処です。詳しくは各版の説明（`docs/`）にあります。

| 見つけた問題 | 対処 | 版 |
|---|---|---|
| 少しずつ読んでいるのに、メモリが 2 GB を超えた。原因は、Prisma のデバッグ用部品が、ログを出さない設定でも直近 100 回分の SQL と引数を取っておく作りだったこと | ヒープスナップショットで原因を特定し、`clearLogs()` で毎回消す | [v2](docs/v2-stream.md) |
| ファイル全体を 1 回の `LOAD DATA` で送ると、DB に断られる（`max_allowed_packet` を超える） | CSV を行の切れ目で区切って、何回かに分けて送る | [v3](docs/v3-load-data.md) |
| 配布 CSV の改行が CRLF で、`LOAD DATA` だと最後の列に `\r` が残る | 行の区切りを `'\r\n'` と指定する | [v3](docs/v3-load-data.md) |
| 配布 CSV が、主キー順に並んでいない（374 か所） | 比べる前に毎回並べ替え、読みながら順番もチェックする | [v4](docs/v4-sync.md) |
| キーセット方式で `(a, b, c, d, e) > (...)` と書くと、1 ページの読み込みが 1,000 倍以上遅くなる | `a > ? OR (a = ? AND b > ?) OR ...` に展開する | [v4](docs/v4-sync.md) |

## 使うデータ

- 東京都 住居表示-住居マスター（`mt_rsdtdsp_rsdt_pref13.csv`）
  - 「○丁目○番○号」の単位の住所の一覧です
- 件数：1,752,573 件（ヘッダー行を除く）
- 大きさ：約 150 MB、UTF-8、改行は CRLF
- 計測に使ったファイルの日付：2025-10-27

## 動かし方

必要なもの：Node.js 22、Docker（Docker Compose）、curl、unzip、sort

```bash
npm install
cp .env.example .env     # DB の接続先（compose.yaml の MySQL に合わせてある）
npm run db:up            # MySQL 8.4 を起動（ポート 3307）
npm run download         # データを data/ にダウンロード
npx prisma generate      # Prisma のクライアントを作る
npx prisma migrate deploy   # テーブルを作る

npm run import:naive -- --limit 10000   # v1（遅いので件数を区切って試す）
npm run import:v2                       # v2（全件）
npm run import:v3                       # v3（全件）

npm run sync:v4 -- --dry-run            # v4（差分を調べてログだけ出す）
npm run sync:v4                         # v4（差分を反映する）
bash scripts/make-test-csv.sh           # v4 の確認用に、一部を変えた CSV を作る
npm run sync:v4 -- data/test_modified.csv
```

オプション：

- v2：`--batch 件数`（1 回にまとめる件数、既定 1,000）
- v3：`--chunk-mb 大きさ`（1 回の LOAD DATA で送る大きさ、既定 4 MB）
- v4：`--dry-run`（DB を変えずにログだけ出す）、`--batch 件数`（既定 1,000）、`--max-delete-ratio 割合`（既定 0.1）、`--force`（安全装置を無視する）

DB の接続について：MySQL 8.4 の標準のログイン方式（`caching_sha2_password`）では、MySQL を起動し直した直後の最初のログインに、暗号化した通信（TLS）かサーバーの公開鍵が必要です。このリポジトリでは TLS を使わないので、接続設定で `allowPublicKeyRetrieval: true`（公開鍵をサーバーから受け取る）を指定しています（[src/lib/db.ts](src/lib/db.ts)、[src/lib/mariadb.ts](src/lib/mariadb.ts)）。手元の Docker の DB に接続する前提の設定です。

## ファイル構成

| ファイル | 内容 |
|---|---|
| [src/import-naive.ts](src/import-naive.ts) | v1：素直に書いた遅い版 |
| [src/import-v2.ts](src/import-v2.ts) | v2：ストリーミング処理 + まとめて INSERT（Prisma） |
| [src/import-v3.ts](src/import-v3.ts) | v3：LOAD DATA LOCAL INFILE（mariadb ドライバー） |
| [src/sync-v4.ts](src/sync-v4.ts) | v4：差分更新（mariadb ドライバー） |
| [src/lib/](src/lib/) | 共通部品（DB 接続、列の定義、計測、実行ログ、SQL ログ、日本時間） |
| [prisma/schema.prisma](prisma/schema.prisma) | テーブルの定義 |
| [scripts/download.sh](scripts/download.sh) | データのダウンロード |
| [scripts/make-test-csv.sh](scripts/make-test-csv.sh) | v4 の確認用 CSV を作る |
| [compose.yaml](compose.yaml) | MySQL 8.4（`LOAD DATA LOCAL` を使えるよう `--local-infile=1` を指定） |
| [docs/](docs/) | 各版の詳しい説明（[v1](docs/v1-naive.md)・[v2](docs/v2-stream.md)・[v3](docs/v3-load-data.md)・[v4](docs/v4-sync.md)）と[ログの説明](docs/logs.md) |

## 技術

TypeScript / Node.js 22 / Prisma 7 / mariadb（Node.js 用の MySQL ドライバー）/ MySQL 8.4 / Docker

## 出典・ライセンス

このリポジトリで扱うデータは、次のデータを加工して作成しています。

- 出典：[デジタル庁 アドレス・ベース・レジストリ](https://www.digital.go.jp/policies/base_registry_address)
- ライセンス：[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.ja)
- データそのものはリポジトリに含めていません（`npm run download` で取得します）
