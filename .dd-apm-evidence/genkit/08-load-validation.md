# Stage 08: sample-app context load validation

Date: 2026-07-14 UTC

## Result

`08-sample-app-context.json` is a compact, deterministic projection of `07-merged-analysis.json` for the future
sample-app workflow. It loads all five selected targets with no missing operations:

| Operation | Expected LLMObs kind | Required real-app coverage |
| --- | --- | --- |
| generation | `llm` | non-streaming, fully consumed streaming, runner error, and model-tool-model loop |
| workflow | `workflow` | flow, exact `flowStep`, nesting, and runner error |
| tool | `tool` | model-selected call, runner error, and unresolved interrupt fixture |
| retrieval | `retrieval` | normalized-document success and runner error |
| embedding | `embedding` | multi-document/dimension summary success and runner error |

The context contains 14 required runtime cases plus explicit APM, LLMObs, streaming, privacy, duplication, version,
module-format, nesting, and error evidence fields. The completion gate remains `pending_real_sample`; neither unit
tests nor ordinary APM spans without LLMObs spans can satisfy it.

## Context-mapping status

No runtime context mapping exists yet. The artifact records:

```json
{
  "status": "not_captured",
  "source": null,
  "mappings": []
}
```

The listed `requested_capture_fields` are future evidence requirements for `ctx.arguments`, labels, mutable metadata,
result/error, current span, and parent span. They are not claimed as observed mappings.

## Version and module constraints

- Sample target: exactly `genkit@1.21.0`.
- Hook target: exactly `@genkit-ai/core@1.21.0`.
- Hook: named async `runInNewSpan` using Orchestrion `Async`.
- CommonJS runtime path: `lib/tracing/instrumentation.js:41`.
- Public ESM imports at this version also execute the `.js` implementation.
- `lib/tracing/instrumentation.mjs:14` remains an instrumentation entry but is not directly package-exported; the
  sample must not claim ordinary Node reachability for it.
- Hook registration must name `@genkit-ai/core`, occur before Genkit loads, and must not claim a wider semver range.

## Expected trace evidence

The main nested trace must prove flow → flow-step → first model turn → selected tool → follow-up model turn, with
retrieval and embedding recorded as children of the enclosing flow or step. Every relationship must be established
from captured `trace_id`, `span_id`, and `parent_id`, not log order alone.

Streaming evidence must include ordered bounded chunks, chunk count, final response await, completion/error time,
and proof that the model span finishes on final provider completion rather than synchronous container return. The
contract explicitly excludes delayed/abandoned consumer-drain duration from provider latency.

Error evidence is required for every selected operation. Input/output schema-validation failures remain outside the
hook and must be reported as such. Tool-interrupt semantics, native OTel/provider duplication, token ownership, and
any broader version range remain carried blockers rather than assumed outcomes.

## Reproducible load and validation

Run from `/workspace/repo`:

```sh
node .dd-apm-evidence/genkit/08-load-analysis.js > /tmp/genkit-08-sample-app-context.json
cmp /tmp/genkit-08-sample-app-context.json .dd-apm-evidence/genkit/08-sample-app-context.json
node .dd-apm-evidence/genkit/08-load-analysis.js --check
node -e "const x=JSON.parse(require('node:fs').readFileSync('.dd-apm-evidence/genkit/08-sample-app-context.json')); console.log(x.validation)"
sha256sum .dd-apm-evidence/genkit/07-merged-analysis.json
```

The loader asserts exact package versions, five unique operations, CJS and ESM metadata per target, unchanged
findings/rejections/blockers, empty context mappings, and a still-pending real-sample gate. Its output embeds the
Stage 07 SHA-256 for stale-input detection.

Validation output:

```json
{
  "source_target_count": 5,
  "loaded_target_count": 5,
  "missing_targets": [],
  "operations": ["generation", "workflow", "tool", "retrieval", "embedding"],
  "context_mapping_count": 0,
  "blocker_count": 4
}
```

No sample application was created or run. Production code and `.dd-apm-pipeline/PROGRESS.md` were not modified by
this stage worker.
