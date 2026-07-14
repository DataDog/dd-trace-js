# Stage 06: independent instrumentation review

Date: 2026-07-13 UTC

## Outcome

Decision: **change**. The five Stage 04 operation classes and their shared `runInNewSpan` hook are feasible, and no
additional agent, prompt, or streaming-container target should be added. However, Stage 04's native Genkit I/O
shapes cannot be passed directly to the current LLMObs tagger, raw embedding vectors must not be captured, and the
hook's schema-validation coverage was overstated. The required overrides are recorded in
`06-review-decisions.json`.

The Stage 06 curses TUI was **not run**. This environment is headless and noninteractive, and the stage guidance
explicitly says the TUI is automatically skipped in headless/remote mode. This report and the JSON decisions
artifact reproduce the review outcome without claiming that unavailable capability passed.

## Scope reviewed

The review covered all five Stage 04 targets and every Stage 05 enrichment against the exact installed
`genkit@1.21.0`, `@genkit-ai/ai@1.21.0`, and `@genkit-ai/core@1.21.0` source and runtime artifacts:

1. model/generation (`llm`)
2. flow and named step (`workflow`)
3. tool execution (`tool`)
4. retrieval (`retrieval`)
5. embedding (`embedding`)

It also reviewed the dd-trace Orchestrion and `LLMObsPlugin` lifecycle, tagger input contracts, streaming
completion, native OpenTelemetry interaction, provider-plugin duplication, privacy, errors, and hook reachability.

## Findings

### GENKIT-REVIEW-001 — high — native I/O needs explicit conversion

Stage 04 correctly called for message conversion in prose, but its target fields still point directly at
`metadata.input.messages`, `ctx.result.message`, `metadata.input.input`, and `ctx.result.documents`. Those values are
not tagger-ready:

- Genkit messages use `content: Part[]`; `LLMObsTagger.tagLLMIO` accepts string `content`.
- Genkit tool parts use `toolRequest`/`toolResponse`; the tagger accepts `toolCalls`/`toolResults` with normalized
  fields.
- Genkit `DocumentData` uses `content: Part[]`; embedding/retrieval tagger documents require `text: string`.

Decision: change model, retrieval, and embedding extraction. Flatten reviewed text parts, map `model` to
`assistant`, normalize tool calls/results, and convert documents to `{ text, ...reviewed scalar fields }`. Do not
copy arbitrary part or document metadata.

### GENKIT-REVIEW-002 — high — never serialize embedding vectors

Stage 04 says to use `ctx.result.embeddings` as LLMObs embedding output and defer to tagger size/redaction. The
tagger's embedding output is a generic text value and JSON-stringifies non-strings; it does not summarize numeric
vectors. Genkit returns `{ embeddings: [{ embedding: number[], metadata? }] }`, so direct tagging would serialize
large vectors and possibly arbitrary metadata.

Decision: change. Follow existing dd-trace embedding integrations and emit only a count/dimension summary such as
`[2 embedding(s) returned with size 768]`. Never emit the vectors themselves.

### GENKIT-REVIEW-003 — medium — schema-validation failures are outside the hook

Stage 04 says `actionFn.run` validates input and output within the selected lifecycle. Exact source shows input
`parseSchema` runs before `runInNewSpan`, while output `parseSchema` runs after it returns. Consequently:

- invalid input produces no selected operation span;
- invalid output can leave the selected span marked successful before the public action rejects.

The hook still covers the user/provider runner, its asynchronous work, runner errors, and the mutable input/output
metadata. Its breadth and stable named-function shape make it preferable to wrapping every runtime-created action,
but implementation and tests must state this limitation instead of claiming full public-operation error coverage.

Decision: accept the hook with this correction and add boundary tests. Do not bend production code solely to make
schema-validation failures traceable.

### GENKIT-REVIEW-004 — high — duplicate LLM/APM spans remain a final-gate blocker

`runInNewSpan` creates a native OpenTelemetry span inside the proposed Datadog span. A supported provider SDK may
also create its own authoritative LLMObs span. Therefore two independent duplication risks remain:

- near-duplicate Genkit Datadog and native OTel APM spans when the OTel bridge/provider is active;
- a Genkit `llm` span plus a provider SDK `llm` span, duplicating token/cost accounting.

Decision: retain the Genkit model span as `llm` for custom/otherwise-uninstrumented models, but follow the existing
LangChain precedent and demote it to `workflow` when a known enabled provider LLMObs integration owns the underlying
request. The real `genkit@1.21.0` sample must prove the exact parent chain and absence of double-counted LLM metrics.
This review cannot resolve that runtime-only gate.

### GENKIT-REVIEW-005 — medium — constrain hook compatibility

