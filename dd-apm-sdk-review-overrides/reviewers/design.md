Override for `reviewers/design.md` (in the core skill folder) — read that file first, then this.

# Design — dd-trace-js specifics

## Architecture of dd-trace-js

- `packages/dd-trace/` — the library core: `src/proxy.js` + `src/tracer.js` (public tracer), `src/opentracing/{tracer,span,span_context}.js` (span model), `src/config/` (config resolution), `src/encode/{0.4,0.5}.js` + `src/exporters/` (payload + transport), `src/plugins/` (plugin base classes + registry `src/plugins/index.js`), plus subsystems `appsec/`, `iast` (under `appsec/iast`), `profiling/`, `debugger/`, `llmobs/`, `ci-visibility/` (Test Optimization), `guardrails/`, `telemetry/`, `datastreams/`, `opentelemetry/`.
- `packages/datadog-core/` — `src/storage.js` (`DatadogStorage extends AsyncLocalStorage`, with the `getHandle()` escape hatch and the pre-AsyncContextFrame WeakMap path) and small shared utils. Lowest layer; must not import from `dd-trace` or plugins.
- `packages/datadog-instrumentations/` — monkey-patching layer only. `src/helpers/instrument.js` (`addHook({ name, versions, file, filePattern, patchDefault }, hook)`), `helpers/hook.js`, `helpers/register.js`, `helpers/instrumentations.js`, `src/helpers/rewriter` (IAST). It patches modules and `publish`es to diagnostic channels. Tracing lifecycle and span creation must NOT live here - that belongs in `datadog-plugin-*`, and the contract across the boundary is the channel name + payload shape. Importing helpers from `dd-trace` is not by itself a violation: `src/next.js` takes service-naming and OpenTelemetry helpers, and `kafkajs.js`, `otel-sdk-trace.js` and several Test Optimization instrumentations import tracer internals today. Report a new import only when it moves span lifecycle into this layer or bypasses the channel contract, and check prior art in a sibling instrumentation before calling it a violation.
- `packages/datadog-plugin-<name>/` — 100+ plugins that `subscribe` to those channels and create spans, extending base classes in `packages/dd-trace/src/plugins/` (`tracing.js`, `client.js`, `server.js`, `database.js`, `cache.js`, `consumer.js`, `producer.js`, `composite.js`, `ci_plugin.js`). Plugins must NOT reach into another plugin's internals nor monkey-patch (that is the instrumentations layer's job).
- `packages/datadog-shimmer/` — the wrapping primitive used by instrumentations.
- `packages/datadog-{esbuild,webpack}/`, `packages/datadog-code-origin/`, `vendor/` (rspack-bundled deps → `packages/node_modules/`).

Read **AGENTS.md § "Project Overview"** for the package roles and **§ "Architecture Decisions"** for the six-dimension rubric this repo scores structural changes against - apply that rubric rather than a generic one.

- Layering rule: `datadog-core` ← `dd-trace` ← `datadog-plugin-*`; `datadog-instrumentations` sits beside plugins and communicates only via diagnostic channels (decoupled by design — see `.agents/skills/apm-integrations/SKILL.md`).
- Tests: unit `*.spec.js` beside each package (`packages/*/test/`), E2E in `integration-tests/`, benchmarks in `benchmark/` (`benchmark/sirun/` for tracked ones).
- New instrumentation goes in `packages/datadog-instrumentations/`; a new plugin must be registered in `packages/dd-trace/src/plugins/index.js`, `index.d.ts`, `docs/test.ts`, `docs/API.md`, `.github/workflows/apm-integrations.yml`.

## Configuration surface — the registration path

Read **AGENTS.md § "Adding New Configuration Options"** - it lists the required steps and the file for each. Do not restate them from memory; open the section and check the diff against it.

Only the parts AGENTS.md does not state:
- `packages/dd-trace/src/config/generated-config-types.d.ts` is generated; regenerate/verify with `npm run generate:config:types` / `npm run verify:config:types`. A stale generated file fails CI.
- Naming: size/time options carry unit suffixes (`timeoutMs`, `maxBytes`, `intervalSeconds`).
- A missing `supported-configurations.json` entry is a CI failure, not a nit - so a diff that reads a new `DD_*` var without registering it is Blocking.

## Public API surface — what counts as public here

Read **AGENTS.md § "Public TypeScript Types"** for the two-surface rule (`index.d.ts` vs `index.d.v5.ts`) and its stance on adding to npm-exported classes. Judge the diff against that section rather than a summary of it.

Beyond what that section covers, these are also public contracts:
- `index.js` (package `main`) and the exports of `packages/dd-trace/src/index.js` / `proxy.js`.
- `docs/API.md` (documented options/plugins) and `docs/test.ts` (type smoke test). A new plugin must also be registered in `packages/dd-trace/src/plugins/index.js` and `.github/workflows/apm-integrations.yml`.
- Config option names and `DD_*` env vars (`packages/dd-trace/src/config/supported-configurations.json`).
- Span tag names, metric names, telemetry config names, and diagnostic-channel names consumed across package boundaries - de-facto contracts even though they are not typed.
- `_underscore` fields: avoid refactoring without evidence they are not reached externally; prefer `#private` for state that does not cross the class boundary.
