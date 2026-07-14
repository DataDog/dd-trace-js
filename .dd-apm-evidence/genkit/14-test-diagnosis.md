# Stage 14: focused tracing-test diagnosis

Date: 2026-07-14 UTC

## Result

The focused exact-version suite is red: **0 passing, 5 failing, 0 pending**. The primary integration failure mode is
`channels`. All five real Genkit operations complete, but their assertions time out because the plugin listens on a
channel prefix that the Orchestrion rewrite never emits.

There is also an independent sandbox environment failure. This session exports `DD_AGENT_HOST` as an empty string.
The test agent supplies a valid dynamic port, but configuration first turns the empty host into `http:` and catches
`ERR_INVALID_URL` before `PluginManager.configure(config)`. That leaves the requested `genkit` configuration stored
but the manager unconfigured and the plugin uninstantiated. This is not a Genkit production-code defect, but it must
be removed from the focused test process to expose the integration's own failure.

## Authoritative reproduction

The required baseline explicitly removed all three OTEL exporter variables and retained the otherwise inherited
environment:

```sh
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
./node_modules/.bin/mocha packages/datadog-plugin-genkit/test/index.spec.js
```

Result in `14-attempts/test-output-1.log`:

```text
0 passing (26s)
5 failing
model, flow/flowStep, tool, retriever, embedder: Timeout of 5000ms exceeded
```

Removing the empty sandbox host value while continuing to unset all OTEL exporters isolates the integration:

```sh
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER DD_AGENT_HOST
./node_modules/.bin/mocha packages/datadog-plugin-genkit/test/index.spec.js
```

The plugin manager now configures and instantiates `genkit`, but the result remains 0 passing / 5 failing. See
`14-attempts/test-output-2-without-empty-agent-host.log`.

## Exact mechanism

`packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/genkit.js` correctly selects the named
async `runInNewSpan` function in exact `@genkit-ai/core@1.21.0`. The generated code constructs:

```text
tracingChannel("orchestrion:@genkit-ai/core:runInNewSpan")
```

`tracingChannel` exposes its constituent event channels under the `tracing:` namespace. Runtime publication is
therefore:

```text
tracing:orchestrion:@genkit-ai/core:runInNewSpan:start
tracing:orchestrion:@genkit-ai/core:runInNewSpan:end
tracing:orchestrion:@genkit-ai/core:runInNewSpan:asyncStart
tracing:orchestrion:@genkit-ai/core:runInNewSpan:asyncEnd
tracing:orchestrion:@genkit-ai/core:runInNewSpan:error
```

The Genkit plugin instead declares:

```text
orchestrion:@genkit-ai/core:runInNewSpan
```

so `TracingPlugin.addTraceBind/addTraceSub` attach to bare `orchestrion:...:*` names. With a configured tracer, the
channel probe observes `configuredStart=true` and `expectedStart=false` immediately after activation, then counts
one each of start/end/asyncStart/asyncEnd on `tracing:orchestrion:...` and zero on every bare configured channel.

## Layer-by-layer diagnosis

- Orchestrion configuration: valid. Exact package, version, CJS path, function name, and Async transform match.
- Hook loading: valid. `dd-trace:instrumentation:load` publishes `@genkit-ai/core`; the rewritten operation executes.
- Plugin registry: valid after tracer configuration. Both `plugins['@genkit-ai/core']` and `plugins.genkit` resolve to
  the function class with static id `genkit`.
- Plugin activation: blocked by the inherited empty `DD_AGENT_HOST`; after removing it, `genkit` is instantiated.
- Channel name: invalid. The plugin omits the required `tracing:` prefix.
- Span finishing: valid once subscribed. Orchestrion emits `asyncEnd` after settlement and `GenkitPlugin.asyncEnd`
  calls `super.finish(ctx)`.

As a bounded proof only, `14-prefix-proof.cjs` changes the class prefix in memory before activation; it does not edit
production or test source. With the empty host removed, the unchanged focused suite reports:

```text
5 passing (1s)
DATADOG TRACER INTEGRATIONS LOADED - [...,"genkit",...]
```

This rules out tags, hook selection, parent linkage, and unfinished spans as the current five-test failure.

## Stage 15 handoff

Use the `apm-integrations` skill. The direct production fix belongs in
`packages/datadog-plugin-genkit/src/index.js`; compare its static prefix with the established Orchestrion prefixes in
`packages/datadog-plugin-langchain/src/tracing.js`. Re-run the focused suite with all OTEL exporter variables unset
and remove this sandbox's empty `DD_AGENT_HOST` for the test command. Do not change timeouts or weaken assertions.

After restoring the current five success cases, coverage is still incomplete. Add runner-error siblings for every
operation family, streaming completion/error, tool interrupt semantics, strict ignored-label behavior, public ESM,
the three-argument overload, and documented schema-validation boundaries. The machine-readable handoff is
`14-diagnosis.json`.

No production file, test file, or `PROGRESS.md` was edited in Stage 14.
