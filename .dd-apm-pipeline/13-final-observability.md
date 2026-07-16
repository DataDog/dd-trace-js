# Step 13: final > observability

- Type: required final gate

## Instructions

Run the local HTTP/real-`undici` reproduction from `TASK.md` against the changed tracer and store the
captured in-process spans, local test-agent payload, or trace JSON. Verify that a completed root request
does not leave a finished `undici.request` span active; independent `tracer.trace('independent-work')`
calls receive distinct trace IDs; and a request executed inside a parent scope restores that parent. Exercise
the normal completion path and each lifecycle path the change touches (including error and CONNECT when the
test environment supports them). Unit tests or self-reported success alone do not pass this gate; unavailable
local capture infrastructure makes it BLOCKED.

This gate is verification-only: do not edit product code here. Record exact commands,
exit status, source revision, and artifact paths in a bounded `evidence/13/summary.md`.
Keep raw output in `evidence/13/raw/`. All final gates must validate the same source
state; after any code change, clear their checkmarks and restart at `final > build`.
