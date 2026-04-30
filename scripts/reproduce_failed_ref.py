"""
rayyan-499353097 (1件の永続失敗) を Gemini API に直接ぶつけて、
具体的な失敗モードを観察するスクリプト。

仮説: abstract に含まれる LaTeX エスケープ (\textbf{...}) が
      Gemini の JSON 出力で invalid escape sequence になり、
      JSON.parse が決定的に失敗している。

使い方:
  1. PowerShell:   $env:GEMINI_API_KEY = "your_key"
     bash:         export GEMINI_API_KEY=your_key
  2. python scripts/reproduce_failed_ref.py
  3. 必要なら --sanitize オプションで LaTeX を除去した版でも比較:
     python scripts/reproduce_failed_ref.py --sanitize

スクリプトは src/lib/gemini-api.ts:callGeminiApi の挙動を Python で
模倣する。streamGenerateContent + responseSchema を使用。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

# ---- 対象文献 (debug/TiAb_Review_All_unlabeled.xlsx より抽出済み) ----
REF_ID = "rayyan-499353097"
TITLE = "Towards World Simulator: Crafting Physical Commonsense-Based Benchmark for Video Generation"
ABSTRACT = (
    "Text-to-video (T2V) models like Sora have made significant strides in visualizing complex prompts, "
    "which is increasingly viewed as a promising path towards constructing the universal world simulator. "
    "Cognitive psychologists believe that the foundation for achieving this goal is the ability to understand "
    "intuitive physics. However, the capacity of these models to accurately represent intuitive physics "
    "remains largely unexplored. To bridge this gap, we introduce PhyGenBench, a comprehensive "
    "\\textbf{Phy}sics \\textbf{Gen}eration \\textbf{Ben}chmark designed to evaluate physical commonsense "
    "correctness in T2V generation. PhyGenBench comprises 160 carefully crafted prompts across 27 distinct "
    "physical laws, spanning four fundamental domains, which could comprehensively assesses models' "
    "understanding of physical commonsense. Alongside PhyGenBench, we propose a novel evaluation framework "
    "called PhyGenEval. This framework employs a hierarchical evaluation structure utilizing appropriate "
    "advanced vision-language models and large language models to assess physical commonsense. Through "
    "PhyGenBench and PhyGenEval, we can conduct large-scale automated assessments of T2V models' "
    "understanding of physical commonsense, which align closely with human feedback. Our evaluation "
    "results and in-depth analysis demonstrate that current models struggle to generate videos that "
    "comply with physical commonsense. Moreover, simply scaling up models or employing prompt engineering "
    "techniques is insufficient to fully address the challenges presented by PhyGenBench (e.g., dynamic "
    "scenarios). We hope this study will inspire the community to prioritize the learning of physical "
    "commonsense in these models beyond entertainment applications. We will release the data and codes "
    "at https://github.com/OpenGVLab/PhyGenBench"
)

GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

# src/lib/gemini-api.ts の SCREENING_OUTPUT_SCHEMA と同じ
SCREENING_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "include_probability": {
            "type": "number",
            "description": "タイトル・抄録レベルで最終的に組み入れになり得る確率（0-1）",
        },
        "reasons": {
            "type": "array",
            "items": {"type": "string"},
            "description": "この確率になった理由（短文の配列）",
        },
        "evidence": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "field": {"type": "string", "enum": ["title", "abstract"]},
                    "quote": {"type": "string"},
                    "start_char": {"type": "integer"},
                    "end_char": {"type": "integer"},
                },
                "required": ["field", "quote", "start_char", "end_char"],
            },
        },
    },
    "required": ["include_probability", "reasons", "evidence"],
}

# 実際のスクリーニング基準 (debug/TiAb_Review_All_unlabeled.xlsx の LLM_Executions より抽出)
SCREENING_PROMPT = (
    "あなたはシステマティックレビューのスクリーニング担当者です。"
    "以下の基準に基づき、タイトルと抄録から文献を「採択」「除外」「保留」のいずれかで判定してください。"
    "判定基準：1.【対象】医療、福祉、メンタルヘルス、職業保健の文脈であること。"
    "2.【介入】テキストベースの対話型AI（LLM、チャットボット、デジタルメンタルヘルスツール等）を用いていること。"
    "3.【アウトカム】倫理、安全性、バイオエチックス、または心理社会的影響（依存、過信、自殺リスク、幻覚、"
    "操作、孤立、不安全な助言、パラソーシャル・インタラクション等）を評価していること。"
    "除外対象：画像診断等の非対話型AI、教育・金融・ゲーム・一般カスタマーサポート向けのAI、"
    "UX評価（使いやすさ・満足度）のみの研究、技術的性能（精度・F1スコア等）のみの研究。"
    "タイトル・抄録から判断が不可能な場合は、安易に除外せず「保留」としてください。"
)


def sanitize_latex(text: str) -> str:
    """\\textbf{...} 等の LaTeX 風コマンドを中身だけ残して除去"""
    # \textbf{xxx} -> xxx
    text = re.sub(r"\\(?:textbf|textit|emph|underline|texttt)\{([^{}]*)\}", r"\1", text)
    # 残った単独の \\command (引数なし) を空白に
    text = re.sub(r"\\[a-zA-Z]+\b", "", text)
    return text


def load_dotenv() -> None:
    """プロジェクト直下の .env を簡易ロード"""
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line and "GEMINI_API_KEY" in line:
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)


def build_prompt(title: str, abstract: str, language: str = "ja") -> str:
    return (
        f"{SCREENING_PROMPT}\n\n"
        "## 対象文献\n\n"
        f"**タイトル:**\n{title}\n\n"
        f"**抄録:**\n{abstract or '(抄録なし)'}\n\n"
        "## 出力指示\n"
        "- include_probability: 組み入れ基準に合致する確率を0.0〜1.0で出力\n"
        f"- reasons: 判断理由を{'日本語' if language == 'ja' else language}で短文配列で出力\n"
        "- evidence: タイトルまたは抄録から判断根拠となる部分を正確に抜粋（quote）し、"
        "その開始位置（start_char）と終了位置（end_char）を指定\n\n"
        "注意: quote は title または abstract 内の正確な部分文字列でなければなりません。"
    )


def call_gemini_stream(model: str, api_key: str, prompt: str, timeout: int = 300):
    """src/lib/gemini-api.ts の callGeminiApi 相当"""
    url = f"{GEMINI_API_BASE}/{model}:streamGenerateContent?key={api_key}"
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": SCREENING_OUTPUT_SCHEMA,
        },
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return {
            "stage": "http_error",
            "status": e.code,
            "body": e.read().decode("utf-8", errors="replace"),
        }
    except Exception as e:
        return {"stage": "network_error", "error": repr(e)}

    # ステップ1: ストリーム全体を JSON 配列として parse
    try:
        responses = json.loads(raw)
    except Exception as e:
        return {
            "stage": "stream_parse_error",
            "error": repr(e),
            "raw_head": raw[:500],
            "raw_tail": raw[-500:],
            "raw_len": len(raw),
        }
    if not isinstance(responses, list) or not responses:
        return {"stage": "stream_invalid_format", "raw_head": raw[:500]}

    # ステップ2: テキスト連結 (thought除外)
    full_text = ""
    finish_reasons: list[str] = []
    for res in responses:
        cands = res.get("candidates") or []
        for cand in cands:
            fr = cand.get("finishReason")
            if fr:
                finish_reasons.append(fr)
            parts = (cand.get("content") or {}).get("parts") or []
            for part in parts:
                if part.get("thought") is True:
                    continue
                if part.get("text"):
                    full_text += part["text"]
    last_usage = (responses[-1] or {}).get("usageMetadata") or {}

    if not full_text:
        return {
            "stage": "no_text",
            "finish_reasons": finish_reasons,
            "usage": last_usage,
            "raw_head": raw[:500],
        }

    # ステップ3: JSON パース
    try:
        parsed = json.loads(full_text)
        return {
            "stage": "ok",
            "parsed": parsed,
            "finish_reasons": finish_reasons,
            "usage": last_usage,
        }
    except Exception as e:
        # フォールバック: { ... } を最初に見つけたものを切り出す
        m = re.search(r"\{[\s\S]*\}", full_text)
        if m:
            try:
                parsed = json.loads(m.group(0))
                return {
                    "stage": "ok_after_brace_extract",
                    "parsed": parsed,
                    "finish_reasons": finish_reasons,
                    "usage": last_usage,
                }
            except Exception as e2:
                return {
                    "stage": "json_parse_error_after_extract",
                    "error1": repr(e),
                    "error2": repr(e2),
                    "full_text_head": full_text[:800],
                    "full_text_tail": full_text[-800:],
                    "finish_reasons": finish_reasons,
                    "usage": last_usage,
                }
        return {
            "stage": "json_parse_error",
            "error": repr(e),
            "full_text_head": full_text[:800],
            "full_text_tail": full_text[-800:],
            "finish_reasons": finish_reasons,
            "usage": last_usage,
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="gemini-2.5-flash-lite",
                        help="Gemini model id (default: gemini-2.5-flash-lite)")
    parser.add_argument("--attempts", type=int, default=3, help="試行回数")
    parser.add_argument("--sanitize", action="store_true",
                        help="\\textbf{} 等の LaTeX を除去してから送る (比較用)")
    parser.add_argument("--burst", type=int, default=1,
                        help="1試行あたりの並列リクエスト数 (本番の concurrency=5 を再現)")
    args = parser.parse_args()

    load_dotenv()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        print("[ERROR] 環境変数 GEMINI_API_KEY が未設定です。", file=sys.stderr)
        print("  例:  export GEMINI_API_KEY=your_key  (bash)", file=sys.stderr)
        print("       $env:GEMINI_API_KEY=\"your_key\"  (PowerShell)", file=sys.stderr)
        sys.exit(2)

    abstract = sanitize_latex(ABSTRACT) if args.sanitize else ABSTRACT
    print(f"=== reproduce {REF_ID} ===")
    print(f"model:    {args.model}")
    print(f"sanitize: {args.sanitize}")
    print(f"abstract に \\textbf 等の LaTeX が残っているか: "
          f"{'NO (除去済)' if args.sanitize else 'YES'}")
    print(f"abstract 長: {len(abstract)}")
    print()

    prompt = build_prompt(TITLE, abstract)

    import concurrent.futures

    fail_count = 0
    ok_count = 0
    for i in range(1, args.attempts + 1):
        print(f"--- Attempt {i}/{args.attempts} (burst={args.burst}) ---")
        t0 = time.time()
        if args.burst <= 1:
            results = [call_gemini_stream(args.model, api_key, prompt)]
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.burst) as ex:
                futures = [
                    ex.submit(call_gemini_stream, args.model, api_key, prompt)
                    for _ in range(args.burst)
                ]
                results = [f.result() for f in futures]
        dt = time.time() - t0
        print(f"  total elapsed: {dt:.1f}s for {len(results)} calls")
        for j, result in enumerate(results, start=1):
            stage = result.get("stage", "?")
            tag = f"  [call {j}/{len(results)}] stage: {stage}"
            print(tag)
            if stage in ("ok", "ok_after_brace_extract"):
                ok_count += 1
                parsed = result.get("parsed", {})
                print(f"    include_probability: {parsed.get('include_probability')}")
            else:
                fail_count += 1
                for k, v in result.items():
                    if k == "stage":
                        continue
                    s = repr(v) if not isinstance(v, str) else v
                    if len(s) > 600:
                        s = s[:600] + " ... (truncated)"
                    print(f"    {k}: {s}")
        print()
        if i < args.attempts:
            time.sleep(2)
    print(f"=== summary: ok={ok_count}, fail={fail_count} ===")


if __name__ == "__main__":
    main()
