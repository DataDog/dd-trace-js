# Stage 07: merged analysis validation and provenance

Date: 2026-07-13 UTC

## Result

The pre-sample-app analysis contract is `07-merged-analysis.json`. It deterministically merges:

1. `04-target-selection.json` — five selected operation classes and the shared hook decision.
2. `05-enrichments.json` — exact defining package, source/runtime paths, lines, export type, and hook registration.
3. `06-review-decisions.json` — all target changes, constraints, rejections, findings, and unresolved blockers.

No context-mapping artifact exists yet. The merged contract records `context_mapping.status` as
`not_available_yet`, a `null` source layer, zero mappings, and zero context-mapping count. This is the intended first
Stage 07 pass before sample-app context capture; it is not marked complete or inferred from static analysis.

## Override application

Stage 05 hook metadata replaces Stage 04 package-prefixed paths. Every merged target now uses:

```text
module: @genkit-ai/core@1.21.0
CJS:    lib/tracing/instrumentation.js:41
ESM:    lib/tracing/instrumentation.mjs:14
query:  named async runInNewSpan / Orchestrion Async
```

Stage 06 review decisions replace Stage 04's direct tagger mappings. No merged target retains the old `span_tags`
object. Ordinary APM metadata is restricted to component, operation type, and action name; payload tags are
explicitly disallowed. The final LLMObs extraction contracts now require:

- model parts normalized to string content, `model` mapped to `assistant`, tool calls/results normalized, unsafe
  parts excluded, numeric token metrics only, and provider-owned requests demoted to `workflow`;
- bounded/redacted workflow and tool text I/O with no ordinary APM payload tags;
- retrieval documents converted to tagger-valid `{ text, name?, id?, score? }` objects;
- embedding inputs converted to `{ text, name?, id? }`, with vectors replaced by a bounded count/dimension summary.

The merge carries all 20 per-target `required_changes` entries verbatim alongside these concrete replacement
contracts. It also preserves all four rejected-target decisions, six findings, five hook constraints, and four
unresolved blockers. In particular, native OTel/provider duplication, tool-interrupt semantics, and any broader
version range remain unresolved downstream gates.

## Reproducible merge

`07-merge-analysis.js` reads the three source JSON layers and prints the canonical merged JSON. It fails on:

- package/version disagreement;
- failed enrichment or non-empty missing targets;
- any target missing from enrichment, review, or the explicit override table;
- target-count disagreement;
- loss of CJS or ESM paths;
- loss or alteration of a target's Stage 06 `required_changes` list;
- retained Stage 04 `span_tags`;
- missing model demotion/role mapping, retrieval document conversion, or embedding vector summarization;
- loss of findings, rejected targets, blockers, or the explicit absent-context state.

Reproduce and validate from `/workspace/repo`:

```sh
node .dd-apm-evidence/genkit/07-merge-analysis.js > /tmp/genkit-07-merged-analysis.json
cmp /tmp/genkit-07-merged-analysis.json .dd-apm-evidence/genkit/07-merged-analysis.json
node .dd-apm-evidence/genkit/07-merge-analysis.js --check
node -e "const x=JSON.parse(require('node:fs').readFileSync('.dd-apm-evidence/genkit/07-merged-analysis.json')); console.log(x.validation)"
sha256sum .dd-apm-evidence/genkit/04-target-selection.json .dd-apm-evidence/genkit/05-enrichments.json .dd-apm-evidence/genkit/06-review-decisions.json
```

The source hashes are embedded under `provenance.source_sha256`, so any changed source layer makes `--check` fail
until this pre-sample merge is intentionally regenerated and reviewed.

## Validation output

```json
{
  "base_target_count": 5,
  "enriched_target_count": 5,
  "review_target_count": 5,
  "merged_target_count": 5,
  "missing_targets": [],
  "context_mapping_count": 0,
  "all_review_overrides_applied": true,
  "superseded_span_tags_removed": true
}
```

Production code and `.dd-apm-pipeline/PROGRESS.md` were not modified by this stage worker.
