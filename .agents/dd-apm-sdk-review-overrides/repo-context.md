# Repo context — dd-trace-js

Read only by the orchestrator (Step 0 of `SKILL.md`), not by individual reviewers. Repo-specific; not part of the shared core. This whole `.agents/dd-apm-sdk-review-overrides/` folder is owned by this repo — edit it freely, unlike `.agents/skills/dd-apm-sdk-review/`, which is a verbatim copy of the shared core.

## Related skills in this repo

The other skills in this repo author or evaluate code; this one reviews a change set. Cite them as the standard a diff is measured against, do not invoke them, and note that they must not invoke this skill either:

- `apm-integrations` — authoritative for adding/debugging instrumentation and plugins (addHook, shimmer.wrap, diagnostic channels, `bindStart`/`bindFinish`, `runStores`, `channel.hasSubscribers` gating, base plugin classes). Defer to it on whether an integration is built correctly.
- `architecture-review` — the six-dimension rubric (drift prevention, module coupling, explicit contracts, testability at boundaries, extensibility, hot-path fitness) for shared abstractions, duplicated behavior across types, module boundaries, class hierarchies, and public APIs. Defer to it on whether a structural change is sound; the design lens's own "duplication of an existing mechanism" check is a shallower proxy for this standard, not a replacement.
- `flaky-test-fixer` — the classification process (infrastructure / deterministic / genuine flake / unknown) for a suspected flaky or unrelated test failure. Cite it as the standard before this review accepts a "flaky" or "unrelated" justification for a weakened, skipped, or dismissed test.
- `llmobs-integration` — LLMObs plugin authoring (`LLMObsPlugin`, `setLLMObsTags`, provider tags). Defer for LLMObs correctness.
- `llmobs-testing` — LLMObs test strategy (`assertLlmObsSpanEvent`, `useLlmObs`, MOCK_* matchers, VCR cassettes at `127.0.0.1:9126`). Defer for whether LLMObs tests are shaped right.
- `serverless-integrations` — platform-boundary instrumentation owning the invocation root span (Lambda/Azure/GCP, `type = 'serverless'`, `DD_LAMBDA_HANDLER`). Defer for serverless span-model questions.
