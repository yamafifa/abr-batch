# abr-batch

デジタル庁の「アドレス・ベース・レジストリ」（住所の公式データ）を MySQL に取り込むバッチです。
素直に書いた遅い版から始めて、段階的に速くしていく過程と、その計測結果を残します。

## 使うデータ

- 東京都 住居表示-住居マスター（`mt_rsdtdsp_rsdt_pref13.csv`）
- 件数：1,752,573 件（ヘッダー行を除く。2025-10-27 版の CSV で数えたもの）

## 動かし方

```bash
npm install
npm run db:up            # MySQL 8.4 を起動（ポート 3307）
npm run download         # データを data/ にダウンロード
npx prisma migrate deploy   # テーブルを作成
npm run import:naive -- --limit 10000
```

## 計測結果

計測環境：Windows の WSL2 上の Node.js 22、MySQL 8.4 は Rancher Desktop（Docker）上で実行。

| 版 | やり方 | 件数 | 時間 | 速度 | 最大メモリ |
|---|---|---|---|---|---|
| v1 | CSV を丸ごと読み込み、1件ずつ INSERT | 1,000 | 23.26 秒 | 43 件/秒 | 1,337 MB |
| v1 | 同上 | 10,000 | 114.06 秒 | 88 件/秒 | 1,453 MB |

v1 の課題：

- 1件ごとに DB と往復するため、1件あたり約 10 ミリ秒かかる（上の2回の差から計算）
- CSV（約 150 MB）を丸ごと読み込むため、件数が少なくてもメモリを 1.3 GB 以上使う
- この速さのまま全件（約 175 万件）を入れると、5 時間ほどかかる計算になる（実測ではない）

## 技術

TypeScript / Node.js 22 / Prisma 7 / MySQL 8.4 / Docker

## 出典・ライセンス

このリポジトリで扱うデータは、次のデータを加工して作成しています。

- 出典：[デジタル庁 アドレス・ベース・レジストリ](https://www.digital.go.jp/policies/base_registry_address)
- ライセンス：[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.ja)
- データそのものはリポジトリに含めていません（`npm run download` で取得します）
