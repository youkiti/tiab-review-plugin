"""外部サービスを呼ばず、一時リポジトリで worktree 削除の安全性を検証する。"""

import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import remove_merged_worktrees as hook


class InputTests(unittest.TestCase):
    def test_unrelated_and_invalid_input(self):
        for raw in ('{"tool_input":{"command":"git status"}}', "{", "null", "[]"):
            with self.subTest(raw=raw):
                output = io.StringIO()
                self.assertEqual(hook.main(io.StringIO(raw), output), 0)
                self.assertEqual(output.getvalue(), "")

    def test_regex(self):
        self.assertIsNotNone(hook.read_input(io.StringIO(
            json.dumps({"tool_input": {"command": "echo ok && gh pr merge --squash"}}),
        )))

    def test_rebuildable_paths(self):
        for path in ("dist/x.js", "nested/node_modules/x", "docs/app/index.html",
                     "dist.zip", "dist-store-1.zip", "x.tsbuildinfo", "x.pyc",
                     ".eslintcache", "coverage/", "dist-demo/x", "dist-web-demo/x",
                     "test-results/x", "playwright-report/x", "__pycache__/x", ".pytest_cache/x"):
            with self.subTest(path=path):
                self.assertTrue(hook.rebuildable(path))
        for path in (".env", ".env.local", "run.log", "experiments/results/x.json", "docs/application/x"):
            with self.subTest(path=path):
                self.assertFalse(hook.rebuildable(path))

    def test_merge_checker_requires_exact_head_and_caches_repo(self):
        budget = unittest.mock.Mock()
        budget.run.side_effect = ["owner/repo\n", '[{"number":1,"headRefOid":"old"}]',
                                  '[{"number":2,"headRefOid":"current"}]']
        checker = hook.make_merge_checker("repo", budget)
        self.assertFalse(checker("topic", "current"))
        self.assertTrue(checker("topic", "current"))
        self.assertEqual(budget.run.call_count, 3)
        command = budget.run.call_args.args[0]
        self.assertEqual(command, ["gh", "pr", "list", "--repo", "owner/repo", "--head",
                                   "topic", "--state", "merged", "--json", "number,headRefOid",
                                   "--limit", "20"])

    def test_timeout_uses_remaining_global_budget(self):
        budget = hook.Budget(5)
        with patch.object(hook.subprocess, "run") as run:
            run.return_value.stdout = ""
            budget.run(["git", "status"], ".")
        self.assertGreater(run.call_args.kwargs["timeout"], 0)
        self.assertLessEqual(run.call_args.kwargs["timeout"], 5)
        with self.assertRaises(TimeoutError):
            hook.Budget(-1).run(["git", "status"], ".")


class WorktreeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wtc")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.repo = self.base / "r"
        self.repo.mkdir()
        self.git(self.repo, "init", "-b", "main")
        self.write(self.repo / ".gitignore", "dist/\n.env*\n*.log\n")
        self.write(self.repo / "tracked.txt", "元の内容\n")
        self.git(self.repo, "add", ".gitignore", "tracked.txt")
        self.git(self.repo, "-c", "user.name=t", "-c", "user.email=t@example.com",
                 "commit", "-m", "テスト用の初期コミット")
        self.wt = self.base / "w"
        self.git(self.repo, "worktree", "add", "-b", "topic", str(self.wt))

    def git(self, cwd, *args):
        return subprocess.run(
            ["git", *args], cwd=cwd, check=True, capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=30,
        ).stdout

    def write(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")

    def run_hook(self, checker=None, cwd=None):
        data = {"tool_name": "Bash", "tool_input": {"command": "gh pr merge --squash"},
                "cwd": str(cwd or self.repo)}
        output = io.StringIO()
        checker = checker if checker is not None else lambda branch, sha: True
        self.assertEqual(hook.main(io.StringIO(json.dumps(data)), output, checker), 0)
        if not output.getvalue():
            return None
        result = json.loads(output.getvalue())
        self.assertEqual(result["hookSpecificOutput"]["hookEventName"], "PostToolUse")
        return result["hookSpecificOutput"]["additionalContext"]

    def test_clean_merged_worktree_removed_branch_preserved(self):
        report = self.run_hook()
        self.assertFalse(self.wt.exists())
        self.assertIn("消した 1 件、残した 0 件", report)
        self.assertTrue(self.repo.is_dir())
        self.assertIn("refs/heads/topic", self.git(self.repo, "show-ref", "--heads"))
        self.assertNotIn(str(self.repo).replace("\\", "/") + "（", report)

    def test_modified_worktree_preserved(self):
        self.write(self.wt / "tracked.txt", "変更した内容\n")
        self.assertIn("未コミット", self.run_hook())
        self.assertTrue(self.wt.exists())

    def test_staged_worktree_preserved(self):
        self.write(self.wt / "tracked.txt", "変更した内容\n")
        self.git(self.wt, "add", "tracked.txt")
        self.assertIn("ステージ済み", self.run_hook())
        self.assertTrue(self.wt.exists())

    def test_untracked_worktree_preserved(self):
        self.write(self.wt / "new.txt", "保存する内容\n")
        self.assertIn("未追跡", self.run_hook())
        self.assertTrue(self.wt.exists())

    def test_rebuildable_ignored_files_removed(self):
        self.write(self.wt / "dist" / "x.js", "生成物\n")
        self.assertIn("消した 1 件", self.run_hook())
        self.assertFalse(self.wt.exists())

    def test_env_and_logs_preserved(self):
        self.write(self.wt / "dist" / "x.js", "生成物\n")
        self.write(self.wt / ".env", "テスト用\n")
        self.write(self.wt / "run.log", "テスト用\n")
        report = self.run_hook()
        self.assertIn(".env", report)
        self.assertIn("run.log", report)
        self.assertTrue(self.wt.exists())

    def test_unmerged_or_new_head_preserved(self):
        self.assertIn("HEAD と不一致", self.run_hook(lambda branch, sha: False))
        self.assertTrue(self.wt.exists())

    def test_commit_after_merge_preserved(self):
        merged_sha = self.git(self.wt, "rev-parse", "HEAD").strip()
        self.git(self.wt, "-c", "user.name=t", "-c", "user.email=t@example.com",
                 "commit", "--allow-empty", "-m", "マージ後の追加コミット")
        self.assertIn("HEAD と不一致", self.run_hook(lambda branch, sha: sha == merged_sha))
        self.assertTrue(self.wt.exists())

    def test_link_removal_failure_preserves_worktree(self):
        with patch.object(hook, "find_links", return_value=[str(self.wt / "link")]):
            with patch.object(hook.os, "rmdir", side_effect=OSError("テスト用の削除失敗")):
                report = self.run_hook()
        self.assertIn("例外（OSError）", report)
        self.assertTrue(self.wt.exists())

    def test_merge_check_error_preserved(self):
        def unavailable(branch, sha):
            raise subprocess.TimeoutExpired("gh", 30)

        self.assertIn("判定できず、残した: 例外（TimeoutExpired）", self.run_hook(unavailable))
        self.assertTrue(self.wt.exists())

    def test_cwd_inside_worktree_preserved(self):
        inner = self.wt / "sub"
        inner.mkdir()
        self.assertIn("cwd を外してから消す", self.run_hook(cwd=inner))
        self.assertTrue(self.wt.exists())

    def test_only_main_checkout_is_silent(self):
        self.git(self.repo, "worktree", "remove", str(self.wt))
        self.assertIsNone(self.run_hook())
        self.assertTrue(self.repo.exists())

    def test_locked_worktree_preserved(self):
        self.git(self.repo, "worktree", "lock", str(self.wt))
        self.assertIn("locked", self.run_hook())
        self.assertTrue(self.wt.exists())

    def test_detached_worktree_preserved(self):
        self.git(self.wt, "checkout", "--detach")
        self.assertIn("detached", self.run_hook())
        self.assertTrue(self.wt.exists())

    def test_missing_prunable_worktree_preserved(self):
        moved = self.base / "moved"
        self.wt.rename(moved)
        self.assertIn("prunable", self.run_hook())
        self.assertTrue(moved.exists())

    def test_remove_failure_reports_registration_and_remaining_directory(self):
        real_run = hook.Budget.run

        def fail_remove(budget, args, cwd):
            if args[:3] == ["git", "worktree", "remove"]:
                real_run(budget, args, cwd)
                self.wt.mkdir()
                raise subprocess.CalledProcessError(1, args, stderr="削除エラー\n詳細")
            return real_run(budget, args, cwd)

        with patch.object(hook.Budget, "run", fail_remove):
            report = self.run_hook()
        self.assertIn("終了コード 1", report)
        self.assertIn("削除エラー", report)
        self.assertIn("登録は外れたがディレクトリが残った", report)
        self.assertTrue(self.wt.exists())

    def test_junction_removed_without_touching_target(self):
        self.check_junction_cleanup(ignored=False)

    def test_ignored_junction_removed_without_touching_target(self):
        self.write(self.repo / ".git" / "info" / "exclude", "node_modules/\n")
        self.check_junction_cleanup(ignored=True)

    def check_junction_cleanup(self, ignored):
        if os.name != "nt":
            self.skipTest("Windows の junction を作れない環境")
        target = self.base / "target"
        self.write(target / "keep.txt", "残す内容\n")
        link = self.wt / "node_modules"
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True, timeout=30,
        )
        if result.returncode:
            self.skipTest(f"junction の作成不可（終了コード {result.returncode}）")
        # テストが途中で失敗しても、一時領域の後始末でリンク先を辿らせない。
        def detach_link():
            if os.path.lexists(link):
                os.rmdir(link)

        self.addCleanup(detach_link)
        status = self.git(self.wt, "status", "--porcelain=v1", "--ignored", "--untracked-files=all")
        self.assertIn("!! node_modules" if ignored else "?? node_modules", status)
        links = hook.find_links(str(self.wt), hook.Budget())
        self.assertEqual(links, [str(link)])
        report = self.run_hook()
        self.assertIn("消した 1 件", report)
        self.assertFalse(self.wt.exists())
        self.assertEqual((target / "keep.txt").read_text(encoding="utf-8"), "残す内容\n")


if __name__ == "__main__":
    unittest.main()
