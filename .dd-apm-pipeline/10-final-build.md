# Step 10: final > build

- Type: required final gate
- Objective: Prove the changed tracer code builds from the current source state.

## Instructions

Run the repository's canonical build or compile command for the changed integration and
every generated artifact it owns. The primary integration path is `packages/datadog-plugin-ai/`.

Pass only when the build exits zero with no compile, type, or generated-code errors.
Record the exact command, exit status, relevant output, `git rev-parse HEAD`, and
`git status --short` in `PROGRESS.md`.

## Completion

Mark this gate complete in `PROGRESS.md` only with concrete evidence from the current
source state. If this gate causes any code change, clear all final-gate
checkmarks and restart at `final > build`.
