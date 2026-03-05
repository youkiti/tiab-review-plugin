"""
ROC曲線比較: gemini-3.1-flash-lite-preview (C1) vs gemini-3-flash-preview (B4)
全データセットでの比較
"""
import json
import os
import sys
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.join(SCRIPT_DIR, '..', '..')

# データセット定義
DATASETS = {
    'depression': {
        'path': 'scripts/asreview-baseline/datasets/depression_slim_labeled.json',
        'b4_decisions': 'experiments/results/decisions_2026-01-01T09-55-41.json',
        'c1_decisions': 'experiments/gemini-3.1-flash-lite/results/decisions_2026-03-04T23-02-45.json',
        'label': 'Depression (n=1993, prev=14.1%)',
    },
    'cq1': {
        'path': 'scripts/asreview-baseline/datasets/cq1_labeled.json',
        'b4_decisions': 'experiments/results/decisions_2026-01-01T11-07-37.json',
        'c1_decisions': 'experiments/gemini-3.1-flash-lite/results/decisions_2026-03-04T23-15-31.json',
        'label': 'CQ1 Fluid (n=5628, prev=2.0%)',
    },
    'cq2': {
        'path': 'scripts/asreview-baseline/datasets/cq2_labeled.json',
        'b4_decisions': 'experiments/results/decisions_2026-01-01T11-27-46.json',
        'c1_decisions': 'experiments/gemini-3.1-flash-lite/results/decisions_2026-03-04T23-16-05.json',
        'label': 'CQ2 BP (n=3400, prev=0.5%)',
    },
    'cq3': {
        'path': 'scripts/asreview-baseline/datasets/cq3_labeled.json',
        'b4_decisions': 'experiments/results/decisions_2026-01-01T11-40-45.json',
        'c1_decisions': 'experiments/gemini-3.1-flash-lite/results/decisions_2026-03-04T23-16-29.json',
        'label': 'CQ3 Bicarb (n=1038, prev=1.5%)',
    },
    'cq4': {
        'path': 'scripts/asreview-baseline/datasets/cq4_labeled.json',
        'b4_decisions': 'experiments/results/decisions_2026-01-01T11-45-52.json',
        'c1_decisions': 'experiments/gemini-3.1-flash-lite/results/decisions_2026-03-04T23-16-42.json',
        'label': 'CQ4 EGDT (n=4326, prev=1.7%)',
    },
    'cq5': {
        'path': 'scripts/asreview-baseline/datasets/cq5_labeled.json',
        'b4_decisions': 'experiments/results/decisions_2026-01-01T12-06-29.json',
        'c1_decisions': 'experiments/gemini-3.1-flash-lite/results/decisions_2026-03-04T23-17-25.json',
        'label': 'CQ5 Restrictive (n=2253, prev=1.8%)',
    },
    'wilson': {
        'path': 'scripts/asreview-baseline/datasets/wilson_tiab_labeled.json',
        'b4_decisions': None,  # B4はwilsonラベル未対応だった
        'c1_decisions': 'experiments/gemini-3.1-flash-lite/results/decisions_2026-03-04T23-17-56.json',
        'label': 'Wilson (n=3453, prev=5.0%)',
    },
}


