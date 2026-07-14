# Progress

Update one item at a time with status and evidence. This file is the compaction
handoff. Every command and artifact must use `genkit@1.21.0` unless the evidence
explicitly compares compatibility with another version.

- [x] 01 Analyze: install package. Evidence: exact `genkit@1.21.0` installed with Yarn at
  `/tmp/dd-apm-genkit-1.21.0/node_modules/genkit`; frozen-lockfile validation and `npm list genkit --depth=0`
  passed. Commands, resolved paths, hashes, install output, warnings, and reproduction details:
  `.dd-apm-evidence/genkit/01-install-package.md`, `.dd-apm-evidence/genkit/01-resolved-package.json`,
  `.dd-apm-evidence/genkit/01-yarn-install-output.txt`.
- [x] 02 Analyze: inventory methods. Evidence: analyzed all 19 public `genkit@1.21.0` entry points with 0
  TypeScript diagnostics and 0 runtime load failures: 473 export occurrences (268 unique), 89 callable value
  exports, and 153 directly declared methods. Reproduction output matched apart from its generation timestamp.
  Summary, analyzer, complete JSON/TSV inventories, operation surfaces, and documented upstream mismatch:
  `.dd-apm-evidence/genkit/02-inventory-summary.md`, `.dd-apm-evidence/genkit/02-inventory-exports.js`,
  `.dd-apm-evidence/genkit/02-export-inventory.json`, `.dd-apm-evidence/genkit/02-export-inventory.tsv`,
  `.dd-apm-evidence/genkit/02-export-inventory-members.tsv`.
- [x] 03 Analyze: collect documentation. Evidence: copied and byte-validated the exact `genkit@1.21.0` tarball
  README and four bundled guides; captured installed/registry provenance and extracted 101 JSDoc blocks from 23
  bundled TypeScript sources. The registry README divergence and unavailable GitHub tag lookup are explicitly
  documented; current website docs were not substituted. Summary, commands, hashes, metadata, source-doc analyzer,
  and authoritative documents: `.dd-apm-evidence/genkit/03-docs-collection.md` and
  `.dd-apm-evidence/genkit/03-*`.
- [x] 04 Analyze: select instrumentation. Evidence: classified APM as generative-AI + orchestration and LLMObs as
  `ORCHESTRATION`; selected the exact `@genkit-ai/core@1.21.0` CJS/ESM `runInNewSpan` async lifecycle with a strict
  label allowlist for `llm`, `workflow`, `tool`, `retrieval`, and `embedding`. Verified both runtime hook locations
  and all relevant package versions. Structured targets, skipped surfaces, source call paths, streaming semantics,
  metadata candidates, Orchestrion feasibility, duplicate-span risk, limitations, and commands:
  `.dd-apm-evidence/genkit/04-target-selection.json`,
  `.dd-apm-evidence/genkit/04-instrumentation-decision.md`.
- [x] 05 Analyze: enrich metadata. Evidence: enriched 5/5 targets with zero missing against
  `@genkit-ai/core@1.21.0`; confirmed named async `runInNewSpan` at source TS line 79, CJS line 41, and ESM
  counterpart line 14. Recorded that normal `require` and `import` both execute the `.js` implementation, while the
  `.mjs` counterpart remains for dual-build/bundler coverage, and that hook registration must target
  `@genkit-ai/core`. Structured enrichment and validation commands:
  `.dd-apm-evidence/genkit/05-enrichments.json`,
  `.dd-apm-evidence/genkit/05-enrichment-validation.md`.
- [x] 06 Review analysis. Evidence: headless review completed with overall decision `change`; the curses TUI was
  unavailable and explicitly not run. The shared hook and five kinds remain selected, with mandatory overrides for
  message/document normalization, embedding-vector summarization, schema-validation limitations, exact/narrow
  compatibility, provider-span demotion, and tool-interrupt tests. Native OTel/provider duplication remains a live
  final-gate blocker. Machine-readable decisions and independent findings:
  `.dd-apm-evidence/genkit/06-review-decisions.json`,
  `.dd-apm-evidence/genkit/06-review-report.md`.
- [x] 07 Merge analysis layers. Evidence: deterministic pre-sample merge reproduced byte-for-byte with 5/5/5
  targets, both runtime paths, all 20 required target changes, 6 findings, 4 rejections, and 4 unresolved blockers.
  Superseded direct `span_tags` were removed and context mapping is explicitly `not_available_yet` with zero
  inferred mappings. Merged contract, merge script, provenance hashes, and validation:
  `.dd-apm-evidence/genkit/07-merged-analysis.json`,
  `.dd-apm-evidence/genkit/07-merge-analysis.js`,
  `.dd-apm-evidence/genkit/07-merge-validation.md`.
