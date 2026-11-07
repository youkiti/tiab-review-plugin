"""gh pr merge の実行後に、マージ済みの worktree を安全に片付ける。

HEAD がマージ済み PR と一致し、保存すべきファイルが無い場合だけ削除する。
共有先へのリンクは実体を辿らずに外し、ブランチは残す。
"""

import fnmatch
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time


REBUILDABLE = {
    "node_modules", "dist", "dist-demo", "dist-web-demo", "coverage",
    "test-results", "playwright-report", "__pycache__", ".pytest_cache",
    ".eslintcache",
}


class Budget:
    def __init__(self, seconds=110):
        self.deadline = time.monotonic() + seconds

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("全体の制限時間に到達")
        return remaining

    def run(self, args, cwd):
        return subprocess.run(
            args, cwd=cwd, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=min(30, self.remaining()), check=True,
        ).stdout


def read_input(stream):
    try:
        data = json.load(stream)
        command = data.get("tool_input", {}).get("command", "")
        if isinstance(command, str) and re.search(r"\bgh\s+pr\s+merge\b", command):
            return data
    except (ValueError, TypeError, AttributeError):
        pass
    return None


def list_worktrees(repo, budget):
    output = budget.run(["git", "worktree", "list", "--porcelain", "-z"], repo)
    entries = []
    entry = {}
    for field in output.split("\0"):
        if not field:
            if entry:
                entries.append(entry)
                entry = {}
            continue
        key, _, value = field.partition(" ")
        entry[key] = value
    if entry:
        entries.append(entry)
    return entries


def is_inside(path, directory):
    path = os.path.normcase(os.path.realpath(path))
    directory = os.path.normcase(os.path.realpath(directory))
    try:
        return os.path.commonpath([path, directory]) == directory
    except ValueError:
        return False


def make_merge_checker(repo, budget):
    owner = None
    owner_error = None

    def check(branch, sha):
        nonlocal owner, owner_error
        if owner_error is not None:
            raise owner_error
        if owner is None:
            try:
                owner = budget.run(
                    ["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
                    repo,
                ).strip()
                if not re.fullmatch(r"[^/\s]+/[^/\s]+", owner):
                    raise ValueError("リポジトリ名が不正")
            except Exception as error:
                owner_error = error
                raise
        output = budget.run(
            ["gh", "pr", "list", "--repo", owner, "--head", branch,
             "--state", "merged", "--json", "number,headRefOid", "--limit", "20"],
            repo,
        )
        return any(pr["headRefOid"] == sha for pr in json.loads(output))

    return check


def is_link(path):
    attributes = getattr(os.lstat(path), "st_file_attributes", 0)
    return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT) or os.path.islink(path)


def find_links(root, budget):
    links = []

    def walk_error(error):
        raise error

    for directory, dirs, files in os.walk(root, topdown=True, followlinks=False, onerror=walk_error):
        budget.remaining()
        for name in list(dirs) + files:
            budget.remaining()
            if name == ".git":
                if name in dirs:
                    dirs.remove(name)
                continue
            path = os.path.join(directory, name)
            if is_link(path):
                links.append(path)
                if name in dirs:
                    dirs.remove(name)
    return links


def rebuildable(path):
    parts = path.rstrip("/").split("/")
    if any(part in REBUILDABLE for part in parts):
        return True
    if path.startswith("docs/app/"):
        return True
    return any(fnmatch.fnmatchcase(parts[-1], pattern) for pattern in (
        "dist.zip", "dist-store-*.zip", "*.tsbuildinfo", "*.pyc",
    ))


def dirty_reason(root, links, budget):
    output = budget.run(
        ["git", "-C", root, "status", "--porcelain=v1", "--ignored",
         "--untracked-files=normal", "-z"], root,
    )
    link_names = [os.path.relpath(link, root).replace(os.sep, "/") for link in links]
    removable_names = set()
    preserved = []
    for record in output.split("\0"):
        budget.remaining()
        if not record:
            continue
        status = record[:2]
        path = record[3:].rstrip("/")
        if status in ("??", "!!"):
            removable_names.update(name for name in link_names
                                   if name == path or name.startswith(path + "/"))
            if any(path == name or path.startswith(name + "/") for name in link_names):
                continue
        if status == "??":
            return "未追跡ファイルがある", []
        if status != "!!":
            return "未コミットの変更・ステージ済み変更・競合がある", []
        if not rebuildable(path + ("/" if record.endswith("/") else "")):
            preserved.append(path)
    if preserved:
        return "保存すべき無視ファイルがある: " + "、".join(preserved[:5]), []
    # 追跡対象のリンクは外さず、その worktree は残す。
    tracked_links = [name for name in link_names if name not in removable_names]
    if tracked_links:
        return "追跡対象のリンクがある: " + "、".join(tracked_links[:5]), []
    return None, [link for link, name in zip(links, link_names) if name in removable_names]


