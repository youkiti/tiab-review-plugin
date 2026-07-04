"""Markdown レポート生成（レビュー結果の PASS/FAIL/INFO 表と抽出テキスト全文）。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Status = Literal["PASS", "FAIL", "INFO"]

STATUS_ICON = {"PASS": "✅", "FAIL": "❌", "INFO": "ℹ️"}


@dataclass
class Check:
    name: str
    status: Status
    detail: str = ""


@dataclass
class ModalResult:
    """1つのモーダル（tiab / fulltext）の抽出結果とチェック結果。"""
    phase: str
    title: str = ""
    note: str = ""
    warnings: list[str] = field(default_factory=list)
    sections: list[dict] = field(default_factory=list)  # {title, text}
    checks: list[Check] = field(default_factory=list)
    screenshots: list[str] = field(default_factory=list)
    error: str = ""

    def to_json(self) -> dict:
        return {
            "phase": self.phase,
            "title": self.title,
            "note": self.note,
            "warnings": self.warnings,
            "sections": self.sections,
            "checks": [
                {"name": c.name, "status": c.status, "detail": c.detail}
                for c in self.checks
            ],
            "screenshots": self.screenshots,
            "error": self.error,
        }


def _checks_table(checks: list[Check]) -> str:
    lines = ["| 結果 | チェック | 詳細 |", "| --- | --- | --- |"]
    for c in checks:
        detail = c.detail.replace("\n", "<br>").replace("|", "\\|")
        lines.append(f"| {STATUS_ICON[c.status]} {c.status} | {c.name} | {detail} |")
    return "\n".join(lines)


def render_report(meta: dict, results: list[ModalResult]) -> str:
    all_checks = [c for r in results for c in r.checks]
    n_fail = sum(1 for c in all_checks if c.status == "FAIL")
    n_pass = sum(1 for c in all_checks if c.status == "PASS")
    n_info = sum(1 for c in all_checks if c.status == "INFO")

    out: list[str] = []
    out.append("# 論文用テキスト機能 実機レビュー結果")
    out.append("")
    verdict = "**FAILあり — 要確認**" if n_fail else "**全チェック PASS**"
    out.append(f"{verdict}（PASS {n_pass} / FAIL {n_fail} / INFO {n_info}）")
    out.append("")
    out.append("## 環境")
    out.append("")
    for k, v in meta.items():
        out.append(f"- {k}: {v}")
    out.append("")

    for r in results:
        label = "TiAb（エクスポートメニュー）" if r.phase == "tiab" else "フルテキスト（結果ビュー）"
        out.append(f"## {label}")
        out.append("")
        if r.error:
            out.append(f"❌ **実行エラー**: {r.error}")
            out.append("")
        if r.title:
            out.append(f"- モーダルタイトル: `{r.title}`")
        if r.note:
            out.append(f"- 注記: {r.note}")
        if r.warnings:
            out.append(f"- 警告 {len(r.warnings)} 件:")
            for w in r.warnings:
                out.append(f"  - {w}")
        if r.screenshots:
            out.append(f"- スクリーンショット: {', '.join(r.screenshots)}")
        out.append("")
        if r.checks:
            out.append(_checks_table(r.checks))
            out.append("")
        for s in r.sections:
            out.append(f"### {label} — {s['title']}")
            out.append("")
            out.append("```")
            out.append(s["text"])
            out.append("```")
            out.append("")

    return "\n".join(out)
