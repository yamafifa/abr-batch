#!/usr/bin/env bash
# v4（差分更新）の動作確認用に、元の CSV から一部を変えたテスト用 CSV を作る
#
# 作るファイル：
#   data/test_modified.csv     データ行の 1,000 行に 1 行を削除、500 行に 1 行（削除と重ならない行）の
#                              remarks を「テスト更新」に変更、1,700 行に 1 行（削除した行を除く）、
#                              rsdt2_id を「T + 4 桁の連番」にした行を追加
#   data/test_all_updated.csv  全行の remarks を「全件更新テスト」に変更
#
# 使い方: bash scripts/make-test-csv.sh [元のCSV]
# ABR の CSV は改行が CRLF なので、行末の \r を保ったまま書き換える
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:-data/mt_rsdtdsp_rsdt_pref13.csv}"

awk 'BEGIN { FS = OFS = "," }
NR == 1 { print; next }
{
  i = NR - 1
  if (i % 1000 == 0) { deleted++; next }
  line = $0
  if (i % 500 == 250) { $NF = "テスト更新\r"; updated++ }
  print
  if (i % 1700 == 0) {
    $0 = line
    $5 = sprintf("T%04d", ++added)
    print
  }
}
END { printf "test_modified.csv: 削除 %d 行、更新 %d 行、追加 %d 行\n", deleted, updated, added > "/dev/stderr" }
' "$SRC" > data/test_modified.csv

awk 'BEGIN { FS = OFS = "," }
NR == 1 { print; next }
{ $NF = "全件更新テスト\r"; print }
END { printf "test_all_updated.csv: 更新 %d 行\n", NR - 1 > "/dev/stderr" }
' "$SRC" > data/test_all_updated.csv
