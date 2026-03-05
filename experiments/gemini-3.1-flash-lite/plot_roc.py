"""
ROC曲線比較: gemini-3.1-flash-lite-preview vs gemini-3-flash-preview
depression データセットでの比較
"""
import json
import os
import sys
import numpy as np

# パス設定
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.join(SCRIPT_DIR, '..', '..')

# データセット
DATASET_PATH = os.path.join(PROJECT_ROOT, 'scripts', 'asreview-baseline', 'datasets', 'depression_slim_labeled.json')

# 判定結果ファイル
# B4: gemini-3-flash-preview (TopP 0.95, Think LOW) - 既存ベスト
B4_DECISIONS_PATH = os.path.join(PROJECT_ROOT, 'experiments', 'results', 'decisions_2026-01-01T09-55-41.json')
# C1: gemini-3.1-flash-lite-preview (Temp 0.0) - 今回の最良
C1_DECISIONS_PATH = os.path.join(SCRIPT_DIR, 'results', 'decisions_2026-03-04T23-02-45.json')


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


def compute_roc(labels: dict[str, int], probs: dict[str, float]) -> tuple[list[float], list[float], float]:
    """ROC曲線のFPR, TPR, AUCを計算"""
    # 共通のref_idのみ使用
    common_ids = set(labels.keys()) & set(probs.keys())

    y_true = np.array([labels[rid] for rid in common_ids])
    y_score = np.array([probs[rid] for rid in common_ids])

    # 閾値を0.0から1.0まで0.01刻みで設定
    thresholds = np.arange(0.0, 1.01, 0.01)

    tpr_list = []
    fpr_list = []

    total_pos = np.sum(y_true == 1)
    total_neg = np.sum(y_true == 0)

    for thresh in thresholds:
        predicted = (y_score >= thresh).astype(int)

        tp = np.sum((predicted == 1) & (y_true == 1))
        fp = np.sum((predicted == 1) & (y_true == 0))

        tpr = tp / total_pos if total_pos > 0 else 0
        fpr = fp / total_neg if total_neg > 0 else 0

        tpr_list.append(float(tpr))
        fpr_list.append(float(fpr))

    # AUC（台形法）
    # FPRの降順でソート（ROC曲線は左上から右下）
    pairs = sorted(zip(fpr_list, tpr_list))
    fpr_sorted = [p[0] for p in pairs]
    tpr_sorted = [p[1] for p in pairs]
    # numpy 2.x: trapz → trapezoid
    trapz_fn = getattr(np, 'trapezoid', None) or np.trapz
    auc = float(trapz_fn(tpr_sorted, fpr_sorted))

    return fpr_list, tpr_list, auc


