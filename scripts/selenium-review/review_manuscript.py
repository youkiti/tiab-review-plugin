#!/usr/bin/env python3
"""論文用テキスト（Methods/Results/PRISMA）機能の Selenium 実機レビューハーネス。

dev ビルド（dist/、拡張ID固定）を専用 Chrome プロファイルで起動し、
既存プロジェクトを開いて TiAb / フルテキスト両方のモーダルを検証する。
初回のみ Google サインインを人間が行う（スクリプトは待機する）。

実行例:
    npm run dev
    python scripts/selenium-review/review_manuscript.py --sheet "https://docs.google.com/spreadsheets/d/<ID>/edit"
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

from selenium import webdriver
from selenium.common.exceptions import (
    InvalidSessionIdException,
    NoSuchWindowException,
    SessionNotCreatedException,
    TimeoutException,
    WebDriverException,
)
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

from report import Check, ModalResult, render_report

EXT_ID = "ifnejjicfekmighagknaacliiiliodgf"
SIDEPANEL_URL = f"chrome-extension://{EXT_ID}/sidepanel/sidepanel.html"
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
DIST_DIR = REPO_ROOT / "dist"
PROFILE_DIR = SCRIPT_DIR / "profile"

# i18n 文言（ja / en 両対応でアサート）
MODAL_TITLES = {
    "論文用テキスト（Methods / Results 下書き）",
    "Manuscript text (Methods / Results draft)",
}
PRISMA_SECTION_TITLES = {"PRISMAフロー数値", "PRISMA flow numbers"}
COPIED_TOASTS = {"クリップボードにコピーしました", "Copied to clipboard"}
COPY_FAILED_TOASTS = {"コピーに失敗しました", "Failed to copy"}


# ---------------------------------------------------------------------------
# ドライバ・共通ユーティリティ
# ---------------------------------------------------------------------------

def build_driver(lang: str) -> webdriver.Chrome:
    opts = webdriver.ChromeOptions()
    opts.add_argument(f"--user-data-dir={PROFILE_DIR}")
    # Chrome 137+ は --load-extension を無視するため、BiDi webExtension.install で
    # ロードする（下の2フラグが必要）
    opts.add_argument("--enable-unsafe-extension-debugging")
    opts.add_argument("--remote-debugging-pipe")
    opts.enable_bidi = True
    opts.add_argument(f"--lang={lang}")
    opts.add_argument("--window-size=1100,1400")
    opts.add_argument("--no-first-run")
    opts.add_argument("--no-default-browser-check")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})
    try:
        return webdriver.Chrome(options=opts)
    except SessionNotCreatedException as e:
        if "user data directory is already in use" in str(e):
            sys.exit(
                f"[error] プロファイル {PROFILE_DIR} が使用中です。"
                "前回のレビュー用 Chrome ウィンドウを閉じてから再実行してください。"
            )
        raise


def is_displayed(driver: webdriver.Chrome, css: str) -> bool:
    els = driver.find_elements(By.CSS_SELECTOR, css)
    return bool(els) and els[0].is_displayed()


def wait_for(driver: webdriver.Chrome, predicate, timeout: float, desc: str):
    try:
        return WebDriverWait(driver, timeout, poll_frequency=0.2).until(
            lambda d: predicate(d)
        )
    except TimeoutException:
        raise TimeoutException(f"タイムアウト({timeout}s): {desc}")


class Shots:
    """番号付きスクリーンショット保存。"""

    def __init__(self, driver: webdriver.Chrome, out_dir: Path):
        self.driver = driver
        self.out_dir = out_dir
        self.n = 0

    def page(self, name: str) -> str:
        self.n += 1
        fname = f"{self.n:02d}-{name}.png"
        self.driver.save_screenshot(str(self.out_dir / fname))
        return fname

    def element(self, css: str, name: str) -> str:
        self.n += 1
        fname = f"{self.n:02d}-{name}.png"
        try:
            el = self.driver.find_element(By.CSS_SELECTOR, css)
            el.screenshot(str(self.out_dir / fname))
        except WebDriverException:
            self.driver.save_screenshot(str(self.out_dir / fname))
        return fname


# ---------------------------------------------------------------------------
# フロー: 拡張ロード確認 → 認証 → プロジェクト接続
# ---------------------------------------------------------------------------

def open_sidepanel(driver: webdriver.Chrome) -> None:
    """拡張をロードしてサイドパネルページを開く。失敗時は手動ロードを案内して待つ。"""
    try:
        res = driver.webextension.install(path=str(DIST_DIR))
        print(f"[setup] 拡張をロードしました: {res}")
    except WebDriverException as e:
        print(f"[setup] webExtension.install 失敗、手動ロードにフォールバック: {e}")
    driver.get(SIDEPANEL_URL)
    time.sleep(1)
    if driver.execute_script("return !!document.getElementById('login-section')"):
        return

    print(
        "\n[action required] 拡張が読み込まれていません。"
        "開いたブラウザで以下を一度だけ実行してください:\n"
        "  1. chrome://extensions を開く\n"
        "  2. 右上「デベロッパーモード」を ON\n"
        f"  3. 「パッケージ化されていない拡張機能を読み込む」→ {DIST_DIR} を選択\n"
        "読み込まれると自動で続行します（最大5分待機）...\n"
    )
    driver.get("chrome://extensions")
    deadline = time.time() + 300
    while time.time() < deadline:
        time.sleep(3)
        try:
            driver.get(SIDEPANEL_URL)
            time.sleep(0.5)
            if driver.execute_script(
                "return !!document.getElementById('login-section')"
            ):
                return
        except WebDriverException:
            pass
    sys.exit("[error] 拡張の読み込みを確認できませんでした。")


def ensure_signed_in(driver: webdriver.Chrome) -> None:
    """サイレント認証済みなら即続行。未認証ならログインボタンを押して人間の操作を待つ。"""
    # initApp() のサイレント getAuthToken の結果で login/project どちらかが表示される
    wait_for(
        driver,
        lambda d: is_displayed(d, "#project-section") or is_displayed(d, "#login-section"),
        30,
        "ログイン画面 or プロジェクト画面の表示",
    )
    if is_displayed(driver, "#project-section"):
        print("[auth] 認証済み（サイレント）")
        return

    print(
        "\n[action required] Google サインインが必要です。\n"
        "ログインボタンを押すので、開いたポップアップでサインインと権限承認を"
        "完了してください（最大5分待機）...\n"
    )
    driver.find_element(By.ID, "login-btn").click()
    wait_for(driver, lambda d: is_displayed(d, "#project-section"), 300, "サインイン完了")
    print("[auth] サインイン完了。トークンはプロファイルにキャッシュされました。")


def connect_project(driver: webdriver.Chrome, sheet: str, shots: Shots) -> None:
    """スプレッドシート URL/ID を入力してプロジェクトを開く。

    プロジェクト画面の初期ロード中は showLoading() が #connect-btn を disabled に
    し、完了時の再描画で入力欄もクリアされる。ボタンが有効になるのを待ってから
    入力・クリックし、反応が無ければ再試行する。
    """
    for attempt in range(3):
        wait_for(
            driver,
            lambda d: d.execute_script(
                "const b = document.getElementById('connect-btn');"
                "return !!b && !b.disabled;"
            ),
            60,
            "接続ボタンの有効化",
        )
        time.sleep(1.0)  # 初期ロード完了直後の再描画（入力クリア）をやり過ごす
        inp = driver.find_element(By.ID, "spreadsheet-input")
        inp.clear()
        inp.send_keys(sheet)
        driver.find_element(By.ID, "connect-btn").click()
        try:
            # 接続処理が始まった気配（ボタン無効化 / ステータス表示 / 画面遷移）を待つ
            wait_for(
                driver,
                lambda d: d.execute_script(
                    "const b = document.getElementById('connect-btn');"
                    "const s = document.getElementById('status-message');"
                    "const sc = document.getElementById('screening-section');"
                    "return (b && b.disabled) || (s && !s.classList.contains('hidden'))"
                    "  || (sc && !sc.classList.contains('hidden'));"
                ),
                5,
                "接続処理の開始",
            )
            break
        except TimeoutException:
            print(f"[project] クリックが反応しませんでした。再試行 {attempt + 1}/3")
    print("[project] 接続中（Sheets API 読み込み、最大120秒待機）...")
    try:
        wait_for(
            driver,
            lambda d: is_displayed(d, "#screening-section")
            and is_displayed(d, "#export-btn"),
            120,
            "プロジェクト読み込み完了（#screening-section 表示）",
        )
    except TimeoutException:
        status = driver.execute_script(
            "const el = document.getElementById('status-message');"
            "return el ? el.textContent : '';"
        )
        shots.page("connect-failed")
        print(f"[error] プロジェクトを開けませんでした。status-message: {status!r}")
        try:
            for entry in driver.get_log("browser")[-30:]:
                print(f"  [console] {entry.get('level')}: {entry.get('message')}")
        except WebDriverException:
            pass
        sys.exit(1)
    print("[project] 読み込み完了")


# ---------------------------------------------------------------------------
# モーダル抽出・コピー検証
# ---------------------------------------------------------------------------

EXTRACT_JS = """
const body = document.getElementById('modal-body');
const modal = body ? body.querySelector('.manuscript-modal') : null;
if (!modal) return null;
return {
  title: (document.getElementById('modal-title') || {}).textContent || '',
  note: (modal.querySelector('.manuscript-note') || {}).textContent || '',
  warnings: [...modal.querySelectorAll('.manuscript-warning')].map(e => e.textContent),
  sections: [...modal.querySelectorAll('.manuscript-section')].map(s => ({
    title: (s.querySelector('.manuscript-section-title') || {}).textContent || '',
    text: (s.querySelector('.manuscript-textarea') || {}).value || '',
  })),
};
"""


def wait_modal_open(driver: webdriver.Chrome) -> dict:
    """モーダル表示（getSpreadsheetInfo のネットワーク待ちあり）→ 内容抽出。"""
    wait_for(
        driver,
        lambda d: is_displayed(d, "#modal-backdrop")
        and d.execute_script(EXTRACT_JS) is not None,
        30,
        "論文用テキストモーダルの表示",
    )
    return driver.execute_script(EXTRACT_JS)


def close_modal(driver: webdriver.Chrome) -> Check:
    btns = driver.find_elements(By.CSS_SELECTOR, "#modal-footer button.btn-secondary")
    if not btns:
        return Check("閉じるボタンでモーダルが閉じる", "FAIL", "閉じるボタンが見つからない")
    btns[0].click()
    try:
        wait_for(driver, lambda d: not is_displayed(d, "#modal-backdrop"), 5, "モーダル閉鎖")
        return Check("閉じるボタンでモーダルが閉じる", "PASS")
    except TimeoutException:
        return Check("閉じるボタンでモーダルが閉じる", "FAIL", "backdrop が消えない")


def wait_toast(driver: webdriver.Chrome, timeout: float = 3.0) -> str | None:
    """#toast.show の出現を待って textContent を返す（寿命2秒のため述語内で取得）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        text = driver.execute_script(
            "const t = document.getElementById('toast');"
            "return t && t.classList.contains('show') ? t.textContent : null;"
        )
        if text is not None:
            return text
        time.sleep(0.1)
    return None


