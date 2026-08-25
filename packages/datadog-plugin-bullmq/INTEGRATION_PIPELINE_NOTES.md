# How the integration lifecycle frameworks work

> Historical compatibility snapshot: this walkthrough describes the earlier BullMQ `IntegrationPipeline` prototype.
> BullMQ now uses `createMessagingIntegration()` with package fact sources, a shared messaging processor, and fixed
> produce/consume lifecycle adapters. Use the
> [current agent guide](../dd-trace/src/plugins/integration-pipeline-agent-guide.md) for migration decisions; raw
> integration-authored stage arrays are compatibility-only.

The remainder is intentionally preserved as a point-in-time record and contains present-tense statements that no
longer describe the branch.

This is a mechanical walkthrough of the current integration-lifecycle experiment. BullMQ demonstrates the
compatibility `IntegrationPipeline`; Azure Cosmos and MariaDB queries demonstrate the fixed processor/adapter
framework. Neither is a public API or stable API promise. For the adoption argument and trade-offs, see
[INTEGRATION_PIPELINE_RATIONALE.md](./INTEGRATION_PIPELINE_RATIONALE.md).

## The mental model

Instrumentation still publishes diagnostic-channel events. The compatibility pipeline compiles a flexible
integration definition into a plugin class that subscribes to those events and executes a standard operation
lifecycle.

```text
instrumented library call
  -> source adapter normalizes the event
  -> operation extracts domain data and applies its gate
  -> pipeline reserves and binds correlation context
  -> span-independent stages start
  -> pipeline optionally creates and binds a span
  -> tracing-dependent stages start
  -> original library function runs
  -> error hooks run if the call fails
  -> result data is extracted
  -> stages complete in reverse order
  -> optional span finishes and async stores are restored
```

Pub/sub is therefore still the transport. For same-domain integrations with a fixed contract, the processor/adapter
path narrows that flow further:

```text
raw source -> process-wide bridge -> package facts
                                      +-> product contributors
                                      +-> per-tracer processor -> lifecycle adapter -> trace manager
```

The source bridge owns physical subscription cardinality. Package modules own package facts, product contributors own
their stores, domain processors own APM policy, and trace managers privately own per-tracer spans.

## The relevant files

| File | Responsibility |
| --- | --- |
| `packages/dd-trace/src/plugins/integration-pipeline.js` | Definition compiler, lifecycle engine, stores, correlation facade, and default Orchestrion source adapter. |
| `packages/dd-trace/src/plugins/integration-pipeline-agent-guide.md` | Agent handoff, declaration reference, migration workflow, invariants, verification, and open work. |
| `packages/dd-trace/src/opentracing/span_context_factory.js` | Creates a real `DatadogSpanContext` without creating a span and lets a later span adopt it once. |
| `packages/dd-trace/src/opentracing/tracer.js` | Exposes internal context reservation and accepts an already reserved context when starting a span. |
| `packages/dd-trace/src/plugins/plugin.js` | Supports binding named stores and subscribing inside a legacy no-op scope when requested. |
| `packages/dd-trace/src/events/source-registry.js` | Process-wide raw-source ownership and product contributor activation. |
| `packages/dd-trace/src/events/registry.js` | Per-tracer processor and immutable package-source configuration ownership. |
| `packages/dd-trace/src/events/database` | Shared database factory, processor, fixed query adapter, and source bridge. |
| `packages/dd-trace/src/events/trace-manager.js` | Opaque per-tracer span correlation and exactly-once terminal operations. |
| `packages/datadog-plugin-bullmq/src/index.js` | Compiles the BullMQ integration definition into the plugin-manager class. |
| `packages/datadog-plugin-bullmq/src/producer.js` | Producer operation declarations and propagation/DSM stages. |
| `packages/datadog-plugin-bullmq/src/consumer.js` | Consumer declaration, carrier extraction, parent selection, and DSM stage. |
| `packages/datadog-plugin-azure-cosmos/src/index.js` | Thin declaration using the shared database factory. |
| `packages/datadog-plugin-azure-cosmos/src/query-source.js` | Cosmos-only argument, result, and skip facts. |
| `benchmark/sirun/plugin-azure-cosmos-pipeline` | Baseline/candidate hot-path benchmark for accepted, rejected, and inherited no-op calls. |
| `packages/datadog-plugin-mariadb/src/index.js` | Shared query declaration layered over the MySQL pool/connection compatibility base. |
| `packages/datadog-plugin-mariadb/src/query-source.js` | MariaDB-only connection/query facts and SQL write-back. |
| `packages/datadog-instrumentations/src/mariadb.js` | Existing v2/v3 query completion owners and driver write-back. |
| `benchmark/sirun/plugin-mariadb-pipeline` | Legacy/shared direct, pool-query-facts, and tracing-disabled benchmark. |

