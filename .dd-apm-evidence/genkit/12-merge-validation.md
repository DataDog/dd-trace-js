# Stage 12: final analysis and runtime-context merge

Date: 2026-07-14 UTC

## Result

Stage 12 passes. `12-final-analysis.json` deterministically merges the reviewed Stage 07 implementation contract with
the real Stage 11 context mappings. All five targets have runtime mappings, no target is missing, and the final
contract preserves the reviewed hook constraints, CJS/ESM paths, per-target required changes, rejected targets,
findings, review metadata, and blocker history.

The merge replaces the pre-sample `not_available_yet` context state with `runtime_observed`. It keeps evidence
provenance explicit:

- The two-argument overload is runtime-observed: options are `ctx.arguments[0]` and the callback is
  `ctx.arguments[1]`.
- The three-argument overload was not exercised. Its registry/options/callback indices are source-derived only.
- Implementation must select options with
  `ctx.arguments.length === 3 ? ctx.arguments[1] : ctx.arguments[0]` without describing the three-argument case as
  sample-proven.

## Runtime corrections

The final nesting contract uses trace, span, capture-parent, and selected-parent evidence from Stage 11. It does not
encode model -> tool -> model as a direct selected-span chain. The observed selected relationships are:

```text
flow -> flowStep
flowStep -> retrieval
flowStep -> embedding
flowStep -> first model turn (through an unselected generate util span)
flowStep -> tool (through the same unselected generate util span)
flowStep -> second model turn (through a recursive unselected generate util span)
```

The exact-version tool-interrupt fixture resolves `GENKIT-REVIEW-006`: the tool hook rejects with
`ToolInterruptError` and must be tagged as an error with empty output. Genkit catches that control-flow error above
the tool action; only the outer generation completes successfully with `finishReason=interrupted`. The original
review finding and blocker remain in the review/history records, while the final unresolved blocker list removes
this resolved item.

## Preserved unresolved gates

Three review blockers remain unresolved:

1. The headless environment did not run the curses review TUI.
2. Native OpenTelemetry/provider-span duplication and token ownership require the final instrumented real-app gate.
3. A supported range broader than exact `1.21.0` requires cross-version source and runtime evidence.

The Stage 11 limitation that schema-validation failures occur outside `runInNewSpan` is also retained. No Datadog
APM or LLMObs span is claimed by this merge stage.

## Reproduction

Run from `/workspace/repo`:

```sh
node .dd-apm-evidence/genkit/12-merge-analysis.js > /tmp/genkit-12-final-analysis.json
cmp /tmp/genkit-12-final-analysis.json .dd-apm-evidence/genkit/12-final-analysis.json
node .dd-apm-evidence/genkit/12-merge-analysis.js --check
node --check .dd-apm-evidence/genkit/12-merge-analysis.js
```

Validation output:

```json
{"reviewed_target_count":5,"runtime_mapping_count":5,"missing_mappings":[],"observed_operation_count":5,"all_review_overrides_preserved":true,"all_cjs_esm_paths_preserved":true,"two_argument_overload_runtime_observed":true,"three_argument_overload_runtime_observed":false,"selected_nesting_corrected":true,"interrupt_semantics_resolved":true,"unresolved_blocker_count":3}
```

The merge embeds SHA-256 hashes for `07-merged-analysis.json`, `11-context-mappings.json`, and
`11-context-snapshot.json`; `--check` fails if a source layer changes without deliberate regeneration. Production
code, sample source, and `.dd-apm-pipeline/PROGRESS.md` were not modified.