- [x] 08 Load analysis. Evidence: deterministically loaded all 5 targets into a 14-case real-sample contract with
  exact version/module constraints, required APM and LLMObs evidence fields, expected
  flow→flowStep→model→tool→model nesting, retrieval/embedding children, streaming/error/privacy obligations, and
  all 4 blockers. Runtime context remains explicitly `not_captured` with zero mappings and the final sample gate is
  still pending. Context, loader, stale-input assertions, and validation:
  `.dd-apm-evidence/genkit/08-sample-app-context.json`,
  `.dd-apm-evidence/genkit/08-load-analysis.js`,
  `.dd-apm-evidence/genkit/08-load-validation.md`.
- [x] 09 Generate real Genkit sample app. Evidence: exact-version offline sample created and run with Yarn lock
  provenance for `genkit`, `@genkit-ai/core`, and `@genkit-ai/ai` 1.21.0; no services or credentials required.
  Fourteen cases completed with 0 unexpected errors across CJS and public ESM, including two-chunk streaming with
  final response awaited, flow/flowStep nesting, model→tool→model, retrieval, 2×3 embeddings, runner errors, and a
  successful `finishReason=interrupted` tool fixture. Hook-context capture was unavailable (0 captured) because no
  capture tool/command exists yet; the observability gate was not evaluated. Source, lockfile, commands, logs,
  structured results, lint/syntax output, and blocker: `.dd-apm-evidence/genkit/09-sample-app/`,
  `.dd-apm-evidence/genkit/09-stage-result.json`.
- [x] 10 Validate sample app. Evidence: independent clean-environment validation passed with exact
  `genkit`, `@genkit-ai/core`, and `@genkit-ai/ai` 1.21.0, 14 operations, zero unexpected errors, CJS and public
  ESM execution, ordered/complete streaming, model→tool→model, interrupt, retrieval, embeddings, and all expected
  errors. The network guard observed zero attempts and no Docker/CI services are required. The sample README's
  lint cwd discrepancy was corrected; the exact documented repository-root command was independently rerun and
  exited 0. Validation, commands, fresh results, network guard, assertions, and service configuration:
  `.dd-apm-evidence/genkit/10-validation.json`, `.dd-apm-evidence/genkit/10-command-output.md`, and
  `.dd-apm-evidence/genkit/10-*`.
- [x] 11 Map runtime context to semantic tags. Evidence: a stage-local preload captured the unchanged exact-version
  sample's real `@genkit-ai/core` `runInNewSpan` runtime context: 28 total calls and 21 selected calls, with
  success/error coverage for generation (7), workflow/flowStep (4), tool (4), retrieval (3), and embedding (3).
  Mappings pin observed argument, label, mutable metadata, result/error, token, document, and nesting paths; vectors
  were replaced by dimensions and secrets/raw data were sanitized. Native IDs prove flow→flowStep with retrieval,
  embedding, and model/tool/model descendants, while correcting that model/tool/model are separated by internal
  `generate` spans rather than forming a direct selected-span chain. The tool action rejects with
  `ToolInterruptError` while outer generation succeeds as interrupted. Capture harness, sanitized snapshot,
  mappings, sample output, validation, commands, and limitations: `.dd-apm-evidence/genkit/11-context-mapping.md`
  and `.dd-apm-evidence/genkit/11-*`.
- [x] 12 Merge implementation layers. Evidence: deterministic merge produced a runtime-observed implementation
  contract with 5/5 mappings, no missing targets, all CJS/ESM paths and review overrides preserved, corrected
  selected-span nesting, and resolved tool-interrupt semantics. The two-argument overload is runtime-proven while
  the three-argument overload remains source-derived only. Three blockers remain: unavailable headless TUI,
  native OTel/provider duplication and token ownership pending the instrumented real-app gate, and any range wider
  than exact 1.21.0 pending cross-version evidence. Final analysis, merge script, provenance hashes, and validation:
  `.dd-apm-evidence/genkit/12-final-analysis.json`, `.dd-apm-evidence/genkit/12-merge-analysis.js`, and
  `.dd-apm-evidence/genkit/12-merge-validation.md`.
