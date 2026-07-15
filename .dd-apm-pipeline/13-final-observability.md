# Step 13: final > observability

- Type: required final gate

## Instructions

Run a minimal sample app against the exact latest `ai` and provider versions selected in `TASK.md`.
Exercise at least non-streaming generation, streaming generation, embeddings, and one tool call. Store
captured APM and LLMObs trace JSON, then inspect operation names, model/provider tags, token metrics,
input/output capture, parent-child hierarchy, streaming finalization, error behavior, and duplicate spans.
Unit tests or self-reported success alone do not pass this gate; missing infrastructure makes it BLOCKED.

This gate is verification-only: do not edit product code here. Record exact commands,
exit status, source revision, and artifact paths in a bounded `evidence/13/summary.md`.
Keep raw output in `evidence/13/raw/`. All final gates must validate the same source
state; after any code change, clear their checkmarks and restart at `final > build`.
