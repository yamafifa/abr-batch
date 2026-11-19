#!/usr/bin/env bash
# アドレス・ベース・レジストリ（デジタル庁）から東京都の住居表示-住居マスターを取得する
# 出典：デジタル庁 アドレス・ベース・レジストリ（CC BY 4.0）
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
URL="https://data.address-br.digital.go.jp/mt_rsdtdsp_rsdt/pref/mt_rsdtdsp_rsdt_pref13.csv.zip"
curl -fSL -o data/mt_rsdtdsp_rsdt_pref13.csv.zip "$URL"
unzip -o data/mt_rsdtdsp_rsdt_pref13.csv.zip -d data
wc -l data/mt_rsdtdsp_rsdt_pref13.csv