- [x] 13 Compile tracing integration. Evidence: created the APM-only Genkit scaffold with exact
  `@genkit-ai/core@1.21.0` CJS/ESM Orchestrion entries, instrumentation loader and registries, strict operation
  allowlist, safe APM tags, plugin/config/type/docs/CI/version registrations, and a five-family real-package test
  scaffold. Syntax, targeted lint, config-type generation, exact-source transformations, CI-job structure, and 171
  plugin-structure tests pass; `PLUGINS=genkit yarn services` installed exact fixtures. Focused tests remain red at
  0 passing/5 timeouts because dependency-file loading does not instantiate the plugin or create channel
  subscribers; this unweakened failure is handed to Stage 14. Full CI verification is blocked by an unrelated
  registry 404 and global typecheck by existing TypeScript 6 config diagnostics. Commands, source hashes, changed
  files, outputs, and blockers: `.dd-apm-evidence/genkit/13-compile.md` and
  `.dd-apm-evidence/genkit/13-changed-files.json`.
- [x] 14 Diagnose tracing tests. Evidence: reproduced 0 passing/5 timeouts with all OTEL exporters unset and
  classified the failure as `channels`. The plugin subscribed to bare
  `orchestrion:@genkit-ai/core:runInNewSpan:*`, while `tracingChannel` emits
  `tracing:orchestrion:@genkit-ai/core:runInNewSpan:*`; runtime probes observed lifecycle events only on the latter,
  and an evidence-only prefix correction made the unchanged suite 5 passing. Separately, this sandbox exports
  `DD_AGENT_HOST=''`, which causes `ERR_INVALID_URL` before plugin-manager configuration and must be unset for
  focused tests. Orchestrion config, hook loading, plugin registry, tags, parent linkage, and span finish were ruled
  out. Structured diagnosis, raw logs, channel probes, runtime proof, missing coverage, and fixer handoff:
  `.dd-apm-evidence/genkit/14-diagnosis.json`, `.dd-apm-evidence/genkit/14-test-diagnosis.md`, and
  `.dd-apm-evidence/genkit/14-attempts/`.
- [x] 15 Fix tracing tests. Evidence: changed only `GenkitPlugin.static prefix` to
  `tracing:orchestrion:@genkit-ai/core:runInNewSpan`, matching the emitted `tracingChannel` lifecycle. The unchanged
  exact-version suite now passes 5/5 with no skips when all OTEL exporters and the sandbox's empty `DD_AGENT_HOST`
  are removed. No timeout/assertion/test was changed or deleted; syntax, targeted lint, and diff checks pass.
  Fix narrative, exact command/output, and structured result: `.dd-apm-evidence/genkit/15-test-fixer.md` and
  `.dd-apm-evidence/genkit/15-fixer-result.json`.
- [x] 16 Detect applicable tracing features. Evidence: parallel source-based decisions found DSM, distributed
  context propagation, DBM, and peer service all inapplicable. Genkit's selected hook is an in-process,
  provider-neutral orchestration/action boundary with no producer/consumer carrier, SQL query, transport headers,
  or stable endpoint; lower provider/database/transport integrations own those features. The exact 1.21.0 sample's
  zero-network run confirms model, retrieval, and embedding callbacks need not have a peer. Structured decisions,
  comparisons, and reasoning: `.dd-apm-evidence/genkit/16-dsm-context-feature-detection.json`,
  `.dd-apm-evidence/genkit/16-dbm-decision.json`, `.dd-apm-evidence/genkit/16-peer-service-decision.json`, and
  companion Stage 16 markdown evidence.
- [x] 17 Implement applicable tracing features. Evidence: explicit no-op because DSM, distributed context
  propagation, DBM, and peer service are all inapplicable; no production feature code or meaningless tests were
  added. The exact Genkit/core 1.21.0 tracing suite remains 5 passing with no failures/skips, and diff validation
  passes. Per-feature explanations, commands, and structured result:
  `.dd-apm-evidence/genkit/17-feature-implementation.md` and
  `.dd-apm-evidence/genkit/17-feature-result.json`.
- [x] 18 LLMObs: verify tracing prerequisite. Evidence: independently verified the exact
  `@genkit-ai/core@1.21.0` CJS/MJS Orchestrion hooks, loader, plugin prefix/id, both runtime registry keys,
  fixture pins, source hashes, and docs/types/CI registrations. With OTEL exporters and empty `DD_AGENT_HOST`
  removed, focused tracing tests pass 5/5 and plugin structure passes 171/171. This gate evaluates only the APM
  prerequisite and reports no blocker; LLMObs remains unevaluated. Commands, assertions, hashes, and result:
  `.dd-apm-evidence/genkit/18-tracing-precheck.md` and
  `.dd-apm-evidence/genkit/18-tracing-precheck.json`.