def wait_toast_gone(driver: webdriver.Chrome, timeout: float = 4.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not driver.execute_script(
            "const t = document.getElementById('toast');"
            "return t && t.classList.contains('show');"
        ):
            return
        time.sleep(0.1)


def read_clipboard(driver: webdriver.Chrome) -> str | None:
    try:
        return driver.execute_async_script(
            "const done = arguments[arguments.length - 1];"
            "navigator.clipboard.readText().then(done, () => done(null));"
        )
    except WebDriverException:
        return None


def verify_copy_buttons(driver: webdriver.Chrome, sections: list[dict]) -> list[Check]:
    """各セクションのコピーボタン → トースト文言 →（可能なら）クリップボード照合。"""
    checks: list[Check] = []
    els = driver.find_elements(
        By.CSS_SELECTOR, "#modal-body .manuscript-section .manuscript-section-head button"
    )
    if len(els) != len(sections):
        checks.append(Check(
            "コピーボタンの数", "FAIL",
            f"セクション {len(sections)} に対しボタン {len(els)}",
        ))
        return checks

    driver.execute_script("window.focus();")
    for i, (btn, sec) in enumerate(zip(els, sections)):
        name = f"コピー: {sec['title']}"
        wait_toast_gone(driver)
        btn.click()
        toast = wait_toast(driver)
        if toast in COPIED_TOASTS:
            checks.append(Check(name + "（トースト）", "PASS", toast))
        elif toast in COPY_FAILED_TOASTS:
            checks.append(Check(name + "（トースト）", "FAIL", f"コピー失敗トースト: {toast}"))
        else:
            checks.append(Check(name + "（トースト）", "FAIL", f"トースト未検出/想定外: {toast!r}"))
            continue
        clip = read_clipboard(driver)
        if clip is not None:
            # Windows のクリップボード読み出しは改行を CRLF に正規化するため揃える
            clip = clip.replace("\r\n", "\n")
        if clip is None:
            checks.append(Check(name + "（クリップボード照合）", "INFO",
                                "clipboard.readText 不可（権限/フォーカス）— トーストを正とする"))
        elif clip == sec["text"]:
            checks.append(Check(name + "（クリップボード照合）", "PASS"))
        else:
            checks.append(Check(name + "（クリップボード照合）", "FAIL",
                                f"クリップボード内容がテキストエリアと不一致（len {len(clip)} vs {len(sec['text'])}）"))
    return checks


# ---------------------------------------------------------------------------
# チェック（抽出テキストへの純関数）
# ---------------------------------------------------------------------------

N_RE = re.compile(r"\(n = ([^)]+)\)")


def parse_prisma(text: str) -> dict:
    """PRISMA テキストから主要数値を抽出。見つからない項目は None。"""
    def num(pattern: str) -> int | None:
        m = re.search(pattern, text)
        return int(m.group(1)) if m else None

    return {
        "identified": num(r"Records identified from databases \(n = (\d+)\)"),
        "duplicates": num(r"Records removed before screening \(duplicates\) \(n = (\d+)\)"),
        "duplicates_unknown": "(duplicates) (n = [n])" in text,
        "screened": num(r"Records screened \(n = (\d+)\)"),
        "excluded": num(r"Records excluded \(n = (\d+)\)"),
        "sought": num(r"Reports sought for retrieval \(n = (\d+)\)"),
        "not_retrieved": num(r"Reports not retrieved \(n = (\d+)\)"),
        "assessed": num(r"Reports assessed for eligibility \(n = (\d+)\)"),
        "ft_excluded": num(r"Reports excluded \(n = (\d+)\)"),
        "included": num(r"Studies included in review \(n = (\d+)\)"),
    }


def check_common(extracted: dict) -> list[Check]:
    checks: list[Check] = []
    secs = extracted["sections"]

    checks.append(Check(
        "モーダルタイトル",
        "PASS" if extracted["title"] in MODAL_TITLES else "FAIL",
        extracted["title"],
    ))
    checks.append(Check(
        "免責注記（disclaimer）の表示",
        "PASS" if extracted["note"].strip() else "FAIL",
        extracted["note"][:80],
    ))
    checks.append(Check(
        "セクション数 = 3",
        "PASS" if len(secs) == 3 else "FAIL",
        f"{len(secs)} 個: {[s['title'] for s in secs]}",
    ))
    if len(secs) != 3:
        return checks

    titles_ok = (
        secs[0]["title"] == "Methods"
        and secs[1]["title"] == "Results"
        and secs[2]["title"] in PRISMA_SECTION_TITLES
    )
    checks.append(Check(
        "セクションタイトル（Methods / Results / PRISMA）",
        "PASS" if titles_ok else "FAIL",
        ", ".join(s["title"] for s in secs),
    ))

    methods, results, prisma = (s["text"] for s in secs)

    for label, text in (("Methods", methods), ("Results", results), ("PRISMA", prisma)):
        checks.append(Check(
            f"{label} が空でない",
            "PASS" if text.strip() else "FAIL",
            f"{len(text)} 文字",
        ))

    # PRISMA 見出し
    for header in ("Identification", "Screening", "Retrieval"):
        checks.append(Check(
            f"PRISMA 見出し: {header}",
            "PASS" if re.search(rf"^{header}$", prisma, re.M) else "FAIL",
        ))

    # (n = X) はすべて整数 or [n]
    bad_ns = [v for v in N_RE.findall(prisma) if not (v.isdigit() or v == "[n]")]
    checks.append(Check(
        "PRISMA の (n = X) はすべて整数か [n]",
        "PASS" if not bad_ns else "FAIL",
        f"不正値: {bad_ns}" if bad_ns else "",
    ))

    # 算術整合: screened - excluded = sought
    p = parse_prisma(prisma)
    if None not in (p["screened"], p["excluded"], p["sought"]):
        ok = p["screened"] - p["excluded"] == p["sought"]
        checks.append(Check(
            "算術: screened − excluded = sought",
            "PASS" if ok else "FAIL",
            f"{p['screened']} − {p['excluded']} = {p['screened'] - p['excluded']}（期待 {p['sought']}）",
        ))
    else:
        checks.append(Check("算術: screened − excluded = sought", "FAIL",
                            f"数値を抽出できない: {p}"))

    # バージョン表記（semver か [version]）
    m = re.search(r"TiAb Review \(version ([^)]+)\)", methods)
    ver_ok = bool(m) and (re.fullmatch(r"\d+\.\d+\.\d+", m.group(1)) or m.group(1) == "[version]")
    checks.append(Check(
        "Methods のバージョン表記（semver か [version]）",
        "PASS" if ver_ok else "FAIL",
        m.group(1) if m else "'TiAb Review (version …)' が見つからない",
    ))

    # 手入力プレースホルダ
    checks.append(Check(
        "Methods に [discussion / a third reviewer] プレースホルダ",
        "PASS" if "[discussion / a third reviewer]" in methods else "FAIL",
    ))

    # 警告は INFO でレポート
    for w in extracted["warnings"]:
        checks.append(Check("警告表示", "INFO", w))

    return checks


def check_tiab(extracted: dict) -> list[Check]:
    checks: list[Check] = []
    secs = extracted["sections"]
    if len(secs) != 3:
        return checks
    methods, results, prisma = (s["text"] for s in secs)
    p = parse_prisma(prisma)

    checks.append(Check(
        "TiAb: PRISMA に Eligibility/Included が無い",
        "PASS" if not re.search(r"^(Eligibility|Included)$", prisma, re.M) else "FAIL",
    ))
    m_rev = re.search(r"by (\d+) reviewers?\b(, blinded)?", methods)
    rev_ok = bool(m_rev) and (
        (int(m_rev.group(1)) > 1) == bool(m_rev.group(2))  # blinded 節は複数名のときのみ
    )
    checks.append(Check(
        "TiAb: Methods の reviewer 数と blinded 節（複数名時のみ）",
        "PASS" if rev_ok else "FAIL",
        m_rev.group(0) if m_rev else "'by N reviewer(s)' が見つからない",
    ))

    # Results 文中の数値 ↔ PRISMA の照合
    m = re.search(
        r"identified (\d+) records? .*After removal of (\d+|\[n\]) duplicates?, "
        r"(\d+) records? (?:was|were) screened, (\d+) (?:was|were) excluded, "
        r"and (\d+) (?:was|were) retained",
        results, re.S,
    )
    if not m:
        checks.append(Check("TiAb: Results 文の数値抽出", "FAIL", "定型文にマッチしない"))
    else:
        ident, dup, screened, excluded, retained = m.groups()
        pairs = [
            ("identified", int(ident), p["identified"]),
            ("screened", int(screened), p["screened"]),
            ("excluded", int(excluded), p["excluded"]),
            ("sought/retained", int(retained), p["sought"]),
        ]
        if dup != "[n]" and p["duplicates"] is not None:
            pairs.append(("duplicates", int(dup), p["duplicates"]))
        mismatch = [f"{k}: Results={a} PRISMA={b}" for k, a, b in pairs if a != b]
        checks.append(Check(
            "TiAb: Results の数値が PRISMA と一致",
            "PASS" if not mismatch else "FAIL",
            "; ".join(mismatch) if mismatch else
            f"identified={ident}, screened={screened}, excluded={excluded}, retained={retained}",
        ))
    return checks


def check_fulltext(extracted: dict) -> list[Check]:
    checks: list[Check] = []
    secs = extracted["sections"]
    if len(secs) != 3:
        return checks
    methods, results, prisma = (s["text"] for s in secs)
    p = parse_prisma(prisma)

    for header in ("Eligibility", "Included"):
        checks.append(Check(
            f"FT: PRISMA 見出し: {header}",
            "PASS" if re.search(rf"^{header}$", prisma, re.M) else "FAIL",
        ))
    for label in ("Reports not retrieved", "Studies included in review"):
        checks.append(Check(
            f"FT: PRISMA に {label}",
            "PASS" if label in prisma else "FAIL",
        ))

    if None not in (p["sought"], p["not_retrieved"], p["assessed"]):
        ok = p["sought"] == p["not_retrieved"] + p["assessed"]
        checks.append(Check(
            "FT算術: sought = not retrieved + assessed",
            "PASS" if ok else "FAIL",
            f"{p['sought']} vs {p['not_retrieved']} + {p['assessed']}",
        ))
    else:
        checks.append(Check("FT算術: sought = not retrieved + assessed", "FAIL",
                            f"数値を抽出できない: {p}"))

    # 除外理由の合計 ≤ Reports excluded（Eligibility ブロック内のインデント行のみ集計）
    elig = re.search(r"^Eligibility$(.*?)^Included$", prisma, re.M | re.S)
    if elig and p["ft_excluded"] is not None:
        reason_counts = [
            int(n) for n in re.findall(r"^    .+ \(n = (\d+)\)$", elig.group(1), re.M)
        ]
        total = sum(reason_counts)
        checks.append(Check(
            "FT: 除外理由の合計 ≤ Reports excluded",
            "PASS" if total <= p["ft_excluded"] else "FAIL",
            f"理由計 {total}（{len(reason_counts)} 種）/ excluded {p['ft_excluded']}",
        ))

    m = re.search(r"^Of the (\d+) reports? sought for retrieval", results)
    checks.append(Check(
        "FT: Results が 'Of the N reports sought' で始まる",
        "PASS" if m and p["sought"] is not None and int(m.group(1)) == p["sought"] else "FAIL",
        m.group(0) if m else results[:60],
    ))
    m2 = re.search(r"In total, (\d+) (?:study was|studies were) included", results)
    checks.append(Check(
        "FT: Results の included 数が PRISMA と一致",
        "PASS" if m2 and p["included"] is not None and int(m2.group(1)) == p["included"] else "FAIL",
        m2.group(0) if m2 else "'In total, N studies were included' が見つからない",
    ))
    checks.append(Check(
        "FT: Methods に assessed for eligibility",
        "PASS" if "assessed for eligibility" in methods else "FAIL",
    ))
    return checks


# ---------------------------------------------------------------------------
# レビューフロー本体
# ---------------------------------------------------------------------------

def review_modal(driver: webdriver.Chrome, phase: str, shots: Shots) -> ModalResult:
    """モーダルが開くのを待ち、抽出 → チェック → コピー検証 → 閉じる。"""
    result = ModalResult(phase=phase)
    extracted = wait_modal_open(driver)
    result.title = extracted["title"]
    result.note = extracted["note"]
    result.warnings = extracted["warnings"]
    result.sections = extracted["sections"]
    result.screenshots.append(shots.element(".modal-content", f"{phase}-modal"))

    result.checks += check_common(extracted)
    result.checks += check_tiab(extracted) if phase == "tiab" else check_fulltext(extracted)
    result.checks += verify_copy_buttons(driver, extracted["sections"])
    result.checks.append(close_modal(driver))
    return result


def run_tiab(driver: webdriver.Chrome, shots: Shots) -> ModalResult:
    print("[tiab] エクスポートメニューから論文用テキストを開く...")
    shots.page("screening-view")
    driver.find_element(By.ID, "export-btn").click()
    wait_for(driver, lambda d: is_displayed(d, "#export-manuscript-btn"), 5,
             "エクスポートメニュー表示")
    shots.page("export-menu")
    driver.find_element(By.ID, "export-manuscript-btn").click()
    return review_modal(driver, "tiab", shots)


def run_fulltext(driver: webdriver.Chrome, shots: Shots) -> ModalResult:
    print("[fulltext] フルテキスト結果ビューから論文用テキストを開く...")
    driver.find_element(By.ID, "tab-fulltext").click()
    wait_for(driver, lambda d: is_displayed(d, "#fulltext-section"), 10,
             "フルテキストセクション表示")
    driver.find_element(By.ID, "fulltext-mode-results").click()
    wait_for(driver, lambda d: is_displayed(d, "#fulltext-manuscript-btn"), 30,
             "フルテキスト結果ビュー（論文用テキストボタン）表示")
    shots.page("fulltext-results-view")
    driver.find_element(By.ID, "fulltext-manuscript-btn").click()
    return review_modal(driver, "fulltext", shots)


def main() -> int:
    # 背景実行時のバッファリング・コンソール文字化け対策
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sheet", default=os.environ.get("TIAB_REVIEW_SHEET"),
                    help="プロジェクトのスプレッドシート URL か ID（env TIAB_REVIEW_SHEET でも可）")
    ap.add_argument("--skip-fulltext", action="store_true",
                    help="フルテキスト側の検証をスキップ")
    ap.add_argument("--lang", default="ja", choices=["ja", "en"])
    ap.add_argument("--output-dir", default=None,
                    help="出力先（既定: scripts/selenium-review/output/<timestamp>）")
    ap.add_argument("--keep-open", action="store_true",
                    help="終了後もブラウザを開いたままにする（手動確認用）")
    args = ap.parse_args()

    if not args.sheet:
        ap.error("--sheet か環境変数 TIAB_REVIEW_SHEET を指定してください")
    if not (DIST_DIR / "manifest.json").exists():
        sys.exit(f"[error] {DIST_DIR} に manifest.json がありません。先に `npm run dev` を実行してください。")

    out_dir = Path(args.output_dir) if args.output_dir else (
        SCRIPT_DIR / "output" / datetime.now().strftime("%Y%m%d-%H%M%S")
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"[setup] 出力先: {out_dir}")

    driver = build_driver(args.lang)
    results: list[ModalResult] = []
    meta: dict = {}
    try:
        try:
            driver.execute_cdp_cmd("Browser.grantPermissions", {
                "origin": f"chrome-extension://{EXT_ID}",
                "permissions": ["clipboardReadWrite", "clipboardSanitizedWrite"],
            })
        except WebDriverException as e:
            print(f"[setup] クリップボード権限付与に失敗（照合は INFO 扱いになります）: {e}")

        try:
            open_sidepanel(driver)
            ensure_signed_in(driver)
        except (InvalidSessionIdException, NoSuchWindowException):
            sys.exit(
                "[error] レビュー用の Chrome ウィンドウが閉じられました。"
                "スクリプトが開くウィンドウは閉じずに、Google サインインだけ"
                "完了してください。再実行すれば続きから動きます。"
            )

        shots = Shots(driver, out_dir)
        connect_project(driver, args.sheet, shots)

        meta = {
            "日時": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "Chrome": driver.capabilities.get("browserVersion", "?"),
            "拡張バージョン": driver.execute_script(
                "return chrome.runtime.getManifest().version"),
            "拡張名": driver.execute_script(
                "return chrome.runtime.getManifest().name"),
            "シート": args.sheet,
            "言語": args.lang,
        }

        try:
            results.append(run_tiab(driver, shots))
        except (TimeoutException, WebDriverException) as e:
            r = ModalResult(phase="tiab", error=str(e))
            r.screenshots.append(shots.page("tiab-error"))
            results.append(r)

        if not args.skip_fulltext:
            try:
                results.append(run_fulltext(driver, shots))
            except (TimeoutException, WebDriverException) as e:
                r = ModalResult(phase="fulltext", error=str(e))
                r.screenshots.append(shots.page("fulltext-error"))
                results.append(r)
    finally:
        if args.keep_open:
            print("[done] --keep-open 指定のためブラウザは開いたままです（手動で閉じてください）")
        else:
            driver.quit()

    (out_dir / "extracted.json").write_text(
        json.dumps([r.to_json() for r in results], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (out_dir / "report.md").write_text(render_report(meta, results), encoding="utf-8")

    n_fail = sum(1 for r in results for c in r.checks if c.status == "FAIL")
    n_fail += sum(1 for r in results if r.error)
    print(f"\n[done] レポート: {out_dir / 'report.md'}")
    print(f"[done] FAIL {n_fail} 件" if n_fail else "[done] 全チェック PASS")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