## 1. A compatibility integration is a definition

BullMQ exports the result of `createIntegrationPlugin`:

```js
module.exports = createIntegrationPlugin({
  id: 'bullmq',
  configure: config => ({ ...config, producerFilter: getFilter(config) }),
  operations: [...producerOperations, consumerOperation],
})
```

The result is a class named `IntegrationPipeline` that extends `TracingPlugin` by default. A compatibility definition
can select a `TracingPlugin` subclass with `base` when its complete semantic contract is required. The generated class
has the static `id` and `operation` fields expected by the current plugin manager, so loading and configuration do not
need a separate path.

The definition is validated before subscriptions are registered. It rejects missing IDs, empty operation lists,
invalid targets or lifecycles, duplicate targets, spans without names, unknown capabilities, and tracing-dependent
stages on operations that have no span definition.

## 2. Each operation describes one observed function

An operation has the following main parts:

```js
{
  target: { module: 'bullmq', name: 'Queue_add' },
  lifecycle: 'async',
  extract: { start: { /* semantic fields */ } },
  when: frame => true,
  context: { parent: frame => /* optional extracted parent */ },
  span: { /* optional trace definition */ },
  stages: [/* product work */],
}
```

- `target` identifies the source event.
- `lifecycle` selects synchronous `end` or promise-aware `asyncEnd` completion.
- `extract.start` and `extract.complete` populate `frame.data`. Use a field record for independent values or a
  whole-record function when several values share parsing/computation; the latter avoids an intermediate wrapper and
  is the preferred coarse-grained Lego block for hot integrations.
- `when` is an early operation gate.
- `context.parent` can override the inherited correlation parent.
- `span` describes optional recording behavior.
- `stages` contain ordered product work.
- `skip: 'noop'` asks a rejected operation to suppress nested legacy tracing rather than simply inherit its parent.
  It may also be a frame resolver when one source target needs different skip behavior for different invocations.

Helper extractors such as `argument(0)`, `self('name')`, `result('status')`, and `field('queueName')` keep common paths
short. An ordinary function is used when extraction needs integration-specific behavior. Span `tags`, `metrics`, and
`resultTags` likewise accept either per-field records or a function returning the complete record, so shared parsing
and allocation happen once.

## 3. The source adapter isolates Orchestrion

The default source adapter performs two jobs:

1. Translate a target into the four Orchestrion lifecycle channels:
   `start`, `end`, `asyncEnd`, and `error`.
2. Validate and return the invocation object containing `arguments`, `self`, `result`, and `error`.

For example, the BullMQ target `{ module: 'bullmq', name: 'Queue_add' }` maps to channels under:

```text
tracing:orchestrion:bullmq:Queue_add
```

The pipeline accepts a different `definition.source`, so the lifecycle engine itself does not construct or understand
other event-source formats.

## 4. Start bindings establish three nested stores

For every operation, the generated plugin registers three bindings on the start channel. Store bindings execute in
reverse registration order, producing this effective nesting:

```text
storage('context')
  -> storage('legacy')
    -> storage('span')
      -> start subscribers and original function
```

The stores have deliberately different meanings:

| Store | Value and purpose |
| --- | --- |
| `storage('context')` | Span-independent product context, currently including `correlation`. |
| `storage('span')` | The active recording span, when one was materialized. |
| `storage('legacy')` | Compatibility store used by existing tracer and plugin code during migration. |

The context binding is outermost so correlation exists before the compatibility binding decides whether to create a
span. The named span store is innermost so tracing-dependent stages and the library call can observe it.

When the diagnostic-channel scope exits, the storage implementation restores every parent store automatically.

## 5. Preparation extracts data and reserves correlation

The pipeline keeps an `InvocationState` in a `WeakMap` keyed by the normalized invocation object. Multiple bindings and
terminal events therefore operate on the same state without adding pipeline internals to the public invocation.

Preparation happens once:

1. Create a frame and empty data record.
2. Run start extractors in declaration order.
3. Evaluate `when`.
4. If accepted, choose a parent.
5. Reserve a `DatadogSpanContext` from that parent.
6. Expose an immutable correlation facade on the frame.

The parent is selected from the first available source:

1. `operation.context.parent`, when explicitly declared;
2. the correlation in the active context store;
3. the active span in the legacy store.

A rejected operation stops before context allocation, stages, or tracing. Its bindings return either the inherited
store or a legacy no-op store according to `skip`.

## 6. Correlation exists independently of a span

