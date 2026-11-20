[← README に戻る](../README.md)

# ログ（v4）

ログは `logs/` に 3 種類出します。時刻とファイル名は日本時間です。

| ログ | ファイル | 中身 |
|---|---|---|
| 実行ログ | `batch.log`（追記） | 開始と終了を 1 行ずつ。引数、成功か失敗か、処理時間、件数、エラー内容 |
| 変更ログ | `sync-日時.jsonl.gz` | 追加・更新・削除した行（1 行に 1 件の JSON、gzip 圧縮） |
| SQL ログ | `sql-日時.jsonl.gz` | 実行した SQL、かかった時間、件数（1 文に 1 行、gzip 圧縮） |

実行ログの例（成功と、安全装置で止まったとき。`file` のパスは置き換えています）：

```
2026-11-19T15:18:22.769+09:00 [START] batch="sync:v4" pid=35544 args="data/test_modified.csv" file="/path/to/abr-batch/data/test_modified.csv" dryRun=false batchSize=1000 sqlLog="logs/sql-20261119-151822.jsonl.gz"
2026-11-19T15:18:43.659+09:00 [END] batch="sync:v4" pid=35544 status="SUCCESS" sec=20.89 compared=1750821 unchanged=1747316 insert=927 update=3505 delete=1752 changeLog="logs/sync-20261119-151822.jsonl.gz"
2026-11-19T15:19:05.855+09:00 [END] batch="sync:v4" pid=35684 status="FAILED" sec=0.27 error="Error: CSV の件数が DB より 10% 以上少ないので止めました。…" compared=0 unchanged=0 insert=0 update=0 delete=0
```

- 異常終了しても残るよう、同期書き込みで追記します
- DB に接続できなかったときも `FAILED` とエラー内容が残ります。失敗したときの終了コードは 1 なので、cron などから実行したときに失敗を検知できます

変更ログの例（更新）：

```json
{"at":"2026-11-19T15:18:28.618+09:00","op":"update","key":{"lg_code":"131016","machiaza_id":"0004001","blk_id":"009","rsdt_id":"004","rsdt2_id":""},"changes":{"remarks":[null,"テスト更新"]}}
```

- 追加は追加した行（`after`）、更新は変わった列の変更前と変更後（`changes`）、削除は削除する前の行（`before`）を残します
- 最後の行に、件数のまとめ（`summary`）を書きます

SQL ログの例（DELETE）：

```json
{"at":"2026-11-19T15:18:35.303+09:00","conn":"writer","ms":93.8,"affectedRows":1000,"params":5000,"sql":"DELETE FROM mt_rsdtdsp_rsdt WHERE (`lg_code`, `machiaza_id`, `blk_id`, `rsdt_id`, `rsdt2_id`) IN ((?, ?, ?, ?, ?) ×1000)"}
```

- 引数の値は書きません。1 回で最大 22,000 個になり、ログが巨大になるためです。値は変更ログに残っています
- 同じ形のプレースホルダーの並びは `(?, ?, ?, ?, ?) ×1000` のように縮めて書きます
- `INSERT ... ON DUPLICATE KEY UPDATE` の `affectedRows` は、MySQL の仕様で追加 1 件を 1、更新 1 件を 2 と数えます（例：1,000 件のうち 791 件が更新なら 1,791）

ログは圧縮してあるので、`zgrep` や `zcat` で探せます。

```bash
grep FAILED logs/batch.log                                # 失敗した実行
zgrep -c '"op":"delete"' logs/sync-*.jsonl.gz              # 削除した件数
zgrep '"oaza_cho":"九段南"' logs/sync-*.jsonl.gz            # 特定の住所の変更を探す
zcat logs/sync-20261119-151822.jsonl.gz | tail -1          # 件数のまとめ
zgrep '"error"' logs/sql-*.jsonl.gz                       # 失敗した SQL
```

## ログの圧縮

最初は変更ログを圧縮せずに書いていましたが、変更が大量にあるとログが大きくなりすぎたので、gzip で圧縮するようにしました（SQL ログを入れる前のコードで比べた値です）。

| 場面 | 圧縮前 | 圧縮後 | 時間（圧縮前 → 圧縮後） |
|---|---|---|---|
| 約 6,000 件の差分 | 約 2.1 MB | 96 KB | 19.87 → 20.27 秒 |
| 全件を更新 | 約 345 MB | 6.3 MB | 90.59 → 92.58 秒 |
| 全件を追加 | 約 967 MB | 20 MB | 59.04 → 70.93 秒 |

ログは 20〜50 分の 1 になり、時間の増え方は全件追加でも 12 秒ほどでした。
