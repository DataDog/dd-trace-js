# Step 13: final > observability

- Type: required final gate
- Objective: Prove the production observability behavior with a real reproduction or sample app.

## Instructions

Verify behavior through the real `ai` package and tracer; unit tests alone cannot
pass this gate. Use the repository's existing trace test agent, capture harness, or tracer
debug output. A local trace capture is sufficient; Datadog backend access is not required.

Choose the applicable proof:

- **Bug fix:** run a deterministic reproduction that demonstrates the original failure,
  then run it with the fix and capture the corrected behavior. Preserve before/after
  evidence when the baseline can be run.
- **New feature:** run a real application that exercises the feature and capture emitted
  spans or telemetry showing the new behavior.
- **New integration:** run `sample-app.js` against the real library and capture the spans
  produced for every intended operation.

Inspect the captured telemetry itself. Verify operation/resource/service naming, span kind,
required semantic tags, parent-child relationships, error behavior, and absence of duplicate
spans as applicable. Record the app command, tracer configuration, capture mechanism, and
observed telemetry in `PROGRESS.md`.

Missing services, images, credentials, or network access make this gate **BLOCKED**, not
passed. State the exact missing capability and preserve the reproduction command.

## Completion

Mark this gate complete in `PROGRESS.md` only with concrete evidence from the current
source state. If this gate causes any code change, clear all final-gate
checkmarks and restart at `final > build`.
