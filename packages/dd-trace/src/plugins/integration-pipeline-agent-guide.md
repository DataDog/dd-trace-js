# Integration Pipeline: agent context

The Integration Pipeline is an internal, experimental architecture for authoring dd-trace integrations as operation
definitions instead of bespoke plugin lifecycles. It is designed for Orchestrion's uniform function lifecycle and is not a
public API.

## Objective

An integration should describe what is unique about a library operation:

- which source function is observed;
- how arguments and results become semantic data;
- whether the invocation should be instrumented;
- what the optional span looks like;
- which reusable product capabilities run.

The pipeline owns the mechanics that should not vary between integrations: channel subscriptions, invocation state,
parent selection, context reservation, async storage, optional span creation, stage ordering, errors, completion, and
cleanup.

## Lifecycle

```text
Orchestrion event
  -> normalize invocation
  -> extract start data
  -> evaluate the operation gate
  -> select a parent and reserve correlation context
  -> start context stages
  -> optionally materialize a span
  -> bind correlation and the optional span in legacy storage
  -> start tracing-dependent stages
  -> run the library function
  -> observe error and terminal events
  -> extract completion data and apply result tags
  -> unwind started stages in reverse order
  -> finish the optional span and delete invocation state
```

Rejected operations stop before context reservation, stages, and span creation. They run the library function under the
inherited or no-op legacy store selected by the `when` decision.

## Definition shape

```js
const Plugin = createIntegrationPlugin({
  id: 'example',
  configure: config => config,
  operations: [{
    target: { module: '@example/client', name: 'Client_request' },
    lifecycle: 'async',
    extract: {
      start: {
        request: argument(0),
        resource: invocation => normalizeResource(invocation.arguments[0]),
      },
      complete: {
        status: result('status'),
      },
    },
    when: frame => shouldInstrument(frame.data.request),
    context: {
      parent: frame => frame.data.remoteParent,
    },
    span: {
      enabled: frame => true,
      name: 'example.request',
      service: frame => frame.config.service,
      resource: data('resource'),
      type: 'custom',
      kind: 'client',
      tags: frame => frame.data.tags,
      resultTags: {
        'example.status': data('status'),
      },
    },
    stages: [contextStage, tracingStage],
  }],
})
```

`target.module` and `target.name` must match the Orchestrion module and `channelName`. `lifecycle: 'sync'` completes on
`end`. `lifecycle: 'async'` normally completes on `asyncEnd`; the default source classifies an `end` after an observed
error or newly added result as synchronous completion. Later terminal events are ignored.

## Extraction and gating

`extract.start` runs before the gate and before any context or span allocation. `extract.complete` runs after the result
or error is available and before result tags and stage completion.

An extractor may be a field record or one function returning the complete data record. Prefer the complete-record form
when several fields share parsing or traversal.

Helpers:

- `argument(index, ...path)` reads an invocation argument;
- `self(...path)` reads the receiver;
- `result(...path)` reads the completed result;
- `data(name)` reads `frame.data[name]` from a frame resolver.

`when` makes the complete gate decision and is evaluated once:

- a truthy value other than `'parent'` or `'noop'`: accept and trace the operation;
- a falsy value or `'parent'`: reject and inherit the active legacy store;
- `'noop'`: reject and suppress nested legacy tracing.

A gate controls only this pipeline operation. It must not reduce source-channel publication cardinality required by
AppSec, IAST, or other subscribers.

## Context and recording are separate phases

The pipeline reserves a real `DatadogSpanContext` before optional span creation. A later span adopts that context once,
so IDs observed before recording are the IDs written by the span.

A stage without `requires` is a context stage. It runs after correlation is reserved and before a span exists. Context
stages still run when:

- the operation has no `span` definition;
- `span.enabled` resolves to false;
- an inherited legacy no-op scope suppresses recording.

A stage with `requires: ['tracing']` runs only after a span is materialized and bound. In this API, `tracing` currently
means that a recording span is available.

The compiler partitions stages by this requirement: all context stages start before all tracing-dependent stages, while
preserving order inside each group. Declare context stages first; otherwise runtime order differs from array order.
Terminal hooks unwind the actual start order in reverse.

The current runtime uses one compatibility store:

```text
storage('legacy') {
  correlation,   // reserved context when a context stage needs it
  span,          // optional materialized recording span
  ...existingProductState
}
```

The frame and stage phases keep correlation logically independent from recording without paying for separate async
stores before a non-tracing product demonstrates that need. Adding a context stage also installs its reserved context
as the preferred parent for nested pipeline operations. A
context-only operation can therefore act as a non-recording parent boundary. If the boundary is never materialized, a
nested recorded span intentionally uses the reserved span ID as `parent_id` even though no local span with that ID is
emitted. Do not assume a context stage merely observes the existing parent identity.

## Frame capabilities

Stages receive a `PipelineFrame`, not the plugin, tracer, raw span, or mutable pipeline state.

| Surface | Contract |
| --- | --- |
| `frame.invocation` | Normalized `arguments`, `self`, and eventual `result` or `error`. |
| `frame.data` | Integration-specific semantic data shared by extractors, span resolvers, and stages. |
| `frame.config` | Configured integration options. |
| `frame.correlation` | Reserved trace/span IDs and injection backed by the reserved context. |
| `frame.trace.setTag()` | Writes to the span or buffers until one is materialized; discarded if no span is created. |
| `frame.propagation.extract()` | Extracts a remote parent from a carrier. |
| `frame.dataStreams` | Decodes DSM context and records checkpoints. |
| `frame.serviceName()` | Resolves schema-aware service naming for the integration. |

