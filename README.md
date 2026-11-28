# abr-batch

大容量のデータを DB に入れる・更新する・検索するときに、何に気を付けるとよいかを実測で確かめたリポジトリです。
開発のときに参考にできるよう、素直に書いた遅い版から順に作り、計測と原因調査の結果を残しています。

使うデータは、デジタル庁の「アドレス・ベース・レジストリ」（住所の公式データ）のうち、東京都の住居表示データ 1,752,573 件です。

## 確認できたこと

1. **テーブルを丸ごと入れ替えるなら、ローダーが最速。ORM は遅いので、生の SQL を使う**
2. **差分を見て更新するときも、生の SQL を使う**
3. **大量のデータを部分一致で探すなら、元の DB ではなく、検索用のデータを作る**（例として Elasticsearch）

### 1. テーブルの入れ替え：ローダーが最速、ORM より生の SQL

空のテーブルに全件を取り込む時間：

| 版 | やり方 | 全件の時間 | 速度 | 最大メモリ |
|---|---|---|---|---|
| [v1](docs/v1-naive.md) | CSV を丸ごと読み込み、1 件ずつ INSERT | 約 5 時間（計算上） | 88 件/秒 | 1,453 MB |
| [v2](docs/v2-stream.md) | 少しずつ読み、1,000 件ずつまとめて INSERT（ORM：Prisma） | 約 7 分（415.26 秒） | 4,220 件/秒 | 562 MB |
| [v5](docs/v5-query.md) | v2 と同じ流れで、ORM を使わず生の SQL で INSERT | 約 51 秒（50.97 秒） | 34,383 件/秒 | 136 MB |
| [v3](docs/v3-load-data.md) | ローダー（`LOAD DATA LOCAL INFILE`。DB にファイルを直接読ませる） | **約 15 秒（15.11 秒）** | 115,976 件/秒 | 154 MB |

- 同じ「1,000 件ずつの INSERT」でも、ORM（v2）は生の SQL（v5）より約 8 倍遅くなりました。原因は、Prisma が `createMany` のたびに、SQL の組み立て手順を作り直していたことです（[v5 の説明](docs/v5-query.md)）
- v1 は全件を測っていません。10,000 件の計測結果からの計算です
- v2 と v5 は Node.js のヒープ上限を 512 MB にして測った値です
- 番号は作った順です。v5 は v4 の後に作りましたが、v2 と比べやすいよう v2 の次に並べています
- v2・v3・v5 で取り込んだテーブルは、`CHECKSUM TABLE`（テーブルの中身から計算する値）が同じ値（967527444）になり、中身が一致することを確かめています

### 2. 差分の更新：生の SQL を使う

ローダーは「丸ごと入れ替える」ための道具なので、既存のテーブルに差分だけを反映するときは使えません。[v4](docs/v4-sync.md) では、CSV と DB を主キーの順に読み比べて、差分だけを生の SQL（`INSERT ... ON DUPLICATE KEY UPDATE`、1,000 件ずつ）で反映します。

| 場面 | 時間 |
|---|---|
| 約 6,000 件の差分（全件を比べて、差分だけ反映） | 20.36 秒 |
| 全件を更新 | 93.05 秒 |
| 全件を追加（空のテーブルから） | 66.38 秒 |

- 空のテーブルに全件を追加する場面では 66.38 秒で、同じ 1,000 件ずつの INSERT でも、ORM を使う v2（415.26 秒）より約 6 倍速くなりました
- DB を主キーの順に読むとき、`(a, b, c, d, e) > (...)` と書くと、1 ページの読み込みが 1,000 倍以上遅くなりました。`a > ? OR (a = ? AND b > ?) OR ...` に展開して直しています
- CSV の件数が DB より 10% 以上少ないときは、何もせずに止めます。CSV が途中で切れていたときに、大量に削除してしまわないためです（`--max-delete-ratio` で変えられます）
- v4 が出すログ（実行ログ・変更ログ・SQL ログ）の中身と探し方は [docs/logs.md](docs/logs.md) にあります

### 3. 検索：検索用のデータを作る

