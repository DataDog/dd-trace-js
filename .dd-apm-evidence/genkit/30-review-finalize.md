# Stage 30: finalize review

Date: 2026-07-14 UTC

## ReviewResult

**Approved.** The final review reconciliation passes for the current source state. All blocking findings raised in
Stages 25 through 29 are resolved, the authenticated workflow owner's explicit approval is recorded, and no
unresolved review finding remains. This result authorizes the pipeline to enter the final build, test, lint, and
live-observability gates; it does not waive any of them.

The reviewed source is the 24-file production/test/configuration diff from original base
`372e5eb61c4c6a13662ad2f8780a87275b50314d`. Its canonical diff SHA-256, excluding pipeline and evidence files, is:

```text
7ae72584fa94013b2e3db0f5bc465064a81aa77560d4978261b6a54559bf3abd
```

## Finding reconciliation

| Source | Finding | Final state |
| --- | --- | --- |
| Stage 25 | `GENKIT-BATCH-001` model/embedder identity | Resolved: registered action identity is retained. |
| Stage 25 | `GENKIT-BATCH-002` provider ownership | Resolved: source-proven `googleai/` actions demote only when `google-genai` LLMObs owns the request; duplicate Genkit token metrics are omitted. |
| Stage 25 | `GENKIT-BATCH-003` native OTel duplication/privacy | Resolved: only the exact `genkit-tracer` scope becomes non-recording; raw native input/output/vector attributes are not exported. |
| Stage 27 | unrelated user OTel child | Covered: it remains recordable and is parented to the authoritative Genkit span. |
| Stage 27 | shared context-manager contract | Covered directly for marked/stored, marked/no-stored, and unmarked controls, plus exact scope-match/mismatch behavior. |
| Stage 27 | unowned `googleai/` identity | Covered: it remains `llm` with provider/model identity and Genkit token metrics. |
| Stage 29 | `GENKIT-HUMAN-001` ambient marker lifetime | Resolved test-first: preservation state is stored only on the operation-scoped copied store and does not mutate the ambient user span. |

The Stage 25 todo list exactly matches Stage 26's fixed list, with no failed or skipped todo. Every Stage 27 missing
case appears in Stage 28's added-case list. Stage 29's only automated finding matches the resolved Stage 29 fix.

## Human approval

The authenticated workflow owner, William Conti, explicitly replied `continue, approved` after the repaired Stage
29 handoff. The approval is preserved in `29-human-approval.md`; it applies to the source state whose Stage 29
hashes still match the current files. The approval does not waive final validation.

## Final contract inspection

- Exact `@genkit-ai/core@1.21.0` CJS and MJS implementations are targeted with Orchestrion `Async` rewrites of
  named `runInNewSpan`.
- The composite member order is LLMObs then tracing, while tracing's store binding creates the APM span before the
  LLMObs start subscriber registers it.
- The strict native-label allowlist produces `llm`, `workflow`, `tool`, `retrieval`, and `embedding`; no unsupported
  `agent` kind is invented.
- Messages, tools, documents, token metrics, scalar metadata, errors, streaming completion, overloads, and parent
  relationships are pinned by exact-version tests.
- Embedding vectors are summarized, arbitrary document metadata and unsafe parts are excluded, and native Genkit
  OTel payload/vector attributes are suppressed without suppressing unrelated user OTel instrumentation.
- Fixture, runtime registry, config, type, documentation, workflow, and plugin-structure registrations are present
  and remain restricted to the source-proven exact version.

## Reproducible validation

Commands were run from `/workspace/repo`, with the sandbox's telemetry exporters and empty agent host removed.

Default exact-version Genkit APM and LLMObs:

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha --timeout 20000 \
  packages/datadog-plugin-genkit/test/index.spec.js \
  packages/datadog-plugin-genkit/test/llmobs.spec.js
```

Result: `23 passing (1s)`, exit 0.

OTel-enabled exact-version Genkit APM and LLMObs:

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  DD_TRACE_OTEL_ENABLED=true ./node_modules/.bin/mocha --timeout 20000 \
  packages/datadog-plugin-genkit/test/index.spec.js \
  packages/datadog-plugin-genkit/test/llmobs.spec.js
```

Result: `23 passing (1s)`, exit 0.

Shared OTel bridge:

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha \
  packages/dd-trace/test/opentelemetry/context_manager.spec.js \
  packages/dd-trace/test/opentelemetry/tracer.spec.js
```

Result: `49 passing (141ms)`, exit 0.

Plugin structure:

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha packages/dd-trace/test/plugins/plugin-structure.spec.js
```

Result: `171 passing (46ms)`, exit 0.

All 12 changed/new JavaScript source and test files passed `node --check`. The original-base-scoped diff check
passed with no output. Static assertions confirmed two exact-version hook files, composite order, fixture versions,
five LLMObs kinds, and supported configuration registration.

## Remaining obligations and limitations

There is no remaining review blocker. Stages 31–34 still must validate build, tests, lint, and the instrumented real
`genkit@1.21.0` sample's stored APM and LLMObs output on one unchanged source state. Compatibility remains exactly
`1.21.0`; a broader range requires new source/runtime evidence. The unrelated registry-dependent
`verify-ci-config` E404 recorded in Stage 23 remains a final-lint reporting obligation, not a Genkit review defect.

No production file, test file, or `PROGRESS.md` was modified by Stage 30.
