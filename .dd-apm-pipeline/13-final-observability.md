# Step 13: final > observability

- Type: required final gate

## Instructions

Run the issue reproduction and a minimal real `ai` tool-calling sample with the tracer. Under
`node --expose-gc`, compare retained heap growth over repeated per-request tool creation against the
recorded baseline and a plugin-disabled control. Then store captured APM and LLMObs trace JSON and
verify tool names, arguments/results, hierarchy, errors, and duplicate spans. The heap result must show
that retained memory no longer scales with completed requests while tool observability remains correct.
Unit tests or self-reported success alone do not pass this gate; missing infrastructure makes it BLOCKED.

This gate is verification-only: do not edit product code here. Record exact commands,
exit status, source revision, and artifact paths in a bounded `evidence/13/summary.md`.
Keep raw output in `evidence/13/raw/`. All final gates must validate the same source
state; after any code change, clear their checkmarks and restart at `final > build`.
