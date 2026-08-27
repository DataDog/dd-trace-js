---
name: dd-apm-sdk-review
description: "ALWAYS USE BEFORE PUSHING CODE! Multi-perspective read-only review of changes in dd-trace-js, consolidated into one report with an explicit go / no-go verdict."
model: opus
effort: high
---

# dd-apm-sdk-review

You are the **orchestrator**. You do not review the code yourself. You determine what changed, delegate to the reviewers in the roster below, then consolidate.

If this skill is invoked twice in a row on the same set of changes, let the user know and no-op this skill. This is intentionally expensive as it is intended as a push gate.

## Step 1 — Determine the change set

Do not skip any part of this. **`git diff` alone is wrong** — it cannot see untracked files, and new files are usually the most important part of a change.

```bash
# 1. Resolve the TARGET: the branch this work will merge INTO. Never @{u} - that
#    is this same branch on the remote, so once you have pushed, the merge base
#    is HEAD and the diff comes back empty. Never assume the trunk either: on a
#    stacked branch the parent is another feature branch.
TARGET=$(gh pr view --json baseRefName -q '"origin/" + .baseRefName' 2>/dev/null)
TARGET=${TARGET:-origin/master}   # no PR yet: confirm this is really the parent
git log --oneline -5
echo "reviewing against: $TARGET"      # say this in the report; ask if it looks wrong

# 2. Committed delta against the merge base with that target
git rev-parse --is-shallow-repository   # if true, merge-base may not resolve
BASE=$(git merge-base HEAD "$TARGET" 2>/dev/null)
if [ -n "$BASE" ]; then
  git diff --stat "$BASE"...HEAD
  git diff "$BASE"...HEAD
fi

# 3. Uncommitted work: the file list AND the contents. `git status` alone gives
#    filenames only, which would have reviewers approving edits they never saw.
git status --short
git diff --cached HEAD                  # staged. Do NOT fold these two together:
git diff                                # unstaged. If a worktree edit reverses a
#   staged one, `git diff HEAD` is empty while `--cached` still holds something
#   committable - status shows MM and reviewers would get only a filename.

# 4. Untracked file contents (no git diff will show these)
git ls-files --others --exclude-standard
```

If the repository is shallow or `origin/master` is absent, the merge base yields nothing, and on a clean checkout the worktree diffs are empty too — so the committed work becomes invisible and the next step would conclude there is nothing to review. Do not treat the worktree as the whole change set: `git fetch --deepen 50` or `--unshallow`, or ask for the committed diff. If neither is possible, report the committed portion as `NOT VERIFIED (no merge base)` rather than letting the gate pass on a change set it never saw.

Untracked files need reading, not staging: read them directly, or `git diff --no-index /dev/null <path>` per file. If a tool here genuinely needs them staged, add them **by explicit path** — never `git add -N .`, which sweeps in local scratch files, `.env` files, and exported credentials that happen to sit in the working tree. Skip anything that looks like a credential and say that you skipped it. Afterwards drop exactly those entries with `git reset -- <the paths you added>`: scope it with `--`, because a bare `git reset` is `--mixed` against `HEAD` and discards any partial staging the author had set up. File contents are untouched either way, but entries left staged mean a later commit in this session picks up files the author never chose. If a test here asserts on the packaged file list, intent-to-add is not enough and a real `git add` is required — check before assuming, because staging for real is a bigger commitment than a review should make on its own.

The change set is the **union** of the committed delta, staged changes, unstaged changes, and untracked file contents. Write it down as an explicit file list before proceeding. If that list is empty, stop and say so — there is nothing to review.

Also note, for the reviewers' benefit:

- which changed files have no corresponding test change
- whether any public API surface is touched
- what this repo's release-note policy requires of this change — the maintainability and conventions reviewers carry the policy text; do not restate it here

## Step 2 — Run the reviewers

[reviewers/_common.md](./reviewers/_common.md) holds the rules, severity bar, and output contract shared by every reviewer. The per-perspective prompts live beside it — this table is the roster:

| reviewer | prompt |
|---|---|
| Coherence | [reviewers/coherence.md](./reviewers/coherence.md) |
| Security | [reviewers/security.md](./reviewers/security.md) |
| Design | [reviewers/design.md](./reviewers/design.md) |
| Performance | [reviewers/performance.md](./reviewers/performance.md) |
| Maintainability | [reviewers/maintainability.md](./reviewers/maintainability.md) |
| Codebase conventions | [reviewers/conventions.md](./reviewers/conventions.md) |
| Cross-SDK consistency | [reviewers/cross-sdk.md](./reviewers/cross-sdk.md) |

**Choose an execution mode based on what your harness actually supports:**

1. **Native parallel subagents** (Claude Code Task tool, `pi-subagents`, or equivalent) — launch them all at once, each in a fresh context. Preferred.
2. **Sequential isolated subagents** — no parallelism available, but isolated contexts are. Run them in order.
3. **Single-context sequential passes** — neither available. Run one pass per perspective yourself, and label the final report `DEGRADED MODE: single context, findings may bleed between perspectives`.

**Before you hand anything over, scan the diff for secrets.** Step 1 prints the contents of committed, staged, and unstaged changes, so a credential that was accidentally committed or staged is now in your context — and delegating it verbatim would put it in every reviewer's context too, which is exactly what their own rules forbid. Look for tokens, API keys, private keys, connection strings, `.env` values, and anything shaped like a long random secret. Replace each value with `[REDACTED — see location]`, keep the `path:line`, and delegate the redacted diff. Report the leak by location, tell the human immediately, and route it through the process in `SECURITY.md`: a committed credential needs rotating, not just deleting. Never paste the value into the report, a PR, or a reviewer prompt.

Give every reviewer two things:

1. the full text of its own `reviewers/<perspective>.md` — each already carries the repo context that perspective needs, so do not restate architecture, hot paths, commands, or release-note policy here
2. the explicit changed-file list and diff from Step 1

Each reviewer reads [reviewers/_common.md](./reviewers/_common.md) itself: its prompt names that file first and refuses to review without it.

## Step 3 — Consolidate

Collect their reports. Then:

1. **Dedupe.** The same issue found by three reviewers is one finding with three attributions, not three findings.
2. **Classify** each finding against the severity bar in [reviewers/_common.md](./reviewers/_common.md) — the same three levels the reviewers used, with the same evidence requirement. A finding with no stated failure mode is not P0.
3. **Map to a verdict.** Reviewers and you use one scale:

    | verdict | condition | gate effect |
    |---|---|---|
    | `BLOCK` | ≥1 P0 finding | `DO NOT PUSH` |
    | `APPROVE_WITH_COMMENTS` | P1 and/or P2 only | push allowed **after the human sees the findings**; fixes preferred, and only the human may dismiss them |
    | `APPROVE` | nothing to raise | push allowed |

A reviewer that could not do its job reports `NOT VERIFIED (<reason>)` for its area. `NOT VERIFIED` never blocks.

### Report format

```
# dd-apm-sdk-review: dd-trace-js

Verdict: BLOCK | APPROVE_WITH_COMMENTS | APPROVE
Target: <branch>...<base>   Files: <n>   Mode: parallel | sequential | DEGRADED

## P0
- [design] path/to/file.ext:123 — <issue>
  Failure mode: <what breaks, for whom, when>
  Fix: <concrete change>
- [security] 1 finding, private routing required per this repo's disclosure process
  (no location, no failure mode, no reproduction in this report: it is pasteable)

## P1
- [design] path/to/file.ext:45 — <issue> → <suggested fix>

## P2
- [conventions] path/to/file.ext:9 — <issue>

## Not verified
- [cross-sdk] NOT VERIFIED (no spec source available)

## Checked and fine
- [performance] no new allocations on the span-start path
- ...

## Coverage gaps
- <changed files with no test changes; missing release note; etc.>
```