def load_labels(dataset_path: str) -> dict[str, int]:
    """データセットからラベルを読み込む"""
    with open(dataset_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    records = data.get('records', data) if isinstance(data, dict) else data
    labels = {}
    for r in records:
        ref_id = r.get('ref_id') or r.get('id')
        label = r.get('label_included', r.get('label_tiab', r.get('label', 0)))
        labels[ref_id] = int(label)
    return labels


def load_probabilities(decisions_path: str) -> dict[str, float]:
    """判定結果からinclude_probabilityを読み込む"""
    with open(decisions_path, 'r', encoding='utf-8') as f:
        decisions = json.load(f)
    probs = {}
    for d in decisions:
        ref_id = d.get('ref_id')
        note = d.get('note', '')
        prob = 0.5
        if note:
            try:
                note_data = json.loads(note)
                prob = note_data.get('include_probability', 0.5)
            except (json.JSONDecodeError, TypeError):
                pass
        probs[ref_id] = prob
    return probs


def compute_roc(labels: dict[str, int], probs: dict[str, float]):
    """ROC曲線のFPR, TPR, AUCを計算"""
    common_ids = set(labels.keys()) & set(probs.keys())
    y_true = np.array([labels[rid] for rid in common_ids])
    y_score = np.array([probs[rid] for rid in common_ids])

    thresholds = np.arange(0.0, 1.01, 0.01)
    tpr_list, fpr_list = [], []
    total_pos = np.sum(y_true == 1)
    total_neg = np.sum(y_true == 0)

    for thresh in thresholds:
        predicted = (y_score >= thresh).astype(int)
        tp = np.sum((predicted == 1) & (y_true == 1))
        fp = np.sum((predicted == 1) & (y_true == 0))
        tpr_list.append(float(tp / total_pos) if total_pos > 0 else 0.0)
        fpr_list.append(float(fp / total_neg) if total_neg > 0 else 0.0)

    pairs = sorted(zip(fpr_list, tpr_list))
    trapz_fn = getattr(np, 'trapezoid', None) or np.trapz
    auc = float(trapz_fn([p[1] for p in pairs], [p[0] for p in pairs]))

    return fpr_list, tpr_list, auc


def main():
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except ImportError:
        print('matplotlib が必要です: pip install matplotlib')
        sys.exit(1)

    # 全データセットのROCを計算
    results = {}
    for ds_name, ds_info in DATASETS.items():
        dataset_path = os.path.join(PROJECT_ROOT, ds_info['path'])
        labels = load_labels(dataset_path)
        n_pos = sum(v == 1 for v in labels.values())
        print(f'{ds_name}: {len(labels)}件 (陽性={n_pos})')

        c1_path = os.path.join(PROJECT_ROOT, ds_info['c1_decisions'])
        c1_probs = load_probabilities(c1_path)
        c1_fpr, c1_tpr, c1_auc = compute_roc(labels, c1_probs)

        b4_fpr, b4_tpr, b4_auc = None, None, None
        if ds_info['b4_decisions']:
            b4_path = os.path.join(PROJECT_ROOT, ds_info['b4_decisions'])
            b4_probs = load_probabilities(b4_path)
            b4_fpr, b4_tpr, b4_auc = compute_roc(labels, b4_probs)

        results[ds_name] = {
            'label': ds_info['label'],
            'c1': (c1_fpr, c1_tpr, c1_auc),
            'b4': (b4_fpr, b4_tpr, b4_auc) if b4_auc is not None else None,
        }

    # === 全データセット一覧プロット (4×2 グリッド) ===
    ds_names = list(results.keys())
    n = len(ds_names)
    cols = 4
    rows = 2
    fig, axes = plt.subplots(rows, cols, figsize=(24, 12))
    axes_flat = axes.flatten()

    for i, ds_name in enumerate(ds_names):
        ax = axes_flat[i]
        r = results[ds_name]

        c1_fpr, c1_tpr, c1_auc = r['c1']
        ax.plot(c1_fpr, c1_tpr, 'r-', linewidth=2,
                label=f'3.1-flash-lite (C1) AUC={c1_auc:.3f}')

        if r['b4']:
            b4_fpr, b4_tpr, b4_auc = r['b4']
            ax.plot(b4_fpr, b4_tpr, 'b-', linewidth=2,
                    label=f'3-flash (B4) AUC={b4_auc:.3f}')

        ax.plot([0, 1], [0, 1], 'k--', linewidth=0.5, alpha=0.3)
        ax.axhline(y=0.95, color='green', linestyle='--', alpha=0.5, linewidth=1)
        ax.set_title(r['label'], fontsize=11)
        ax.set_xlabel('FPR', fontsize=9)
        ax.set_ylabel('TPR', fontsize=9)
        ax.legend(loc='lower right', fontsize=8)
        ax.grid(True, alpha=0.2)
        ax.set_xlim(-0.02, 1.02)
        ax.set_ylim(-0.02, 1.02)

        # threshold=0.5 マーカー
        idx_50 = 50
        ax.plot(c1_fpr[idx_50], c1_tpr[idx_50], 'ro', markersize=6)
        if r['b4']:
            ax.plot(b4_fpr[idx_50], b4_tpr[idx_50], 'bo', markersize=6)

    # 余ったサブプロットを非表示
    for j in range(n, rows * cols):
        axes_flat[j].set_visible(False)

    fig.suptitle('ROC Comparison: gemini-3.1-flash-lite (C1) vs gemini-3-flash (B4)\nAll Datasets, threshold=0.5 marked with dots, green line = Recall 0.95',
                 fontsize=14, y=1.02)
    plt.tight_layout()

    output_path = os.path.join(SCRIPT_DIR, 'results', 'roc_all_datasets.png')
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    print(f'\n全データセットROC曲線を保存: {output_path}')

    # === 高感度領域の拡大版 (4×2 グリッド) ===
    fig2, axes2 = plt.subplots(rows, cols, figsize=(24, 12))
    axes2_flat = axes2.flatten()

    for i, ds_name in enumerate(ds_names):
        ax = axes2_flat[i]
        r = results[ds_name]

        c1_fpr, c1_tpr, c1_auc = r['c1']
        ax.plot(c1_fpr, c1_tpr, 'r-', linewidth=2,
                label=f'3.1-flash-lite (C1)')

        if r['b4']:
            b4_fpr, b4_tpr, b4_auc = r['b4']
            ax.plot(b4_fpr, b4_tpr, 'b-', linewidth=2,
                    label=f'3-flash (B4)')

        ax.axhline(y=0.95, color='green', linestyle='--', alpha=0.7, linewidth=1, label='Target 0.95')
        ax.set_title(r['label'], fontsize=11)
        ax.set_xlabel('FPR', fontsize=9)
        ax.set_ylabel('TPR', fontsize=9)
        ax.legend(loc='lower right', fontsize=8)
        ax.grid(True, alpha=0.2)
        ax.set_xlim(-0.02, 0.6)
        ax.set_ylim(0.75, 1.02)

        # threshold=0.5, 0.3 マーカー
        for t_val, t_idx in [(0.5, 50), (0.3, 30)]:
            ax.plot(c1_fpr[t_idx], c1_tpr[t_idx], 'ro', markersize=6)
            if r['b4']:
                ax.plot(b4_fpr[t_idx], b4_tpr[t_idx], 'bo', markersize=6)

    for j in range(n, rows * cols):
        axes2_flat[j].set_visible(False)

    fig2.suptitle('ROC Comparison (High-Sensitivity Zoom): gemini-3.1-flash-lite (C1) vs gemini-3-flash (B4)\nDots = threshold 0.5 & 0.3, green line = Recall 0.95',
                  fontsize=14, y=1.02)
    plt.tight_layout()

    output_zoom = os.path.join(SCRIPT_DIR, 'results', 'roc_all_datasets_zoom.png')
    plt.savefig(output_zoom, dpi=150, bbox_inches='tight')
    print(f'高感度領域拡大を保存: {output_zoom}')

    # === サマリーテーブル ===
    print('\n=== AUC 比較テーブル ===')
    print('| Dataset | B4 AUC | C1 AUC | 差分 | C1 Recall@0.5 | B4 Recall@0.5 | Recall差 |')
    print('|---|---|---|---|---|---|---|')
    for ds_name in ds_names:
        r = results[ds_name]
        c1_fpr, c1_tpr, c1_auc = r['c1']
        c1_recall = c1_tpr[50]
        if r['b4']:
            b4_fpr, b4_tpr, b4_auc = r['b4']
            b4_recall = b4_tpr[50]
            diff_auc = c1_auc - b4_auc
            diff_recall = c1_recall - b4_recall
            print(f'| {ds_name} | {b4_auc:.4f} | {c1_auc:.4f} | {diff_auc:+.4f} | {c1_recall:.3f} | {b4_recall:.3f} | {diff_recall:+.3f} |')
        else:
            print(f'| {ds_name} | N/A | {c1_auc:.4f} | N/A | {c1_recall:.3f} | N/A | N/A |')


if __name__ == '__main__':
    main()
