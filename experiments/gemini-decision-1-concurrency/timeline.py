"""段ごとの10秒刻みの推移（完了件数・429 の回数・直前60秒の入力トークン）を表にする。

使い方: PYTHONUTF8=1 python experiments/gemini-decision-1-concurrency/timeline.py c128 c256
台帳は seq ごとに最終行勝ちで読む。429 の時刻は attemptLog に無いため、記録の終了時刻で数える（近似）。
"""
import json
import sys
from pathlib import Path

RESULTS = Path(__file__).resolve().parent / 'results'


def load(stage):
    rows = {}
    for line in (RESULTS / f'{stage}.jsonl').read_text(encoding='utf-8').splitlines():
        if line.strip():
            r = json.loads(line)
            rows[r['seq']] = r
    return list(rows.values())


def main(stages):
    for stage in stages:
        if not (RESULTS / f'{stage}.jsonl').exists():
            print(f'\n### {stage}: 台帳がありません')
            continue
        rows = load(stage)
        if not rows:
            print(f'\n### {stage}: 0 件')
            continue
        t0 = min(r['startedAt'] for r in rows)
        bins = {}
        ends = sorted((r['endedAt'], r.get('inputTokens') or 0) for r in rows)
        for r in rows:
            b = (r['endedAt'] - t0) // 10_000
            d = bins.setdefault(b, {'n': 0, 'n429': 0, 'tok': 0})
            d['n'] += 1
            d['tok'] += r.get('inputTokens') or 0
            d['n429'] += sum(1 for a in r['attemptLog'] if a.get('http') == 429)
        print(f'\n### {stage}（開始からの秒・10秒ごと）\n')
        print('| 秒 | 完了 | 件/秒 | 429（その10秒に完了した記録が受けた回数。429 の発生時刻ではない） | 直前60秒に完了した分の入力トークン |')
        print('|---|---|---|---|---|')
        j = 0
        window = 0
        k = 0
        for b in range(0, max(bins) + 1):  # 完了0件の区間（429 の待機中）も行として出す
            edge = t0 + (b + 1) * 10_000
            while j < len(ends) and ends[j][0] < edge:
                window += ends[j][1]
                j += 1
            while k < j and ends[k][0] < edge - 60_000:
                window -= ends[k][1]
                k += 1
            d = bins.get(b, {'n': 0, 'n429': 0, 'tok': 0})
            print(f"| {b * 10}〜{b * 10 + 10} | {d['n']} | {d['n'] / 10:.1f} | {d['n429']} | {window:,} |")
        tok = sum(r.get('inputTokens') or 0 for r in rows)
        print(f'\n平均入力トークン/件: {tok / len(rows):.1f}（{len(rows)} 件）')


if __name__ == '__main__':
    main(sys.argv[1:] or ['c128', 'c256'])