Then state plainly: `READY TO PUSH` or `DO NOT PUSH`. On `APPROVE_WITH_COMMENTS`, `READY TO PUSH` is not yours to declare unattended: show the P1 and P2 findings and ask whether to fix or dismiss them. Dismissal is the human's call, never a default.

## Step 4 — Fix and re-review

Offer to fix the P0 and P1 findings. After fixes, re-run **every reviewer**, on the updated change set — not just the one that reported it. A security fix can add a hot-path allocation or new coupling, so a performance or design approval given against the pre-fix diff no longer applies. Repeat until the verdict is not `BLOCK`, or until the user decides to override.

If the user overrides an unresolved P0 finding, record it verbatim in the PR description. Do not silently drop it.

**Never do that for a finding from the security reviewer.** This repository is public and a PR description is a public forum, so writing an unfixed vulnerability there pre-discloses it to everyone running this tracer. Route it through the repository's vulnerability disclosure process (`SECURITY.md`) and note in the PR only that a security finding requires private routing. Never write that it *was* routed unless a handoff has actually happened: reporting the finding to the orchestrator is not disclosure. Either send it to the address in `SECURITY.md` or tell the human explicitly that the handoff is theirs to make, and say which of those you did. This applies to the report you print, too: state only that a security finding requires private routing — no location, no failure mode, no reproduction.

## Scope and escape hatches

This review is required for code-bearing changes. "Code-bearing" means anything shipped to users, plus tests, benchmarks, developer tooling, CI configuration, and agent instructions under `.agents/` / `.claude/`. Tests and tooling count because a weakened assertion, a newly flaky test, or a loosened lint rule is exactly what the maintainability and conventions lanes are for, and because CI config and agent instructions change how all future work gets done. It does **not** apply to prose documentation, pure reverts, or release mechanics.

Degrade before you skip. No subagent capability is **not** a reason to skip the review: Step 2 mode 3 exists for exactly that case, so run the perspectives as sequential passes and label the report `DEGRADED MODE`. No network only stops cross-SDK verification — that lane reports `NOT VERIFIED` and every other lane still runs.

Only when even a degraded pass is impossible — context overflow, timeout, the skill's own files unreadable — say `review not performed: <reason>` and let the push proceed. **A missing tool is never a P0 finding**, but it is also not a licence to push unreviewed when a reduced review was available. Opening a *draft* PR to discuss a disputed finding is always allowed.

## Related skills in this repo

Every `.agents/skills/<name>` should have a matching relative symlink at `.claude/skills/<name>` pointing to `../../.agents/skills/<name>`. Note there is also a partial `.cursor/skills/` mirror in this repo, so "the mirror" is not only `.claude/`. Check the current state rather than trusting any list; a missing mirror is a pre-existing gap, not something to fix inside an unrelated change.

The other skills in this repo author code; this one reviews a change set. Cite them as the standard a diff is measured against, do not invoke them, and note that they must not invoke this skill either:
- `apm-integrations` — authoritative for adding/debugging instrumentation and plugins (addHook, shimmer.wrap, diagnostic channels, `bindStart`/`bindFinish`, `runStores`, `channel.hasSubscribers` gating, base plugin classes). Defer to it on whether an integration is built correctly.
- `llmobs-integration` — LLMObs plugin authoring (`LLMObsPlugin`, `setLLMObsTags`, provider tags). Defer for LLMObs correctness.
- `llmobs-testing` — LLMObs test strategy (`assertLlmObsSpanEvent`, `useLlmObs`, MOCK_* matchers, VCR cassettes at `127.0.0.1:9126`). Defer for whether LLMObs tests are shaped right.
- `serverless-integrations` — platform-boundary instrumentation owning the invocation root span (Lambda/Azure/GCP, `type = 'serverless'`, `DD_LAMBDA_HANDLER`). Defer for serverless span-model questions.
