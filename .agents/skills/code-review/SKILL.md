---
name: code-review
description: |
  Review a PR or code change against dd-trace-js codebase standards. Use this skill whenever
  someone asks to "review" code or a PR, types "/review", asks "can you check this before I
  submit", wants to identify issues in a change, asks for a code review, says "PTAL", or
  mentions a PR number and wants quality feedback. Also use proactively when someone is about
  to open a PR and wants a pre-submission check. The input can be a PR number, a file path,
  a diff pasted inline, or a description of the change.
allowed-tools: Read, Grep, Glob, Bash, WebFetch
---

# Code Review

You are performing a thorough code review of a dd-trace-js change. Work through
[references/review-checklist.md](references/review-checklist.md) category by category, flag
every issue you find, and always pair a finding with a concrete fix suggestion.

## Getting the change

`$ARGUMENTS` — a PR number, file path, diff, or description of the change to review.

**If a PR number is given**, prefer the GitHub CLI — it handles auth and gives the full diff:

```bash
gh pr view <PR_NUMBER> --repo DataDog/dd-trace-js      # title, description, labels
gh pr diff <PR_NUMBER> --repo DataDog/dd-trace-js      # full unified diff
```

If `gh` is unavailable, fall back to WebFetch:
- `https://github.com/DataDog/dd-trace-js/pull/<PR_NUMBER>/files`

**If a file path is given**, read the file and read the surrounding context (callers, tests,
similar patterns in the codebase) before commenting.

## How to review

1. Read [references/review-checklist.md](references/review-checklist.md) before starting.
2. Work through each applicable category. For each finding, ask: what is the actual risk, and
   is there an existing pattern in the codebase the author should follow?
3. For reviewer-specific preferences (what rochdev, BridgeAR, simon-id, etc. tend to flag),
   see `.cursor/skills/reviewer-profiles.md`.

## Output format

Group findings by category. Omit any category with no findings.

```
## Architecture & Design

### [BLOCKER | CONCERN | NIT] Short title

**File:** path/to/file.js:line

**Comment:** Specific feedback explaining why this matters.

**Suggested fix:** Concrete code or approach.

---
```

Categories:
- Architecture & Design
- Performance & Memory
- Configuration System
- Async & Correctness
- Test Quality
- Code Style & Readability
- Observability & Logging
- Documentation & PR Hygiene

Severity:
- **BLOCKER** — must be fixed before merge
- **CONCERN** — worth discussing; approval may be conditional on author's response
- **NIT** — non-blocking style preference

End with a `## Summary` section giving an overall verdict:
- `LGTM` — no significant issues
- `LGTM with caveats` — concerns worth tracking, not blocking
- `CHANGES_REQUESTED` — one or more BLOCKERs present
