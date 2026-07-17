# Step 13: final > observability

- Type: required final gate

## Instructions

Run the in-memory LangChain/MCP reproduction from `TASK.md` with LLM Observability enabled and store captured
LLMObs spans or local trace payload JSON. Verify one logical tool call emits exactly one tool span carrying its
input/output, listTools does not repeatedly capture static tool-schema output, and out-of-process trace-context
propagation remains intact when MCP LLMObs capture is disabled or deduplicated. Unit tests or self-reported
success alone do not pass this gate; unavailable local capture infrastructure makes it BLOCKED.

This gate is verification-only: do not edit product code here. Record exact commands,
exit status, source revision, and artifact paths in a bounded `evidence/13/summary.md`.
Keep raw output in `evidence/13/raw/`. All final gates must validate the same source
state; after any code change, clear their checkmarks and restart at `final > build`.