- [x] 19 LLMObs: build integration. Evidence: implemented and independently audited the exact-version Genkit
  LLMObs layer as `ORCHESTRATION`, composing LLMObs before tracing on the shared `runInNewSpan` channel. The plugin
  conditionally registers `llm`, `workflow`, `tool`, `retrieval`, and `embedding` spans; normalizes messages,
  tools, and documents; emits standard numeric token metrics and bounded scalar metadata; summarizes rather than
  serializes embedding vectors; and uses kind-appropriate empty error outputs. No unsupported `agent` span or
  guessed provider identity was added. Syntax, targeted lint, composition/contract assertions, evidence hashes,
  and diff checks pass; tests remain reserved for Stage 20. Implementation decisions, architecture score,
  limitations, commands, hashes, and structured result: `.dd-apm-evidence/genkit/19-build-integration.md` and
  `.dd-apm-evidence/genkit/19-build-integration.json`.
- [x] 20 LLMObs: write tests. Evidence: added 13 exact-version, pure in-process Genkit LLMObs tests with no VCR,
  network, provider APIs, clients, credentials, or cassettes. The suite covers all five emitted kinds; model and
  streaming success/error; flow/flowStep nesting and errors; tool success/error/interrupt; retrieval normalization
  and metadata allowlisting; embedding summaries with vector omission; ignored-label parenting; serialized-output
  fallback; the three-argument overload; and explicit secret/unsafe-part omission. The env-scrubbed suite passes
  13/13 with no failures or pending tests; syntax, targeted lint, and diff checks pass. Strategy declaration,
  coverage, commands, transcripts, hashes, and structured result: `.dd-apm-evidence/genkit/20-test-strategy.md`,
  `.dd-apm-evidence/genkit/20-write-tests.md`, `.dd-apm-evidence/genkit/20-write-tests.json`, and
  `.dd-apm-evidence/genkit/20-attempts/`.
- [x] 21 LLMObs: diagnose behavior. Evidence: an independent, single exact env-scrubbed run passed 13/13 with no
  failures or pending tests, so `failure_mode` is null and no source/test files require repair. The reviewer found
  complete coverage for the exact Stage 12/19 unit contract across all five kinds, errors, streaming, nesting,
  overloads, fallback parsing, and privacy/vector assertions. Native OTel/provider duplication, token ownership,
  and broader compatibility remain correctly reserved for final live/compatibility gates. Command, full output,
  structured diagnosis, and coverage assessment: `.dd-apm-evidence/genkit/21-test-output.log`,
  `.dd-apm-evidence/genkit/21-diagnosis.md`, and `.dd-apm-evidence/genkit/21-diagnosis.json`.
- [x] 22 LLMObs: fix behavior. Evidence: evidence-backed no-op because Stage 21 reported 13 passing, no failures or
  pending tests, null failure mode, no event/tag issues, and no files to fix. Per the stage contract, the fixer ran
  no tests and changed/deleted/weakened no production or test files; it verified all Stage 19/20 source hashes were
  unchanged and diff validation passes. Result and integrity evidence:
  `.dd-apm-evidence/genkit/22-test-fixer.md` and `.dd-apm-evidence/genkit/22-fixer-result.json`.
- [x] 23 Lint: collect failures. Evidence: all 11 changed production/test JavaScript files relative to the original
  base pass targeted ESLint with zero warnings and syntax checks; generated config types, JSON/YAML parsing,
  CODEOWNERS, exercised-test coverage, and whitespace checks also pass. No fixable failure was found. The
  repository-wide CI verifier stops before Genkit on an unrelated existing npm E404 for
  `confluentinc-kafka-javascript`; this is preserved as an external verifier blocker, not hidden as a Genkit lint
  failure. Inventory, commands, outputs, classification, and Stage 24 handoff:
  `.dd-apm-evidence/genkit/23-lint-diagnosis.md` and `.dd-apm-evidence/genkit/23-lint-result.json`.
- [x] 24 Lint: fix failures. Evidence: no-op with initial/final/fixed error counts `0/0/0`, zero iterations, and
  an empty files-to-fix list because Stage 23 found no Genkit lint defects. No source/test files changed; the
  diagnosed 11-file hash manifest and original-base-scoped diff check pass. The unrelated registry-dependent CI
  verifier blocker remains unchanged. Fixer narrative and structured result:
  `.dd-apm-evidence/genkit/24-lint-fixer.md` and `.dd-apm-evidence/genkit/24-lint-fixer-result.json`.
