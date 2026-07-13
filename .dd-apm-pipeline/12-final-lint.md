# Step 12: final > lint

- Type: required final gate
- Objective: Prove lint, formatting, and required static checks are clean.

## Instructions

Run the repository's canonical lint, format-check, and type-check commands for the
changed paths. Adapter lint scope: `packages/datadog-plugin-ai/`, `packages/datadog-plugin-ai/test/index.spec.js`.

Pass only when all required checks exit zero and no actionable diagnostics remain.
Record each exact command and result in `PROGRESS.md`.

## Completion

Mark this gate complete in `PROGRESS.md` only with concrete evidence from the current
source state. If this gate causes any code change, clear all final-gate
checkmarks and restart at `final > build`.