def remove_worktree(repo, root, links, budget):
    # リンク先は削除せず、リンク自身だけを外す。
    for link in links:
        budget.remaining()
        if os.path.islink(link):
            os.unlink(link)
        else:
            os.rmdir(link)
        if os.path.lexists(link):
            return False, "リンクが残ったため削除を中止"
    try:
        budget.run(["git", "worktree", "remove", root], repo)
    except subprocess.CalledProcessError as error:
        first_line = (error.stderr or "標準エラーなし").splitlines()[0]
        reason = f"削除失敗（終了コード {error.returncode}）: {first_line}"
        try:
            entries = list_worktrees(repo, budget)
            registered = any(is_inside(root, item["worktree"]) and
                             is_inside(item["worktree"], root) for item in entries)
            if not registered and os.path.lexists(root):
                reason += "。登録は外れたがディレクトリが残った"
        except Exception as refresh_error:
            reason += f"。登録の再確認で例外（{type(refresh_error).__name__}）"
        return False, reason
    return True, "マージ済み PR の HEAD と一致し、保存すべきファイルなし"


def skip_reason(entry, cwd):
    root = entry["worktree"]
    if "locked" in entry:
        return "locked が付いている"
    if "prunable" in entry:
        return "prunable が付いている"
    if not os.path.isdir(root):
        return "ディレクトリが存在しない"
    if is_inside(cwd, root):
        return "cwd を外してから消す"
    if "detached" in entry or "branch" not in entry:
        return "detached（ブランチが無い）"
    return None


def cleanup(data, merge_checker=None, budget=None):
    budget = budget or Budget()
    cwd = data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    rows = []
    try:
        common = budget.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd,
        ).strip()
        repo = str(Path(common).parent)
        entries = list_worktrees(repo, budget)
        checker = merge_checker or make_merge_checker(repo, budget)
        # porcelain の先頭は本体なので、報告も処理も行わない。
        for entry in entries[1:]:
            root = entry["worktree"]
            branch = entry.get("branch", "detached").removeprefix("refs/heads/")
            removed = False
            try:
                reason = skip_reason(entry, cwd)
                if reason is None:
                    try:
                        budget.remaining()
                        merged = checker(branch, entry["HEAD"])
                    except Exception as error:
                        reason = f"判定できず、残した: 例外（{type(error).__name__}）"
                    else:
                        if not merged:
                            reason = "マージ済み PR の HEAD と不一致（未マージ、またはマージ後の追加コミット）"
                if reason is None:
                    links = find_links(root, budget)
                    reason, removable_links = dirty_reason(root, links, budget)
                    if reason is None:
                        removed, reason = remove_worktree(repo, root, removable_links, budget)
            except Exception as error:
                reason = f"安全確認・削除で例外（{type(error).__name__}）。残した"
            rows.append((root, branch, removed, reason))
    except Exception as error:
        return build_report(rows, f"リポジトリの確認で例外（{type(error).__name__}）。削除を中止")
    return build_report(rows)


def build_report(rows, error=None):
    if not rows and error is None:
        return None
    removed = sum(row[2] for row in rows)
    lines = [f"マージ済み worktree の自動削除: 消した {removed} 件、残した {len(rows) - removed} 件"]
    for root, branch, deleted, reason in rows:
        action = "消した" if deleted else "残した"
        lines.append(f"- {root}（{branch}）: {action}: {reason}")
    if error:
        lines.append(error)
    return {"hookSpecificOutput": {
        "hookEventName": "PostToolUse", "additionalContext": "\n".join(lines),
    }}


def main(stdin=None, stdout=None, merge_checker=None):
    stdin = stdin if stdin is not None else sys.stdin
    stdout = stdout if stdout is not None else sys.stdout
    try:
        data = read_input(stdin)
        if data is None:
            return 0
        report = cleanup(data, merge_checker)
        if report is not None:
            print(json.dumps(report, ensure_ascii=False), file=stdout)
    except Exception as error:
        try:
            report = build_report([], f"フックで例外（{type(error).__name__}）。削除を中止")
            print(json.dumps(report, ensure_ascii=False), file=stdout)
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
