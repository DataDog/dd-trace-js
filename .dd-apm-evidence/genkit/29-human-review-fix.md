# Stage 29 automated-review remediation: GENKIT-HUMAN-001

Date: 2026-07-14 UTC

## Result

`GENKIT-HUMAN-001` is fixed with a test-first, operation-scoped change. The automated engineering blocker is
resolved. Literal human approval remains unavailable and **is not marked passed**; this remediation does not change
the Stage 29 human-approval capability status.

## Failing regression first

An exact `@genkit-ai/core@1.21.0` regression was added to
`packages/datadog-plugin-genkit/test/index.spec.js`. With `DD_TRACE_OTEL_ENABLED=true`, it creates a user-owned
Datadog parent, invokes a real ignored `runInNewSpan` (`genkit:type=util`), and then asserts the parent does not
retain `preserveOtelContext`.

Before the production fix:

```text
0 passing, 1 failing
actual: true
expected: undefined
```

This directly reproduced the marker lifetime defect found by the automated Stage 29 review.

## Minimal fix

`GenkitTracingPlugin.#suppressNativeGenkitSpan()` no longer mutates `authoritativeStore.span`. It returns the copied
operation store with both internal OTel controls:

- `preserveOtelContext: true`;
- `suppressOtelInstrumentation: 'genkit-tracer'`.

`ContextManager.active()` now reads `preserveOtelContext` from the active legacy store, not from the active span
object. The store is scoped by the Orchestrion `runStores()` lifecycle, so preservation expires automatically when
the Genkit operation returns. Ambient user spans remain unchanged.

The three direct context-manager tests were updated to pin the store-scoped contract: marked+stored preservation,
marked without stored fallback, and the unmarked control path. No public API was added and instrumentation-scope
suppression behavior was otherwise unchanged.

## Validation

Commands run from `/workspace/repo` with telemetry exporters and the sandbox's empty `DD_AGENT_HOST` removed:

```sh
DD_TRACE_OTEL_ENABLED=true ./node_modules/.bin/mocha --timeout 20000 \
  --grep 'does not leave OTel context preservation' \
  packages/datadog-plugin-genkit/test/index.spec.js
# 1 passing

./node_modules/.bin/mocha --timeout 20000 \
  packages/datadog-plugin-genkit/test/index.spec.js \
  packages/datadog-plugin-genkit/test/llmobs.spec.js
# 23 passing

DD_TRACE_OTEL_ENABLED=true ./node_modules/.bin/mocha --timeout 20000 \
  packages/datadog-plugin-genkit/test/index.spec.js \
  packages/datadog-plugin-genkit/test/llmobs.spec.js
# 23 passing

./node_modules/.bin/mocha \
  packages/dd-trace/test/opentelemetry/context_manager.spec.js \
  packages/dd-trace/test/opentelemetry/tracer.spec.js
# 49 passing
```

`node --check` and targeted ESLint passed for the four modified source/test files. Both repository-base-scoped and
working-tree `git diff --check` passed with no output.

## Source hashes

```text
e8b9db7b95f2eca09cf15f28ce90829a856acaed75f031d14f12c4ec20585e96  packages/datadog-plugin-genkit/src/tracing.js
4528b7d8c854284f0e9c96add9d8c385ee4d0a36955f62d4b9f04dfc07608bc5  packages/datadog-plugin-genkit/test/index.spec.js
d43809462bd6c7b07cb8c330164557f5ac5a3b0d34870947a1fab450a0ad32e8  packages/dd-trace/src/opentelemetry/context_manager.js
133972c660828bdfd593cb0e010c740a8e4fb1f60bad44663a576ea8bd7765b8  packages/dd-trace/test/opentelemetry/context_manager.spec.js
```

## Handoff

- Automated engineering finding `GENKIT-HUMAN-001`: **resolved**.
- Automated focused validation: **passed**.
- Literal human approval: **unavailable / not approved / unchanged**.
- `PROGRESS.md` modified by this remediation worker: **no**.
- Commit created: **no**.

Stage 29 remains incapable of satisfying its literal human-approval objective until a human reviewer approves or
the workflow owner explicitly waives/replaces that capability.
