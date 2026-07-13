# Step 13: compile

- Type: deterministic
- Objective: Generate instrumentation plugin code and tests from the final analysis.

## Existing Workflow Guidance

Deterministic for dd_trace_js (uses the dd-generate template-based generator).
LLM-driven for other tracers (uses ScaffoldWorkflow: plan → implement → validate).

USE COMPILE when writing a new integration from scratch for Node.js or any tracer.
It generates ALL required boilerplate files in one shot: plugin package, instrumentation
registration, test scaffold, service-naming entries, TypeScript types, CI workflow entry.
Skipping compile and writing files manually risks missing required boilerplate that
integration tests and CI expect to exist. Run compile first, then refine.

LIMITATION: compile uses the standard wrapping pattern for the detected category
(e.g. TracingChannel for Node.js, shimmer for Python). It does not account for
package-specific wrapping intricacies — e.g. a library that requires constructor
patching, async-context bridging across worker threads, or a non-standard hook point.
The generated code is a correct baseline, not a finished product. Review the output
and make targeted ad-hoc changes where the package's internals require a different
approach. The test step will surface any gaps.

dd_trace_js: Runs dd-generate as a subprocess. Reads final.json + context-mappings.json
and produces the plugin package, instrumentation file, and test scaffold. Fast (~30s).

Other tracers (py, java, etc.): Runs an agent to scaffold code from the analysis.
Much slower (~5-15 min). Quality depends on prompt fragments in
anubis_apm/prompts/shared/instrumentation/repo/<repo>/

If compile fails for dd_trace_js, check: dd-generate script path, final.json existence,
and that Node.js is on PATH.

## Instructions

Reproduce this workflow stage's stated outcome directly in the target repository. 
Inspect the current repository and prior pipeline results, follow repository standards, 
and preserve any result needed by later stages.

## Completion

Update `PROGRESS.md` with the result, changed files, commands run, and concrete evidence. 
Do not advance if this required stage is incomplete or its validation failed.
