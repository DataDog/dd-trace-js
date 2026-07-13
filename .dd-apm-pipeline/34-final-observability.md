# Step 34: final > live LLMObs observability

- Type: required final gate
- Objective: Prove the production observability behavior with a real reproduction or sample app.

## Instructions

Verify behavior through a real application using `genkit@1.21.0` and the built
tracer; unit tests alone cannot pass this gate. Use the repository's existing
trace test agent, LLMObs writer stub, capture harness, or tracer debug output. A
local trace capture is sufficient; Datadog backend access is not required.

Choose the applicable proof:

- **Bug fix:** run a deterministic reproduction that demonstrates the original failure,
  then run it with the fix and capture the corrected behavior. Preserve before/after
  evidence when the baseline can be run.
- **New feature:** run a real application that exercises the feature and capture emitted
  spans or telemetry showing the new behavior.
- **New integration:** run `sample-app.js` against `genkit@1.21.0` and capture the
  APM and LLMObs spans produced for every intended operation.

Inspect the captured telemetry itself. Ordinary APM spans alone do not pass this
gate. Verify the applicable LLMObs span kinds (`llm`, `workflow`, `tool`,
`retrieval`, or `embedding`), names, model/provider metadata, input/output
messages, token metrics when Genkit exposes them, parent-child relationships,
stream completion, error behavior, and absence of duplicate spans. Record the
app command, resolved Genkit version, tracer configuration, capture mechanism,
and observed telemetry in `PROGRESS.md`.

Missing services, images, credentials, or network access make this gate **BLOCKED**, not
passed. State the exact missing capability and preserve the reproduction command.

## Completion

Mark this gate complete in `PROGRESS.md` only with concrete evidence from the current
source state. If this gate causes any code change, clear all final-gate
checkmarks and restart at `final > build`.