Stage 05 correctly identifies `@genkit-ai/core`, the named async function, and normal Node reachability through
`lib/tracing/instrumentation.js`. It also correctly notes that the package's ESM public tracing entry re-exports the
`.js` implementation; the standalone `.mjs` implementation exists but is not normally reached through the export
map.

The selected function is hidden, and one overload is deprecated. It is source-proven at exactly 1.21.0, not across
an open-ended semver range. Decision: register against `@genkit-ai/core`, support the `.js` runtime path, retain the
`.mjs` entry for nonstandard resolver/bundler coverage, and use an exact or narrowly proven version range.

### GENKIT-REVIEW-006 — medium — tool interrupts need executable evidence

Tool execution is correctly covered by action subtype `tool`, including model-selected calls. Genkit implements an
interrupt as control-flow that is caught above the tool action. Whether the action span should remain an error or be
represented as interrupted success cannot be decided from the target list alone.

Decision: accept the target, but require a 1.21.0 interrupt fixture before finalizing its error semantics.

## Target decisions

| Stage 04 target | Decision | Review result |
| --- | --- | --- |
| model | Change | Keep `llm`; normalize messages/tools, restrict metadata, and conditionally demote for a supported provider integration. |
| flow / flowStep | Accept with constraints | `workflow` is correct; the exact step label is `genkit:type=flowStep`; prove nesting and keep raw I/O out of ordinary APM tags. |
| tool | Accept with constraints | `tool` and the shared action boundary are correct; pin interrupt behavior. |
| retriever | Change | Keep `retrieval`; convert Genkit documents to tagger documents instead of passing them directly. |
| embedder | Change | Keep `embedding`; convert input documents and summarize vector output. |

Rejected additions remain rejected: `agent`, public generate/stream/prompt/chat veneers, registration factories,
`generateHelper`, and unrelated `runInNewSpan` labels. There is no explicit agent lifecycle in 1.21.0, and wrapping
the synchronous streaming container would finish before generation. The selected async model action resolves only
after provider chunk production and final response completion; it intentionally does not measure delayed consumer
drain time.

## Privacy and metadata rules

- LLMObs I/O capture must remain subject to the repository's configured content capture, truncation, and redaction.
- Ordinary APM tags may include operation/action identifiers and safe scalar metadata, but not prompts, flow/tool
  payloads, retrieved document bodies, media/data URLs, custom parts, raw provider responses, or vectors.
- Model configuration metadata must use an explicit scalar allowlist. Never copy provider `raw`, arbitrary `custom`,
  action context, or arbitrary document/message metadata.
- Provider and model values may be derived from a registered action name only when its convention is proven. Leave
  unknown values undefined rather than guessing.
- Tag the three standard token counts when numeric and present. Additional Genkit usage fields require a reviewed
  backend mapping; do not relabel them speculatively.

## Validation and reproduction

Commands run from `/workspace/repo`:

```sh
node -e "const fs=require('node:fs'); for (const name of ['genkit','@genkit-ai/ai','@genkit-ai/core']) { const pkg=JSON.parse(fs.readFileSync('/tmp/dd-apm-genkit-1.21.0/node_modules/'+name+'/package.json')); console.log(pkg.name+'@'+pkg.version) }"
rg -n "SPAN_TYPE_ATTR|actionType: 'model'|actionType: 'tool'|actionType: 'retriever'|actionType: 'embedder'" /tmp/dd-apm-genkit-1.21.0/node_modules/@genkit-ai/{core,ai}/src
sed -n '298,389p' /tmp/dd-apm-genkit-1.21.0/node_modules/@genkit-ai/core/src/action.ts
sed -n '60,153p' /tmp/dd-apm-genkit-1.21.0/node_modules/@genkit-ai/core/src/tracing/instrumentation.ts
sed -n '497,680p' packages/dd-trace/src/llmobs/tagger.js
node -e "const x=JSON.parse(require('node:fs').readFileSync('.dd-apm-evidence/genkit/06-review-decisions.json')); if (x.target_decisions.length !== 5 || x.review_mode.tui_executed !== false) process.exit(1); console.log('review decisions valid')"
```

Validation result:

```text
genkit@1.21.0
@genkit-ai/ai@1.21.0
@genkit-ai/core@1.21.0
review decisions valid
target decisions: 5
TUI executed: false
production code modified: no
PROGRESS.md modified by this reviewer: no
```

## Unresolved blockers

1. The curses TUI is unavailable in this headless environment and is not marked passed.
2. Native OTel/provider duplicate spans, parent-child ordering, and token double counting require the real sample
   application's captured APM and LLMObs output.
3. Tool interrupt completion semantics require an executable 1.21.0 fixture.
4. Any supported range beyond exact 1.21.0 requires cross-version source and runtime evidence.

These are explicit downstream validation obligations. No unit-test or self-reported result can waive the real-app
observability gate.