Web アプリ（[abr-web](#web-アプリabr-web)）の検索は `city LIKE '%町田%'` のような部分一致です。前に `%` が付く LIKE は MySQL のインデックスが効かないので、毎回約 175 万行をすべて読みます。
そこで、DB のデータを Elasticsearch（全文検索のサーバー）に入れる変換バッチ [es:index](docs/es-index.md) を作りました。正本は MySQL のままで、Elasticsearch はいつでも作り直せる検索用のコピーです。

| | 時間 | 最大メモリ |
|---|---|---|
| 全件 1,752,573 件のインデックスを作り直す | 約 57 秒（56.81 秒） | 370 MB |

検索が速くなった効果は、[abr-web](#web-アプリabr-web) の README に載せています。

- 文字の比べ方が MySQL と Elasticsearch で違うため、そのままでは当たる件数が合いませんでした（例：丁目「3」で MySQL は「３丁目」に当たるが、Elasticsearch は 0 件）。入れる側と探す側の両方で文字をそろえて合わせています（[es:index の説明](docs/es-index.md)）

## 見どころ

計測と調査で見つけた問題と、その対処です。

| 見つけた問題 | 対処 | 版 |
|---|---|---|
| 少しずつ読んでいるのに、メモリが 2 GB を超えた。原因は、Prisma のデバッグ用部品が、ログを出さない設定でも直近 100 回分の SQL と引数を取っておく作りだったこと | ヒープスナップショットで原因を特定し、`clearLogs()` で毎回消す | [v2](docs/v2-stream.md) |
| v2 と v5 は同じ 1,000 件ずつの INSERT だが、v2 は約 8 倍遅い。原因は、`createMany` のたびに Prisma が 1,000 件分のデータを含む大きな JSON から SQL の組み立て手順を作り直していたこと（`createMany` ではキャッシュされない） | performance_schema で MySQL の中と外の時間を切り分け、CPU プロファイルで Prisma の中の原因を特定。Prisma を使わず `query` で送る v5 で確かめる | [v5](docs/v5-query.md) |
| ファイル全体を 1 回の `LOAD DATA` で送ると、DB に断られる（`max_allowed_packet` を超える） | CSV を行の切れ目で区切って、何回かに分けて送る | [v3](docs/v3-load-data.md) |
| 配布 CSV の改行が CRLF で、`LOAD DATA` だと最後の列に `\r` が残る | 行の区切りを `'\r\n'` と指定する | [v3](docs/v3-load-data.md) |
| 配布 CSV が、主キー順に並んでいない（374 か所） | 比べる前に毎回並べ替え、読みながら順番もチェックする | [v4](docs/v4-sync.md) |
| キーセット方式で `(a, b, c, d, e) > (...)` と書くと、1 ページの読み込みが 1,000 倍以上遅くなる | `a > ? OR (a = ? AND b > ?) OR ...` に展開する | [v4](docs/v4-sync.md) |
| MySQL と Elasticsearch で、同じ検索の件数が合わない。MySQL の照合順序（`utf8mb4_unicode_ci`）は全角と半角、カタカナとひらがななどを同じ文字として扱うが、Elasticsearch はそのまま比べるため | 入れる側と探す側の両方で、同じ規則で文字をそろえる。互換漢字はそろえない（MySQL が別の文字として扱うため）。914 通りの検索で件数を比べて確かめた | [es:index](docs/es-index.md) |

## Web アプリ（abr-web）

このバッチで作った DB と Elasticsearch を検索・編集する Web アプリです。同じ画面を 5 つの言語・フレームワークで作っています。

- [abr-web-rails](https://github.com/yamafifa/abr-web-rails)（Ruby on Rails）
- [abr-web-laravel](https://github.com/yamafifa/abr-web-laravel)（Laravel）
- [abr-web-symfony](https://github.com/yamafifa/abr-web-symfony)（Symfony）
- [abr-web-spring](https://github.com/yamafifa/abr-web-spring)（Spring Boot）
- [abr-web-ts](https://github.com/yamafifa/abr-web-ts)（Next.js）

## 計測環境

- CPU：AMD Ryzen 7 5700X（8 コア 16 スレッド）
- メモリ：WSL2 に割り当てられたメモリ 31 GB
- Windows の WSL2 上で Node.js 22 を実行し、MySQL 8.4 は Rancher Desktop（Docker）で実行

## 使うデータ

- 東京都 住居表示-住居マスター（`mt_rsdtdsp_rsdt_pref13.csv`）
  - 「○丁目○番○号」の単位の住所の一覧です
- 件数：1,752,573 件（ヘッダー行を除く）
- 大きさ：約 150 MB、UTF-8、改行は CRLF
- 計測に使ったファイルの日付：2025-10-27

## 動かし方

必要なもの：Node.js 22 以降（26.13.1 でも動くことを確かめた）、Docker（Docker Compose）、curl、unzip、sort

```bash
npm install
cp .env.example .env     # DB の接続先（compose.yaml の MySQL に合わせてある）
npm run db:up            # MySQL 8.4（ポート 3307）・Elasticsearch・Kibana を起動
npm run download         # データを data/ にダウンロード
npx prisma generate      # Prisma のクライアントを作る
npx prisma migrate deploy   # テーブルを作る

npm run import:naive -- --limit 10000   # v1（遅いので件数を区切って試す）
npm run import:v2                       # v2（全件）
npm run import:v3                       # v3（全件）
npm run import:v5                       # v5（全件）

npm run sync:v4 -- --dry-run            # v4（差分を調べてログだけ出す）
npm run sync:v4                         # v4（差分を反映する）
bash scripts/make-test-csv.sh           # v4 の確認用に、一部を変えた CSV を作る
npm run sync:v4 -- data/test_modified.csv

npm run es:index                        # DB から Elasticsearch のインデックスを作り直す
npm run es:verify                       # MySQL と Elasticsearch で、同じ検索の件数が同じか比べる（約 7 分）
```

オプション：

- v2：`--batch 件数`（1 回にまとめる件数、既定 1,000）
- v3：`--chunk-mb 大きさ`（1 回の LOAD DATA で送る大きさ、既定 4 MB）
- v4：`--dry-run`（DB を変えずにログだけ出す）、`--batch 件数`（既定 1,000）、`--max-delete-ratio 割合`（既定 0.1）、`--force`（安全装置を無視する）
- v5：`--batch 件数`（1 回にまとめる件数、既定 1,000）
- es:index：`--batch 件数`（1 回の Bulk API で送る件数、既定 5,000）
- es:verify：`--seed 数`（検索語を選ぶ乱数の種、既定 1）、`--pairs 個数`（項目ごとに選ぶ 2 文字の並びの数、既定 300）

### 注意

- **パスワード**：[compose.yaml](compose.yaml) と `.env.example` に書いてあるパスワード（`abr`、`root`）は、手元で試すための決め打ちの値です。本番や共有の DB には使わないでください
- **接続できる範囲**：MySQL（`127.0.0.1:3307`）、Elasticsearch 9.5.5（`127.0.0.1:9200`）、Kibana 9.5.5（`127.0.0.1:5601`、Elasticsearch の管理画面）は、どれも手元の PC からだけ接続できるようにしてあります。Elasticsearch は手元専用なので、ログインを無くしています
- **メモリ**：Elasticsearch と Kibana で、合わせて約 2.5 GB 使います。使わないときは `docker compose stop es kibana` で止められます
- **DB の接続設定**：MySQL 8.4 の標準のログイン方式（`caching_sha2_password`）では、MySQL を起動し直した直後の最初のログインに、暗号化した通信（TLS）かサーバーの公開鍵が必要です。このリポジトリでは TLS を使わないので、`allowPublicKeyRetrieval: true`（公開鍵をサーバーから受け取る）を指定しています（[src/lib/db.ts](src/lib/db.ts)、[src/lib/mariadb.ts](src/lib/mariadb.ts)）

## ファイル構成

| ファイル | 内容 |
|---|---|
| [src/import-naive.ts](src/import-naive.ts) | v1：素直に書いた遅い版 |
| [src/import-v2.ts](src/import-v2.ts) | v2：ストリーミング処理 + まとめて INSERT（Prisma） |
| [src/import-v3.ts](src/import-v3.ts) | v3：LOAD DATA LOCAL INFILE（mariadb ドライバー） |
| [src/sync-v4.ts](src/sync-v4.ts) | v4：差分更新（mariadb ドライバー） |
| [src/import-v5.ts](src/import-v5.ts) | v5：ストリーミング処理 + まとめて INSERT（mariadb ドライバーの `query`） |
| [src/es-index.ts](src/es-index.ts) | es:index：DB から Elasticsearch の検索用インデックスを作り直す |
| [src/es-verify.ts](src/es-verify.ts) | es:verify：MySQL の LIKE と Elasticsearch で、同じ検索の件数が同じか比べる |
| [src/lib/](src/lib/) | 共通部品（DB 接続、Elasticsearch の呼び出し、検索用の文字そろえ、列の定義、計測、実行ログ、SQL ログ、日本時間） |
| [prisma/schema.prisma](prisma/schema.prisma) | テーブルの定義 |
| [scripts/download.sh](scripts/download.sh) | データのダウンロード |
| [scripts/make-test-csv.sh](scripts/make-test-csv.sh) | v4 の確認用 CSV を作る |
| [compose.yaml](compose.yaml) | MySQL 8.4（`LOAD DATA LOCAL` を使えるよう `--local-infile=1` を指定）、Elasticsearch 9.5.5、Kibana 9.5.5 |
| [docs/](docs/) | 各版の詳しい説明（[v1](docs/v1-naive.md)・[v2](docs/v2-stream.md)・[v3](docs/v3-load-data.md)・[v4](docs/v4-sync.md)・[v5](docs/v5-query.md)・[es:index](docs/es-index.md)）と[ログの説明](docs/logs.md) |

## 技術

TypeScript / Node.js 22 以降 / Prisma 7 / mariadb（Node.js 用の MySQL ドライバー）/ MySQL 8.4 / Elasticsearch 9.5 / Docker

## 出典・ライセンス

このリポジトリのコードは [MIT License](LICENSE) です。

使うデータは次のとおりです。MIT License は、このデータには当てはまりません。

- 出典：「[アドレス・ベース・レジストリ](https://www.digital.go.jp/policies/base_registry_address)」（デジタル庁）
- 利用規約：[公共データ利用規約（第1.0版）（PDL1.0）](https://www.digital.go.jp/policies/base_registry_address_tos)
- データそのものはリポジトリに含めていません。`npm run download` で、デジタル庁が配布している元のデータをそのまま取得します
- このリポジトリのバッチで DB・Elasticsearch に入れたデータと、v4 の確認用 CSV（`scripts/make-test-csv.sh` で作る）は、このデータを手元で加工したものです。README と docs に載せた件数・計測結果・例は、このデータをもとに yamafifa が作成したものです
