# Repo context — dd-trace-js

Read only by the orchestrator (Step 0 of `SKILL.md`), not by individual reviewers. Repo-specific; not part of the shared core. This whole `dd-apm-sdk-review-overrides/` folder is owned by this repo — edit it freely, unlike `.agents/skills/dd-apm-sdk-review/`, which is a verbatim copy of the shared core.

## Related skills in this repo

The other skills in this repo author code; this one reviews a change set. Cite them as the standard a diff is measured against, do not invoke them, and note that they must not invoke this skill either:

- `apm-integrations` — authoritative for adding/debugging instrumentation and plugins (addHook, shimmer.wrap, diagnostic channels, `bindStart`/`bindFinish`, `runStores`, `channel.hasSubscribers` gating, base plugin classes). Defer to it on whether an integration is built correctly.
- `llmobs-integration` — LLMObs plugin authoring (`LLMObsPlugin`, `setLLMObsTags`, provider tags). Defer for LLMObs correctness.
- `llmobs-testing` — LLMObs test strategy (`assertLlmObsSpanEvent`, `useLlmObs`, MOCK_* matchers, VCR cassettes at `127.0.0.1:9126`). Defer for whether LLMObs tests are shaped right.
- `serverless-integrations` — platform-boundary instrumentation owning the invocation root span (Lambda/Azure/GCP, `type = 'serverless'`, `DD_LAMBDA_HANDLER`). Defer for serverless span-model questions.