The correlation facade contains:

```js
frame.correlation.traceId
frame.correlation.traceId128
frame.correlation.spanId
frame.correlation.inject(format, carrier)
```

It privately retains the reserved `DatadogSpanContext`, but stages cannot access that object directly. They also do not
receive a span, tracer, plugin, or invocation state.

This is what makes a spanless operation possible. An operation with stages but no `span` definition binds correlation,
runs its context stages, invokes the library, unwinds the stages, and emits no trace.

For an optionally traced operation, `span.enabled` is resolved after context stages start. Returning `false` skips span
materialization and every tracing-dependent stage while preserving context-stage completion.

## 7. Context stages run before tracing

Stages without a requirement start as soon as the context and legacy scopes are active:

```js
const contextStage = {
  name: 'correlation-consumer',
  start (frame) {
    useIds(frame.correlation.traceId, frame.correlation.spanId)
  },
  complete (frame) {
    // Context is still available here.
  },
}
```

These stages also run inside an inherited `storage('legacy')` value of `{ noop: true }`. That permits correlation-only
work in a scope where nested tracing is suppressed.

`frame.trace.setTag(name, value)` is available as a narrow annotation capability. Before a span exists, the pipeline
buffers the tag. If a span is later materialized, it receives the buffered tags. If the operation remains spanless,
there is no recording destination and the buffered tag is discarded with the invocation state.

## 8. Tracing is optional and adopts the reserved IDs

When an operation has an enabled `span` definition and is not inside a legacy no-op scope, the pipeline resolves its
name, service, resource, type, kind, tags, and metrics. It calls the existing `TracingPlugin.startSpan`, passing both
the selected parent and the reserved context.

The span context factory permits that context to be materialized once. Consequently:

```text
IDs visible to context stages == IDs injected through correlation == IDs recorded by the span
```

The pipeline then binds the span in `storage('span')` and starts stages that explicitly declare:

```js
requires: ['tracing']
```

The `requires` declaration is an ordering and availability contract. Such a stage never starts when the operation has
no span, tracing is conditionally disabled, or a legacy no-op parent suppresses nested tracing.

## 9. The frame exposes capabilities, not internals

A stage receives one `PipelineFrame` with these surfaces:

| Surface | Purpose |
| --- | --- |
| `frame.invocation` | Normalized arguments, receiver, result, and error from the source. |
| `frame.data` | Semantic values shared by extractors, span fields, and stages for this invocation. |
| `frame.correlation` | Stable IDs and propagation injection without exposing a span. |
| `frame.trace.setTag` | Narrow trace annotation, buffered until tracing exists. |
| `frame.config` | Configured integration options. |
| `frame.serviceName` | Existing schema-aware service-name resolution. |
| `frame.propagation.extract` | Parent-context extraction from a carrier. |
| `frame.dataStreams` | DSM decode and checkpoint operations. |

The frame intentionally has no `span`, `tracer`, `plugin`, or mutable pipeline `state`. If a product needs another
operation, that should become a deliberate capability instead of an internal reach-through.

## 10. Terminal events unwind the operation

Started stages are appended to a list. Terminal hooks walk that list backwards, matching nested-scope behavior:

```text
start:    correlation -> propagation -> DSM
error:    DSM -> propagation -> correlation
complete: DSM -> propagation -> correlation
```

Each hook is isolated by a catch-and-log boundary. A product-stage failure cannot throw into BullMQ or prevent the
remaining hooks from running.

On an error event, the pipeline adds the error to the optional span and invokes stage `error` hooks. Completion still
performs completion extraction and invokes `complete` hooks. The final cleanup deletes the weak-map state and finishes
the span in a `finally` block.

For synchronous operations, `end` completes the state. For asynchronous operations, a synchronous `end` completes
only an immediately failed invocation; normal promise settlement completes on `asyncEnd`.

## 11. BullMQ producer flow

`Queue.add`, `Queue.addBulk`, and `FlowProducer.add` declare producer operations.

For `Queue.add`, the flow is:

1. Extract the job name, data, options, and queue name.
2. Apply the configured producer filter.
3. Reserve and bind correlation.
4. Create the producer span.
5. Run `trace-propagation`, injecting correlation into BullMQ telemetry metadata.
6. When DSM is enabled, create the outgoing checkpoint and encode its pathway in the same metadata.
7. Execute `Queue.add` and unwind both stages when its promise settles.

Bulk and flow operations use the same lifecycle with extractors and stages adapted to their payload shapes.

The propagation stages currently require tracing. They use `frame.correlation`, not the span, but current priority
sampling may need span metadata before injection. Keeping them after materialization preserves existing propagation
headers until sampling is independently planned at the context layer.

