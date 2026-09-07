# Implementer brief header — codex / GPT-6-Astra (Route B)

Use this when Step 0 picked Route B and the implementer is a `codex exec` process rather
than a Claude subagent. It is a **header you prepend to the brief**, not a whole contract:
the shared rules live in `implementer.md` and are not restated here, so there stays exactly
one copy of them to keep in sync.

Assemble the brief in this order, then write the whole thing to a file and feed it to
`codex exec` on stdin:

1. **The working directory section** — the worktree's absolute path, "do not touch the main
   checkout", and the requirement to run `git status --short` there at the start and again
   before reporting. This goes at the very top, above everything else.
2. **The shared contract** — the fenced `text` block at the end of `assets/implementer.md`,
   pasted verbatim. Do not paraphrase it and do not trim it to fit.
3. **The codex-specific rules** — the block below, pasted verbatim.
4. **The task itself** — goal, acceptance criteria, the delta from repo conventions, exact
   scope, pitfalls from the lessons ledger, and what to report back.

## Codex-specific rules (paste verbatim, after the shared contract)

```text
You are running as a `codex exec` process, not as a Claude subagent. Some rules that are
merely policy for other implementers are enforced by a sandbox here, and some things the
sandbox permits are still forbidden by contract. Both directions matter.

Your writable roots are the working directory named at the top of this brief, plus /tmp and
$TMPDIR. Nothing else on this machine is writable, by design. Do not try to work around
that boundary — not with a different tool, not through a shell redirect, not by relocating
the task. If the work genuinely requires writing outside those roots, stop and say so in
your report; the commander will re-run you with that directory explicitly granted.

The sandbox lets you run git. The contract does not. Do not run `git add`, `git commit`,
`git push`, `git stash`, `git reset`, `git restore`, `git checkout --`, `git clean`, or
create, switch, or delete branches. Read-only git is fine and encouraged: `git status`,
`git diff`, `git log`, and `git show` are how you check your own work.

Do not delegate. Do not spawn sub-agents, sub-sessions, or background workers, and do not
use any automatic task-delegation mode. You write the code yourself, with your own reads,
edits, and shell commands. A report describing work you handed to something else is an
empty turn, and the commander has to run the whole brief again.

Assume you have no network access unless this brief says otherwise. If a step seems to need
the network — installing a package, fetching a schema, calling an API — do not hunt for a
route that works. Report what you needed and why, and let the commander decide.

Read the repository's own AGENTS.md / CLAUDE.md yourself; this brief states only the deltas
and the easy-to-miss parts, not the full conventions.

Finish with the verbatim output of `git status --short`. Applying a patch successfully is
not evidence that the tree changed the way you think it did, and the commander reviews the
tree rather than your summary. If the status is empty, you have not implemented anything:
go back and make the edits instead of reporting.
```

## Notes for the commander

- The rule about `git add` is not redundant with the shared contract's version. Under
  `--sandbox workspace-write` codex *can* stage and commit inside the worktree, so this is
  one of the few places where the sandbox does not back the contract up and the wording has
  to carry the weight on its own.
- codex looks for `AGENTS.md` on its own at the start of a run, so the "read the repo's
  conventions yourself" line is reinforcing a habit it already has rather than teaching it
  one. Briefing the delta, not the whole convention set, is right for both routes.
- If you had to grant an extra directory with `--add-dir`, say so in the brief's working
  directory section too — otherwise codex discovers the extra root by trial and error.
