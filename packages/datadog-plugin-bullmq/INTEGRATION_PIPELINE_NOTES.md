# How IntegrationPipeline works

This is a mechanical walkthrough of the current `IntegrationPipeline` experiment, using BullMQ as the concrete
example. It is not public documentation or a stable API promise. For the adoption argument and trade-offs, see
[INTEGRATION_PIPELINE_RATIONALE.md](./INTEGRATION_PIPELINE_RATIONALE.md).

## The mental model

Instrumentation still publishes diagnostic-channel events. The pipeline compiles an integration definition into a
plugin class that subscribes to those events and executes a standard operation lifecycle.

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

Pub/sub is therefore still the transport. The pipeline is the orchestration layer between an instrumentation event
and the products that act on that event.

## The relevant files

| File | Responsibility |
| --- | --- |
| `packages/dd-trace/src/plugins/integration-pipeline.js` | Definition compiler, lifecycle engine, stores, correlation facade, and default Orchestrion source adapter. |
| `packages/dd-trace/src/plugins/integration-pipeline-agent-guide.md` | Agent handoff, declaration reference, migration workflow, invariants, verification, and open work. |
| `packages/dd-trace/src/plugins/stages/code-origin.js` | Shared exit code-origin capability. |
| `packages/dd-trace/src/plugins/stages/messaging.js` | Shared propagation and Data Streams capability, parameterized by a per-operation message descriptor. |
| `packages/dd-trace/src/opentracing/span_context_factory.js` | Creates a real `DatadogSpanContext` without creating a span and lets a later span adopt it once. |
| `packages/dd-trace/src/opentracing/tracer.js` | Exposes internal context reservation and accepts an already reserved context when starting a span. |
| `packages/dd-trace/src/plugins/plugin.js` | Supports binding named stores and subscribing inside a legacy no-op scope when requested. |
| `packages/datadog-plugin-bullmq/src/index.js` | Compiles the BullMQ integration definition into the plugin-manager class. |
| `packages/datadog-plugin-bullmq/src/producer.js` | Producer operation declarations, telemetry-metadata carrier codec, and outbound message descriptors. |
| `packages/datadog-plugin-bullmq/src/consumer.js` | Consumer declaration, carrier extraction, parent selection, and inbound message descriptor. |
| `packages/datadog-plugin-azure-cosmos/src/index.js` | Declares an async database operation with schema naming and outbound stages. |

## 1. An integration is a definition

BullMQ exports the result of `createIntegrationPlugin`:

```js
module.exports = createIntegrationPlugin({
  id: 'bullmq',
  configure: config => ({ ...config, producerFilter: getFilter(config) }),
  operations: [...producerOperations, consumerOperation],
})
```

The result is a class named `IntegrationPipeline` that extends `TracingPlugin`. Reusable stages preserve
operation-specific behavior such as producer code-origin and peer-service tagging without recreating the
inbound/outbound plugin hierarchy. The generated class has the static `id` and `operation` fields expected by the
current plugin manager, so loading and configuration do not need a separate path.

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
| `frame.serviceName` | Schema-aware resolution with the integration ID and configured plugin options supplied. |
| `frame.propagation.extract` | Parent-context extraction from a carrier. |
| `frame.dataStreams` | DSM decode and checkpoint operations. |

The frame intentionally has no `span`, `tracer`, `plugin`, or mutable pipeline `state`. If a product needs another
operation, that should become a deliberate capability instead of an internal reach-through.

An integration supplies only schema coordinates such as `{ type: 'messaging', kind: 'producer' }`. The selected schema
owns the default name, plugin `service` override, and service-source attribution.

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
5. Run `messaging`: create a carrier, inject correlation into it, and when DSM is enabled create the outgoing
   checkpoint and encode its pathway into the same carrier.
6. Commit the finished carrier into `opts.telemetry.metadata` under `_datadog`, preserving customer fields.
7. Execute `Queue.add` and unwind the stage when its promise settles.

All three producer targets declare the same capability and differ only in three accessors:

| Target | `messages` | `commit` target | `payload` |
| --- | --- | --- | --- |
| `Queue.add` | the ensured options argument | those options | `frame.data.data` |
| `Queue.addBulk` | the filter-accepted job list | each job's options | each job's `data` |
| `FlowProducer.add` | the single flow node | the flow node's options | the flow node's `data` |

Injection and encoding share one carrier, so the metadata is parsed and serialized once per message instead of once per
capability. An isolated microbenchmark of the carrier work alone measured roughly 1180 ns per message before and 590 ns
after, reproduced across fresh shells.

The messaging stage currently requires tracing. It uses `frame.correlation`, not the span, but current priority sampling
may need span metadata before injection. Keeping it after materialization preserves existing propagation headers until
sampling is independently planned at the context layer.

## 12. BullMQ consumer flow

`Worker.callProcessJob` declares the consumer operation:

1. Extract the job, queue name, and Datadog carrier from BullMQ telemetry metadata.
2. Remove the Datadog fields from the metadata passed to customer code.
3. Extract the remote parent through `frame.propagation.extract`.
4. Reserve a local correlation context as a child of that parent.
5. Materialize the consumer span with those reserved IDs.
6. Run `messaging` with `direction: 'in'`, decoding the incoming DSM pathway and creating the incoming checkpoint.
7. Execute the job processor and unwind when its promise settles.

The consumer declares the same capability as the producers with the direction reversed. Its carrier accessor returns the
carrier already lifted out of telemetry metadata in step 1, because the remote parent has to be selected before a span
exists. The carrier is decoded even when absent, which is what starts a new pathway instead of extending the previous
job's.

Producer and consumer differences are declarations; subscription, capability, and tracing lifecycle code is shared.

## 13. Azure Cosmos database flow

`executePlugins` declares one async database operation:

1. Extract the SDK request context and whether the invocation represents an operation or an individual request.
2. Reject request-level hooks already represented by an enclosing operation span while inheriting that parent scope.
3. Reject empty-path account reads with a no-op scope so their nested HTTP request is suppressed as before.
4. Extract the low-cardinality resource, database, container, connection mode, endpoint, and user agent.
5. Resolve its v0/v1 service name and source through the storage schema, then materialize a `cosmosdb.query` span.
6. Apply exit code-origin and peer-service behavior through explicit stages.
7. Add status and substatus fields from either the response or the SDK error before the span finishes.

This migration proves schema-aware service resolution, reusable outbound stages, and a skip mode resolved from the
extracted frame. The lifecycle engine still owns subscriptions and completion.

## Current boundaries

- The compiled class still extends `TracingPlugin`; tracing is private to the pipeline but not yet an independently
  loadable capability.
- `storage('legacy')` remains necessary for compatibility with code outside the experiment.
- BullMQ propagation cannot safely move before tracing until sampling decisions can be made from context alone.
- `DD_TRACE_ENABLED=false` still selects a global no-op tracer that cannot reserve real unique correlation contexts.
- Only the `tracing` stage requirement exists today. Other product capabilities still need formal contracts.
- The messaging capability is shared across BullMQ's four operations, but BullMQ is its only consumer. Its descriptor is
  provisional until a header-map carrier (kafkajs or amqplib) confirms the shape. Until then propagation and Data
  Streams stay stages rather than declarative operation keywords beside `span`.

Within those limits, the important property is already real: correlation context and default stages have their own
lifecycle, and the existence of that lifecycle no longer implies that a span must be created.