- [x] 25 Review: batch review. Evidence: independent senior review requires changes despite 18/18 default focused
  tests. Three high/fixable blockers were proven: model/embedder events fall back to generic identity; supported
  provider ownership/demotion is missing and can double-count authoritative LLM spans/tokens; and exact runtime
  with `DD_TRACE_OTEL_ENABLED=true` produces duplicate native Genkit spans whose raw input/output tags leak payloads
  and embedding vectors. Hook/lifecycle, ignored parenting, five-kind transforms, registrations, exact scope, and
  default tests otherwise passed. Canonical findings and runtime logs:
  `.dd-apm-evidence/genkit/25-review.md`, `.dd-apm-evidence/genkit/25-review.json`, and
  `.dd-apm-evidence/genkit/25-attempts/`.
- [x] 26 Review: batch fix. Evidence: fixed all three Stage 25 blockers with none failed/skipped. Model/embedder
  events now retain registered identity; source-proven `googleai/` models are demoted to workflow with no token
  metrics only when the enabled `google-genai` LLMObs plugin owns the request; and OTel-enabled execution suppresses
  only the distinct native Genkit bridge trace while preserving authoritative Datadog nesting and unrelated OTel.
  This removes duplicate native spans and raw input/output/vector export. Default and `DD_TRACE_OTEL_ENABLED=true`
  APM+LLMObs suites both pass 20/20, context-manager tests pass 26/26, and targeted lint/syntax/diff checks pass.
  Fix design, architecture score, commands, outputs, and result:
  `.dd-apm-evidence/genkit/26-batch-fix.md`, `.dd-apm-evidence/genkit/26-batch-fix.json`, and
  `.dd-apm-evidence/genkit/26-attempts/`.
- [x] 27 Review: diagnose repaired tests. Evidence: fresh default Genkit, OTel-enabled Genkit, and OTel
  context-manager runs pass 20/20, 20/20, and 26/26 respectively (66 total, no failures/pending), but coverage is
  not complete. Three missing boundary cases were identified: unrelated user OTel spans inside Genkit must remain
  exportable despite native-trace suppression; the shared preserve-context marker branch needs direct precondition
  unit tests; and source-proven `googleai/` with provider ownership disabled must remain `llm` with provider/model
  identity and metrics. Commands, logs, structured diagnosis, and Stage 28 handoff:
  `.dd-apm-evidence/genkit/27-diagnosis.md`, `.dd-apm-evidence/genkit/27-diagnosis.json`, and
  `.dd-apm-evidence/genkit/27-attempts/`.
- [x] 28 Review: repair tests. Evidence: added all three missing boundary cases and replaced trace-wide native
  Genkit suppression with instrumentation-scope suppression. Only the exact `genkit-tracer` OTel scope is
  non-recording; unrelated user OTel children remain exported under the authoritative Genkit span. Direct
  context-manager/tracer tests pin marker prerequisites and scope matching, while the provider-unowned
  `googleai/` path retains `llm` kind, provider/model identity, and token metrics. Default and OTel-enabled Genkit
  suites pass 22/22 each; shared OTel context-manager/tracer suites pass 49/49; lint, syntax, and diff checks pass.
  Repair rationale, architecture score, commands, outputs, and structured result:
  `.dd-apm-evidence/genkit/28-test-fixer.md`, `.dd-apm-evidence/genkit/28-test-fixer-result.json`, and
  `.dd-apm-evidence/genkit/28-attempts/`.
- [ ] 29 Review: human-quality gate. Evidence: automated engineering review completed and its sole blocker,
  `GENKIT-HUMAN-001`, was repaired test-first by moving `preserveOtelContext` from ambient span state to the
  operation-scoped Genkit store. Fresh validation passes: targeted regression 1/1, default Genkit 23/23,
  OTel-enabled Genkit 23/23, and shared OTel context-manager/tracer 49/49, plus targeted lint/syntax/diff checks.
  Literal human approval remains unavailable and is not marked passed; Stage 30 must not begin without explicit
  workflow-owner approval or waiver. Review, reproduction, remediation, commands, and structured status:
  `.dd-apm-evidence/genkit/29-human-review.md`, `.dd-apm-evidence/genkit/29-human-review.json`,
  `.dd-apm-evidence/genkit/29-human-review-fix.md`, and `.dd-apm-evidence/genkit/29-human-review-fix.json`.
- [ ] 30 Review: finalize. Evidence: pending
- [ ] 31 Final gate: build. Evidence: pending
- [ ] 32 Final gate: tests. Evidence: pending
- [ ] 33 Final gate: lint. Evidence: pending
- [ ] 34 Final gate: live observability. Evidence: pending
