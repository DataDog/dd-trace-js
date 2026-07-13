# Agent Execution Contract

Implement a new Node.js integration for **Google Genkit** using npm package
`genkit@1.21.0`, then add first-class Datadog LLM Observability support.

## Target Contract

- Repository: `dd-trace-js`
- Package: `genkit`
- Version: exactly `1.21.0` for discovery, sample-app, and validation work
- Outcome: useful LLMObs spans for Genkit's real AI application operations, not
  merely forwarding generic OpenTelemetry spans to Datadog APM
- Scope: discover the actual `1.21.0` API before selecting hooks; evaluate model
  generation and streaming, flows/workflows, tools, prompts, retrieval, and
  embeddings where the package exposes them
- Architecture: reuse Genkit's OTel or custom instrumentation surfaces when they
  provide stable context, but implement the result using established
  `dd-trace-js` instrumentation and LLMObs plugin conventions
- Compatibility: do not silently analyze or test only the current Genkit release

## Execution Rules

1. Read `PIPELINE.md` for the ordered stage list.
2. Read only the current numbered stage file; load repository skills and other
   references on demand.
3. Complete stages in order. Use focused subagents when the harness supports
   them, especially for package discovery, implementation, tests, and review.
4. After each stage, record concrete evidence in `PROGRESS.md` before continuing.
5. After compaction or handoff, resume from `PROGRESS.md` and the first incomplete
   stage. Re-read this contract before continuing.
6. Split long-running shell work into commands that fit the harness execution
   limit.
7. Do not open a PR with failed validation, unreviewed changes, or unresolved
   blockers.
8. Never commit this generated pipeline directory to the target repository.
9. Final gates apply to one source state. Any code change during gating
   invalidates all final-gate evidence.

Repository instructions and the user's latest request remain authoritative.
