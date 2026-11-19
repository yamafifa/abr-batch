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
npx prisma migrate dev   # テーブルを作成
npm run import:naive -- --limit 10000
```

## 計測結果

（計測後に記入）

| 版 | やり方 | 件数 | 時間 | 速度 | 最大メモリ |
|---|---|---|---|---|---|
| v1 | CSV を丸ごと読み込み、1件ずつ INSERT | | | | |

## 技術

TypeScript / Node.js 22 / Prisma 7 / MySQL 8.4 / Docker

## 出典・ライセンス

このリポジトリで扱うデータは、次のデータを加工して作成しています。

- 出典：[デジタル庁 アドレス・ベース・レジストリ](https://www.digital.go.jp/policies/base_registry_address)
- ライセンス：[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.ja)
- データそのものはリポジトリに含めていません（`npm run download` で取得します）
