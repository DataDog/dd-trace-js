# Step 12: final > lint

- Type: required final gate

## Instructions

Run canonical lint, format, and static checks for `packages/datadog-plugin-ai/`, `packages/datadog-plugin-ai/test/index.spec.js`. Any actionable diagnostic fails this gate.

This gate is verification-only: do not edit product code here. Record exact commands,
exit status, source revision, and artifact paths in a bounded `evidence/12/summary.md`.
Keep raw output in `evidence/12/raw/`. All final gates must validate the same source
state; after any code change, clear their checkmarks and restart at `final > build`.
