# Step 2: plan_review

- Type: deterministic
- Execution: required
- Objective: Present the plan for engineer review.

## Context Budget

Start from `PROGRESS.md` and prior `summary.md` receipts. Do not preload raw artifacts. Keep the
handoff at or below 200 lines and 20 KB. When discovery produces a complete inventory, store it
under this bundle's `evidence/<step>/raw/` and summarize only the ranked entries needed downstream.

## Instructions

Reproduce this deterministic stage's outcome in the target repository. Inspect prior
pipeline evidence, follow repository standards, and preserve results needed later.

## Completion

Store concrete artifacts under `evidence/02/`, then update `PROGRESS.md` with
a bounded receipt containing the result, changed files, commands, and artifact paths. Keep raw
output under `evidence/02/raw/`; do not paste it into prompts or commit it. Do not advance
on failure.
