#!/usr/bin/env bash
# 並列 8〜256 を順に流す。段の間に65秒あけ、前の段の要求が次の段の1分窓に入らないようにする。
# 途中で止まっても、同じコマンドで流し直せば各段とも未処理の分だけ送る。
set -u
cd "$(dirname "$0")/../.."
STAGES=${STAGES:-"8:800 16:1200 32:2400 64:5000 128:18000 256:20000"}
first=1
for s in $STAGES; do
  c=${s%%:*}; n=${s##*:}
  if [ "$first" -eq 0 ]; then sleep 65; fi
  first=0
  echo "=== c$c count=$n $(date +%H:%M:%S)"
  node experiments/gemini-decision-1-concurrency/bench.mjs --concurrency "$c" --count "$n"
  rc=$?
  echo "RC_c$c=$rc"
  if [ "$rc" -ne 0 ]; then echo "__STAGES_DONE__ aborted at c$c"; exit "$rc"; fi
done
echo "__STAGES_DONE__ $(date +%H:%M:%S)"