Correlation IDs are safe to read in a context stage. Trace injection from a newly reserved root context is not yet a
general context-stage capability because priority sampling may require a materialized span. Keep injection in a
tracing-dependent stage until context-level sampling exists.

## Stage contract

```js
const stage = {
  name: 'capability-name',
  requires: ['tracing'],
  start (frame) {},
  error (frame) {},
  complete (frame) {},
}
```

Rules:

- stages start in compiled phase order and unwind in reverse;
- a stage is recorded as started before its `start` hook runs, allowing cleanup after partial initialization;
- failed operations receive `error` hooks and later `complete` hooks;
- every hook is isolated so a stage failure cannot break the application or prevent remaining cleanup;
- stages have no private per-invocation state slot; use `frame.data` sparingly and avoid collisions;
- never expose or reach through to a raw span, tracer, plugin, or invocation state;
- add a bounded frame capability only when multiple integrations demonstrate the need.

## Parent selection

The parent is selected in this order:

1. `operation.context.parent`, when it returns a value other than `undefined`;
2. the active reserved correlation context in `storage('legacy')`;
3. the active span in that store.

Returning `null` from `context.parent` explicitly requests a root. Returning `undefined` falls back to active context.

## Source adapter contract

The default source maps targets to Orchestrion channels:

```text
tracing:orchestrion:<module>:<name>:start
tracing:orchestrion:<module>:<name>:end
tracing:orchestrion:<module>:<name>:asyncEnd
tracing:orchestrion:<module>:<name>:error
```

A custom source must create one fresh normalized invocation object with an `arguments` array for each call. It must
return that exact object identity for every lifecycle event belonging to the call because state is held in a `WeakMap`
keyed by that object. It must not reuse the object after completion or prepopulate terminal fields such as `error` and
`result`; add those fields only when the source observes the corresponding event.

Every accepted start must eventually publish one terminal `end` or `asyncEnd`, including after an `error`; `error`
records failure but is not terminal because callback execution may still be pending. Duplicate terminal events are
ignored. For async operations, the default lifecycle also treats `end` as terminal after an observed error or when the
source adds a synchronous result. It does not infer failure from a retained error payload.

Do not add a source adapter to hide integration-specific streaming, callback, mutation, or result-identity behavior. A
source belongs here only when it can provide the same bounded invocation lifecycle generically.

## Invariants

Changes to the pipeline must preserve these properties:

- rejected operations allocate no correlation context, start no stages, and create no span;
- context stages run before optional recording and complete even when recording is suppressed;
- tracing-dependent stages never start without a materialized span;
- a materialized span uses the exact reserved context and can adopt it only once;
- integration-authored failures never throw into the instrumented application;
- terminal cleanup deletes invocation state and finishes the optional span exactly once;
- source publication cardinality is unchanged;
- legacy storage is restored after synchronous and asynchronous calls;
- hot paths allocate only capabilities and storage fields required by the compiled operation.

## Current boundaries

- The generated class still extends `TracingPlugin`; this is not a tracing-independent product runtime.
- correlation and the optional recording span currently share `storage('legacy')`; their frame and stage contracts
  remain separate so a dedicated product-context store can be introduced from a concrete non-tracing requirement.
- The only stage requirement is `tracing`.
- Globally disabled tracing uses the no-op tracer and cannot reserve normal independent contexts.
- Pre-span root propagation does not yet have a complete priority-sampling decision.
- Only `sync` and `async` operation lifecycles are modeled; unusual streaming or iterator ownership may not fit.
- The operation and stage declaration shapes are experimental and may change.

These boundaries are reasons to extend the architecture from concrete requirements, not reasons to bypass it with raw
tracer or span access.

## Change checklist

Before changing the engine or adding a capability:

1. Identify the repeated behavior and the exact phase in which it must run.
2. Keep integration semantics in extractors and reusable product semantics in stages.
3. Define a narrow capability instead of exposing internals.
4. Validate invalid declaration combinations at plugin creation time.
5. Test accepted, rejected, no-op, context-only, optionally recorded, error, and terminal paths as applicable.
6. Test stage start order, reverse unwind, failure isolation, and store restoration.
7. Test synchronous throws and asynchronous rejection without inferring lifecycle state from payload values.
8. Benchmark the real diagnostic-channel lifecycle before adding work to hot integrations.
9. Keep Node.js store-binding behavior compatible across supported runtimes.

## Authoritative files

- [`integration-pipeline.js`](./integration-pipeline.js): executable contract, compiler, lifecycle, storage, and validation.
- [`integration-pipeline.spec.js`](../../test/plugins/integration-pipeline.spec.js): context/recording ordering, errors,
  no-op behavior, cleanup, and definition validation.
- [`span_context_factory.js`](../opentracing/span_context_factory.js): context reservation and one-time materialization.
- [`plugin.js`](./plugin.js): diagnostic-channel subscriptions and named store bindings.
- [`stages/`](./stages): reusable pipeline capabilities.