def main():
    # matplotlib のインポート（なければインストール案内）
    try:
        import matplotlib
        matplotlib.use('Agg')  # GUI不要
        import matplotlib.pyplot as plt
    except ImportError:
        print('matplotlib が必要です: pip install matplotlib')
        sys.exit(1)

    print('データ読み込み中...')
    labels = load_labels(DATASET_PATH)
    print(f'  ラベル: {len(labels)}件 (陽性: {sum(v==1 for v in labels.values())})')

    b4_probs = load_probabilities(B4_DECISIONS_PATH)
    print(f'  B4判定: {len(b4_probs)}件')

    c1_probs = load_probabilities(C1_DECISIONS_PATH)
    print(f'  C1判定: {len(c1_probs)}件')

    print('ROC曲線計算中...')
    b4_fpr, b4_tpr, b4_auc = compute_roc(labels, b4_probs)
    c1_fpr, c1_tpr, c1_auc = compute_roc(labels, c1_probs)

    print(f'  B4 AUC: {b4_auc:.4f}')
    print(f'  C1 AUC: {c1_auc:.4f}')

    # === プロット ===
    fig, axes = plt.subplots(1, 2, figsize=(16, 7))

    # --- 左: 全体ROC曲線 ---
    ax1 = axes[0]
    ax1.plot(b4_fpr, b4_tpr, 'b-', linewidth=2,
             label=f'gemini-3-flash (B4) AUC={b4_auc:.4f}')
    ax1.plot(c1_fpr, c1_tpr, 'r-', linewidth=2,
             label=f'gemini-3.1-flash-lite (C1) AUC={c1_auc:.4f}')
    ax1.plot([0, 1], [0, 1], 'k--', linewidth=0.5, label='Random')
    ax1.set_xlabel('False Positive Rate (1 - Specificity)', fontsize=12)
    ax1.set_ylabel('True Positive Rate (Sensitivity)', fontsize=12)
    ax1.set_title('ROC Curve: Full View', fontsize=14)
    ax1.legend(loc='lower right', fontsize=10)
    ax1.grid(True, alpha=0.3)
    ax1.set_xlim(-0.02, 1.02)
    ax1.set_ylim(-0.02, 1.02)

    # threshold=0.5 の点をマーク
    for fpr_list, tpr_list, color, name in [
        (b4_fpr, b4_tpr, 'blue', 'B4'),
        (c1_fpr, c1_tpr, 'red', 'C1'),
    ]:
        # threshold=0.5 は index 50 (0.00, 0.01, ..., 0.50)
        idx_50 = 50
        ax1.plot(fpr_list[idx_50], tpr_list[idx_50], 'o', color=color, markersize=8)
        ax1.annotate(f'{name} t=0.5',
                     (fpr_list[idx_50], tpr_list[idx_50]),
                     textcoords="offset points", xytext=(10, -10),
                     fontsize=9, color=color)

    # --- 右: 高感度領域の拡大（TPR ≥ 0.85） ---
    ax2 = axes[1]
    ax2.plot(b4_fpr, b4_tpr, 'b-', linewidth=2,
             label=f'gemini-3-flash (B4)')
    ax2.plot(c1_fpr, c1_tpr, 'r-', linewidth=2,
             label=f'gemini-3.1-flash-lite (C1)')

    # 目標ライン
    ax2.axhline(y=0.95, color='green', linestyle='--', alpha=0.7, label='Target Recall=0.95')

    ax2.set_xlabel('False Positive Rate (1 - Specificity)', fontsize=12)
    ax2.set_ylabel('True Positive Rate (Sensitivity)', fontsize=12)
    ax2.set_title('ROC Curve: High-Sensitivity Region', fontsize=14)
    ax2.legend(loc='lower right', fontsize=10)
    ax2.grid(True, alpha=0.3)
    ax2.set_xlim(-0.02, 0.5)
    ax2.set_ylim(0.85, 1.02)

    # threshold=0.5, 0.3 の点をマーク
    for fpr_list, tpr_list, color, name in [
        (b4_fpr, b4_tpr, 'blue', 'B4'),
        (c1_fpr, c1_tpr, 'red', 'C1'),
    ]:
        for t_val, t_idx in [(0.5, 50), (0.3, 30)]:
            ax2.plot(fpr_list[t_idx], tpr_list[t_idx], 'o', color=color, markersize=8)
            ax2.annotate(f'{name} t={t_val}',
                         (fpr_list[t_idx], tpr_list[t_idx]),
                         textcoords="offset points", xytext=(10, -5),
                         fontsize=9, color=color)

    plt.tight_layout()

    # 保存
    output_path = os.path.join(SCRIPT_DIR, 'results', 'roc_comparison.png')
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    print(f'\nROC曲線を保存: {output_path}')

    # 閾値別の詳細テーブルも出力
    print('\n=== 閾値別比較テーブル ===')
    print('| Threshold | B4 TPR | B4 FPR | C1 TPR | C1 FPR | TPR差 |')
    print('|---|---|---|---|---|---|')
    for t in [0.3, 0.4, 0.5, 0.6, 0.7]:
        idx = int(t * 100)
        diff = c1_tpr[idx] - b4_tpr[idx]
        print(f'| {t:.1f} | {b4_tpr[idx]:.3f} | {b4_fpr[idx]:.3f} | {c1_tpr[idx]:.3f} | {c1_fpr[idx]:.3f} | {diff:+.3f} |')


if __name__ == '__main__':
    main()