## 12. BullMQ consumer flow

`Worker.callProcessJob` declares the consumer operation:

1. Extract the job, queue name, and Datadog carrier from BullMQ telemetry metadata.
2. Remove the Datadog fields from the metadata passed to customer code.
3. Extract the remote parent through `frame.propagation.extract`.
4. Reserve a local correlation context as a child of that parent.
5. Materialize the consumer span with those reserved IDs.
6. Decode the incoming DSM pathway and create the incoming checkpoint.
7. Execute the job processor and unwind when its promise settles.

Producer and consumer differences are declarations and stages; subscription and tracing lifecycle code is shared.

## 13. Azure Cosmos database flow

`createDatabaseIntegration()` registers one Cosmos package source for the fixed `db.query` operation:

1. The process-wide source registry activates one raw Orchestrion bridge while any tracer or product contributor
   consumes Cosmos queries.
2. `query-source.js` extracts the SDK request context and whether the invocation is an operation or individual
   request. It returns package facts only; it never receives a tracer or span.
3. Duplicate request-level hooks return `{ skip: 'parent' }`. Empty-path account reads return `{ skip: 'noop' }` so
   their nested HTTP request remains suppressed.
4. The bridge publishes one normalized event to eligible product contributors and each tracer's database processor.
   Raw package arguments are not broadcast.
5. Each processor applies common database policy, then its fixed query adapter starts a span through its private trace
   manager. Multiple tracers correlate distinct spans to the same event identity.
6. Status and substatus facts from either the response or SDK error are applied before an atomic completion or
   failure releases that tracer's state exactly once.

The shared `DatabaseProcessor` extends `DatabasePlugin`, retaining storage service naming and outbound peer-service
finalization. The narrow `finishSpan()` boundary lets the trace manager finalize the exact span it owns without
exposing that span to the package source or a shared event.

## 14. MariaDB query flow

MariaDB reuses the same `db.query` processor and fixed query adapter through an explicit lifecycle descriptor:

```text
apm:mariadb:query:start -> apm:mariadb:query:error -> apm:mariadb:query:finish
```

The existing instrumentation remains the physical lifecycle owner. This is necessary rather than transitional
duplication: MariaDB v2 has separate callback and promise query paths, while v3 commands settle through wrapped
`resolve` / `reject` callbacks after `Command.start()` has returned. Treating `start()` as an Orchestrion async target
would finish too early.

The query flow is:

1. One process-wide bridge installs two store bindings (`start` and parent-restoring `finish`) and two terminal
   subscribers (`error` and `finish`) while any tracer consumes MariaDB queries.
2. `query-source.js` allowlists the SQL statement, connection identity, and optional pool wait time. Passwords and
   driver-owned option graphs are not published.
3. The shared processor creates the MariaDB span with SQL-compatible `db.type` and `span.type` fields, preserving the
   legacy span shape.
4. When DBM propagation changes the statement, the processor records an opaque source update. The package source
   writes it back to string or object query input, and the instrumentation applies that value before the driver runs.
5. Only the primary tracer consumer mutates the physical SQL statement. Additional tracers still create and finish
   distinct spans for the same normalized event.
6. The finish binding restores the source caller's store around callback completion, independent of the span store
   selected by any tracer.

The generated query class uses `MySQLPlugin` only as a compatibility base. Its automatic query subscribers are
suppressed, while constructor-owned pool acquisition and connection subscriptions remain active. Pool and connection
lifecycle adapters are intentionally deferred to the next slice, so this commit does not mix their context risks with
query ownership.

## Current boundaries

- The compiled BullMQ class still extends `TracingPlugin`, directly or through a selected compatibility base;
  tracing is private to the compatibility pipeline but not yet an independently loadable capability.
- The database processor is still implemented through `DatabasePlugin`; its span is private to `TraceManager`, while
  product contributors are independently registered and can keep a package source active without APM.
- MariaDB pool acquisition and connection lifecycles still use the MySQL compatibility base. Only query lifecycle and
  DBM write-back use the shared processor in this slice.
- `storage('legacy')` remains necessary for compatibility with code outside the experiment.
- BullMQ propagation cannot safely move before tracing until sampling decisions can be made from context alone.
- `DD_TRACE_ENABLED=false` still selects a global no-op tracer that cannot reserve real unique correlation contexts.
- Only the `tracing` compatibility-stage requirement exists today. The contributor registry has a tested contract,
  but no production non-APM contributor has migrated to it yet.

Within those limits, the important property is already real: correlation context and default stages have their own
lifecycle, and the existence of that lifecycle no longer implies that a span must be created.
