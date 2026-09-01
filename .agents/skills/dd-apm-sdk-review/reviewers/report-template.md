# Consolidated report format and verdict table

Used by the orchestrator (`SKILL.md`, Step 3) to shape the final report. Language-agnostic — identical across every repo that adopts this skill.

## Verdict table

| verdict | condition | gate effect |
|---|---|---|
| `BLOCK` | ≥1 P0 finding | `DO NOT PUSH` |
| `APPROVE_WITH_COMMENTS` | P1 and/or P2 only | push allowed **after the human sees the findings**; fixes preferred, and only the human may dismiss them |
| `APPROVE` | nothing to raise | push allowed |

A reviewer that could not do its job reports `NOT VERIFIED (<reason>)` for its area. `NOT VERIFIED` never blocks.

## Report format

```
# dd-apm-sdk-review: <repo name>

Verdict: BLOCK | APPROVE_WITH_COMMENTS | APPROVE
Target: <branch>...<base>   Files: <n>   Mode: parallel | sequential | DEGRADED | pasted diff, no git

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

---
## Rule files used
- coherence: reviewers/coherence.md
- correctness: reviewers/correctness.md
- security: reviewers/security.md + .agents/dd-apm-sdk-review-overrides/reviewers/security.md
- design: reviewers/design.md (no override for this repo)
- performance: reviewers/performance.md + .agents/dd-apm-sdk-review-overrides/reviewers/performance.md
- maintainability: reviewers/maintainability.md (no override for this repo)
- conventions: reviewers/conventions.md (no override for this repo)
- cross-sdk: reviewers/cross-sdk.md

## Related skills in this repo
- <from `.agents/dd-apm-sdk-review-overrides/repo-context.md`, Step 0 - the other skills this repo has and how they relate to this review; omit this section if that file has none>

## Checked and fine
- [performance] no new allocations on the span-start path
- ...

## Coverage gaps
- <changed files with no test changes; missing release note; etc.>
```

The section below the `---` is bookkeeping for debugging the review itself — keep it after the findings, never before them.

Then state plainly: `READY TO PUSH` or `DO NOT PUSH`.
