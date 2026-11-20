#!/usr/bin/env bash
# MySQL の中で使った SQL の時間を、種類ごとに測る（performance_schema）
#   bash server-time.sh reset   … 集計を空にする（計測の直前に実行）
#   bash server-time.sh show    … 集計を表示する（計測の直後に実行）
# 送り方で集計先が分かれる：query は statement/sql/insert、プリペアドステートメントは statement/com/Execute・Prepare・Close stmt
set -euo pipefail
cd "$(dirname "$0")/../../../.."   # リポジトリの直下
M() { docker compose exec -T db mysql -uabr -pabr abr -e "$1" 2>/dev/null; }
case "${1:-show}" in
  reset) M "truncate performance_schema.events_statements_summary_global_by_event_name" ;;
  show)  M "select EVENT_NAME, COUNT_STAR n, round(SUM_TIMER_WAIT/1e12,2) sec
            from performance_schema.events_statements_summary_global_by_event_name
            where COUNT_STAR>0 order by SUM_TIMER_WAIT desc limit 8" ;;
  *) echo "使い方: $0 reset|show" >&2; exit 1 ;;
esac
