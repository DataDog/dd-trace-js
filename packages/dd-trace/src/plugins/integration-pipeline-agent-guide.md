# Integration processor/adapter and compatibility pipeline agent guide

This is the implementation and migration guide for agents continuing the experimental integration-lifecycle work.
It covers the processor/adapter framework now used by Azure Cosmos, MariaDB, and BullMQ, plus the compatibility
`IntegrationPipeline` engine retained as a low-level reference. It documents the current executable contracts, the
invariants migrations must preserve, and the checks required before changing either path.

Both frameworks are internal and experimental. They are not public APIs, and their declaration shapes may still
change. New integration migrations must prefer a fixed domain processor and lifecycle adapter. Arbitrary
integration-authored operation and stage arrays are compatibility-only; do not introduce them as the author-facing
model when a stable domain contract can own the behavior.

## Current checkpoint (2026-08-25)

At this checkpoint, branch `crysmags/integration-processor-adapters`, based on
`pabloerhard/feat-new-orchestrion-pipeline`, has reached this implementation state:

- BullMQ is the first messaging processor/adapter migration. Package sources normalize producer and consumer facts
  and perform bounded carrier write-back; the shared processor owns filtering, span policy, propagation, DSM, and
  fixed produce/consume lifecycle adapters.
- Azure Cosmos is the first database processor/adapter migration. Its package source extracts only Cosmos facts; one
  process-wide bridge normalizes the raw Orchestrion lifecycle; one database processor per tracer owns APM policy.
- MariaDB is the second database proof. Its existing v2 callback/promise and v3 command wrappers retain physical
  completion ownership, while process-wide bridges normalize query and pool-acquire lifecycles for shared query,
  pool-acquire, and connection adapters. The package no longer needs the MySQL compatibility base.
- The process-wide source registry maintains one physical raw binding per source operation and independently
  reference-counts APM consumers, product contributors, and in-flight operations awaiting terminal cleanup.
- The per-tracer domain registry maintains one processor per semantic operation and immutable configuration per
  package source.
- Fixed lifecycle adapters delegate span ownership to an opaque trace manager. Multi-tracer operations share
  normalized facts but retain and finalize distinct spans.
- Product contributors receive normalized, allowlisted source facts and lifecycle metadata, never raw argument,
  credential, or header containers or package object graphs. They can keep a source active when APM is disabled.
- Orchestrion async package completion is owned by `asyncEnd`; duplicate terminal events are ignored.
- No production package calls `createIntegrationPlugin()`. The compatibility compiler remains available for its
  executable contract and incremental compatibility work, not as the default integration-authoring API.
- The compatibility engine accepts a `TracingPlugin` subclass through `base`, evaluates `skip` as a literal or frame
  resolver, and completes materialized spans through the selected base class's `finish()` method.
- Compatibility correlation context is reserved before optional span materialization. The materialized span adopts the
  same context, preserving IDs exposed to span-independent stages.
- The compatibility compiler installs context/span stores only for operations whose stages need them. Frames,
  correlation strings, capability blocks, stage arrays, and retained state are lazy or omitted on unused paths.
- Compatibility extraction and span-tag records support coarse whole-record functions, letting integrations compute
  shared semantic facts once instead of assembling them through many resolver calls.
- Azure Cosmos preserves request-level deduplication, empty-path account-read suppression, service naming, resource and
  response tags, error handling, analytics, peer-service behavior, and CJS/ESM coverage through the new framework.

Verification completed at this checkpoint:

- focused database-factory, processor, domain-registry, DBM, lifecycle-adapter, and MariaDB source tests: passing;
- Azure Cosmos focused source-boundary tests: 10 passing;
- Azure Cosmos real SDK/emulator tests against `@azure/cosmos` 4.4.1 and 4.10.0: 8 passing;
- Azure Cosmos ESM named and namespace imports against both boundary versions: 4 passing;
- full MariaDB plugin matrix, including query, pool, connection, DBM write-back, CJS, and ESM coverage: 328 passing;
- full BullMQ producer/consumer matrix across 5.66.0, 5.81.3, and 6.1.2, including propagation, filters, DSM, errors,
  concurrent DSM isolation, CJS, and ESM: 128 passing;
- focused changed-file coverage for the earlier database slice: 96.94% lines overall; messaging behavior is covered
  by direct processor/factory contracts and the full BullMQ regression matrix;
- focused ESLint and `git diff --check`: passing.
- the persistent Azure microbenchmark retains a roughly 173 ns accepted-path cost versus the compatibility pipeline;
  duplicate rejection is materially faster, and empty-path and inherited-noop paths remain near parity. See the
  benchmark README for the final trial medians.
- real SDK/emulator trials found no detectable request-level difference; the sub-microsecond delta was below the
  roughly 0.9-1.4 ms request-time variance.

Repository-wide lint is not a valid clean-checkout signal in the current local workspace because it traverses an
unrelated nested worktree, generated integration-test artifacts, and a pre-existing OpenTracing indentation error.
Do not use that observation to waive focused lint or CI on subsequent changes.

## Read these files first

| File | Why it matters |
| --- | --- |
| [`integration-pipeline.js`](./integration-pipeline.js) | Compatibility implementation, JSDoc types, validation, lifecycle, stores, and exported helpers. |
| [`integration-pipeline.spec.js`](../../test/plugins/integration-pipeline.spec.js) | Compatibility contract for ordering, correlation, spanless operations, errors, no-op scopes, and validation. |
| [`source-registry.js`](../events/source-registry.js) | Process-wide source ownership, raw binding cardinality, and product contributor lifecycle. |
| [`registry.js`](../events/registry.js) | Per-tracer processor ownership and immutable package-source configuration. |
| [`database/integration.js`](../events/database/integration.js) | Database factory and process-wide package-lifecycle-to-semantic bridge. |
| [`database/processor.js`](../events/database/processor.js) | Shared database APM policy and stable source-consumer compilation. |
| [`database/query-lifecycle-adapter.js`](../events/database/query-lifecycle-adapter.js) | Fixed database-query-to-trace-manager lifecycle translation. |
| [`database/pool-acquire-lifecycle-adapter.js`](../events/database/pool-acquire-lifecycle-adapter.js) | Fixed pool-acquisition lifecycle and caller-context restoration. |
| [`messaging/integration.js`](../events/messaging/integration.js) | Messaging factory and process-wide package-lifecycle bridge. |
| [`messaging/processor.js`](../events/messaging/processor.js) | Shared producer/consumer tracing, filtering, propagation, and DSM policy. |
| [`messaging/lifecycle-adapter.js`](../events/messaging/lifecycle-adapter.js) | Fixed messaging-to-trace-manager lifecycle translation. |
| [`trace-manager.js`](../events/trace-manager.js) | Opaque per-tracer span ownership and exactly-once terminal operations. |
| [`INTEGRATION_PIPELINE_NOTES.md`](../../../datadog-plugin-bullmq/INTEGRATION_PIPELINE_NOTES.md) | Historical walkthrough of the earlier BullMQ compatibility-pipeline prototype. |
| [`INTEGRATION_PIPELINE_RATIONALE.md`](../../../datadog-plugin-bullmq/INTEGRATION_PIPELINE_RATIONALE.md) | Historical adoption argument and risk record that motivated the fixed framework. |
| [BullMQ plugin](../../../datadog-plugin-bullmq/src/index.js) | Thin producer/consumer declaration using the shared messaging factory. |
| [BullMQ producer source](../../../datadog-plugin-bullmq/src/producer.js) | Producer fact extraction and bounded carrier write-back. |
| [BullMQ consumer source](../../../datadog-plugin-bullmq/src/consumer.js) | Consumer fact and carrier extraction. |
| [Azure Cosmos plugin](../../../datadog-plugin-azure-cosmos/src/index.js) | Thin database-factory declaration. |
| [Azure Cosmos query source](../../../datadog-plugin-azure-cosmos/src/query-source.js) | Package-only Cosmos argument/result extraction and skip decisions. |
| [MariaDB plugin](../../../datadog-plugin-mariadb/src/index.js) | Thin query and pool-acquire declaration using the shared database factory. |
| [MariaDB query source](../../../datadog-plugin-mariadb/src/query-source.js) | MariaDB query normalization and processor-owned SQL write-back. |
| [MariaDB pool source](../../../datadog-plugin-mariadb/src/pool-acquire-source.js) | Pool-acquire facts and fixed connection-lifecycle channels. |
| [MariaDB instrumentation](../../../datadog-instrumentations/src/mariadb.js) | Version-specific v2/v3 lifecycle ownership and driver write-back. |
| [Orchestrion config index](../../../datadog-instrumentations/src/helpers/rewriter/instrumentations/index.js) | Registration point for source-rewriter definitions. |
| [Azure Cosmos benchmark](../../../../benchmark/sirun/plugin-azure-cosmos-pipeline/README.md) | Persistent baseline/candidate measurement for accepted, rejected, and inherited no-op paths. |
| [MariaDB benchmark](../../../../benchmark/sirun/plugin-mariadb-pipeline/README.md) | Persistent direct-query, pool-query-facts, and tracing-disabled measurement. |

Before changing an integration or its source match, read the relevant upstream library source for the oldest and
newest supported versions. Inspect the matched function, its callers, its result and error shapes, and sibling paths
that may publish the same logical operation.

## What the processor/adapter framework owns

Use the processor/adapter path when integrations in one semantic domain share a fixed lifecycle contract. The package
module extracts package facts; shared domain code owns tracing policy and span lifecycle:

```text
raw package lifecycle
  -> one process-wide package source bridge
  -> normalized package facts
  -> independent product contributors
  -> one domain processor per tracer
  -> fixed lifecycle adapter
  -> opaque per-tracer trace manager
```

Package sources may normalize package arguments/results and apply bounded updates returned by the processor. They
must not import tracer/plugin internals, create or finish spans, or own propagation, DSM, filtering, or tracing
policy. Lifecycle adapters are fixed domain code; package declarations provide source extraction and write-back
functions, not trace start/error/finish policy.

The process-wide source registry owns physical source cardinality. One bridge is active while any tracer consumer or
eligible product contributor needs that source, or while an observed operation still awaits its terminal phase. The
bridge publishes normalized event identity and package facts, never the raw argument list, to tracer consumers.
Product contributors receive a bounded product event and are snapshotted at start, preventing registration changes
from producing finish-without-start lifecycles.

The per-tracer domain registry owns one processor for each semantic operation, plus immutable configuration for every
package source consumed by that processor. The processor applies shared APM policy. Its lifecycle adapter translates
the domain contract into atomic trace-manager operations, and the trace manager privately correlates the shared event
identity with the span belonging to that tracer.

Database and messaging now demonstrate that package integrations can share fixed domain contracts without exposing
spans or lifecycle orchestration to package adapters. Treat that as the default shape: first identify the semantic
domain operation, then add the narrow source and lifecycle capabilities the domain needs. Do not encode an open-ended
stage engine inside a processor.

The compatibility `IntegrationPipeline` is retained for executable compatibility and historical experiments with
arbitrary stage composition. Raw stage arrays are compatibility-only. Introducing a new production caller requires a
documented reason that a fixed domain contract cannot express the lifecycle and an explicit architecture review.

## What the compatibility pipeline owns

This section is a compatibility reference, not the recommended authoring workflow for a new integration.

Instrumentation still observes library calls and publishes diagnostic-channel lifecycle events. The pipeline compiles
an integration definition into a plugin class and owns the common work after publication:

```text
source event
  -> normalize invocation
  -> extract start data
  -> gate operation
  -> select parent and reserve correlation IDs
  -> bind context store
  -> start span-independent stages
  -> optionally materialize and bind a span
  -> start tracing-dependent stages
  -> run the library function
  -> record errors and unwind error hooks
  -> extract completion data and apply result tags
  -> unwind completion hooks
  -> run base-class finalization and restore stores
```

An integration definition should contain integration-specific facts. It should not recreate subscriptions, async
storage, span cleanup, or source lifecycle routing.

## Compatibility definition reference

Do not start a new same-domain migration from this schema. Prefer `createDatabaseIntegration()` or
`createMessagingIntegration()` and extend their fixed contracts when the domain has a demonstrated shared need.

The top-level definition passed to `createIntegrationPlugin` has this shape:

```js
createIntegrationPlugin({
  id: 'integration-id',
  base: OutboundPlugin, // optional; defaults to TracingPlugin
  source,               // optional; defaults to the Orchestrion adapter
  configure,            // optional config transformation
  operations: [],       // required and non-empty
})
```

### `id`

The existing integration ID used by the plugin manager, configuration, telemetry, and integration tagging.

### `base`

An optional `TracingPlugin` subclass. The default is `TracingPlugin` itself.

Select the same semantic base as the legacy integration when that base has behavior the migration must retain. For
example, an HTTP client compatibility migration may select `OutboundPlugin` to preserve peer-service computation and
base-class `finish()` behavior.

The generated class overrides automatic trace subscriptions because the pipeline registers its own source channels.
Other constructor, `configure()`, `startSpan()`, and `finish()` behavior from the selected base still applies.

Do not select a base only to access a convenient internal method. Match the library type and preserve its complete
contract. A base must be `TracingPlugin` or a subclass; invalid bases fail definition validation.

### `source`

An optional source adapter with two methods:

```js
{
  channels (target) {
    return { start, end, asyncEnd, error }
  },
  invocation (message) {
    return normalizedInvocation
  },
}
```

The default adapter maps a target to Orchestrion channels:

```text
tracing:orchestrion:<target.module>:<target.name>:start
tracing:orchestrion:<target.module>:<target.name>:end
tracing:orchestrion:<target.module>:<target.name>:asyncEnd
tracing:orchestrion:<target.module>:<target.name>:error
```

The normalized invocation object must have an `arguments` array. Critically, the adapter must return the same object
identity for every lifecycle event belonging to one call. Pipeline state is held in a `WeakMap` keyed by that object;
returning a fresh wrapper for `error` or `asyncEnd` loses the state and leaks the operation lifecycle.

No non-Orchestrion source has been adopted yet. Add a new adapter only when a real integration requires it and pin its
identity and terminal-event contract in pipeline tests.

### `configure`

An optional function applied to non-boolean plugin configuration before the selected base is configured:

```js
configure: config => ({ ...config, compiledFilter: compileFilter(config) })
```

Boolean enable/disable calls bypass this transformation. Never allow user configuration callbacks to throw into an
instrumented application; catch and log integration-specific callback failures where they are invoked.

## Operation reference

Each operation describes one observed source function:

```js
{
  target: { module: '@example/client', name: 'Client_request' },
  lifecycle: 'async',
  extract: {
    start: {},
    complete: {},
  },
  when: frame => true,
  skip: 'parent',
  context: {
    parent: frame => undefined,
  },
  span: {},
  stages: [],
}
```

### `target`

Identifies the source event. With the default adapter, `module` and `name` must exactly match the Orchestrion module
and `channelName`. Duplicate targets in one definition are rejected.

### `lifecycle`

- `sync`: completion runs on `end`.
- `async`: promise/callback completion runs on `asyncEnd`. A synchronous failure may complete on `end` when the
  invocation already contains `error`.

The source instrumentation kind and operation lifecycle must agree. Orchestrion does not publish legacy `finish`.

### `extract.start`

A record of semantic field extractors or one whole-record extractor. With a record, each extractor receives
`(invocation, frame)`, and its return value is assigned immediately to `frame.data` under the same key:

```js
extract: {
  start: {
    request: argument(0),
    host: self('options', 'host'),
    resource: invocation => normalizeResource(invocation.arguments[0]),
  },
}
```

When several fields share parsing, traversal, or allocation, return the complete semantic data record in one call:

```js
extract: {
  start: invocation => {
    const request = invocation.arguments[0]
    const target = parseTarget(request.url)
    return {
      request,
      resource: target.resource,
      tags: target.tags,
    }
  },
}
```

The whole-record form becomes `frame.data` directly. It avoids an intermediate wrapper, an entry loop, and repeated
work, so prefer it when the fields are naturally computed together. Its contract is the complete start-data record;
it receives only `invocation` because no earlier `frame.data` exists yet.

Start extraction runs before `when`, parent selection, correlation allocation, stages, or span creation. Rejected
operations therefore pay extraction cost but do not reserve IDs or start product work.

Extractors currently execute in record insertion order, and later extractors can observe earlier `frame.data` fields.
Avoid depending on that ordering when the same values can be derived directly from the invocation; hidden ordering
dependencies make declarations harder to rearrange and review.

### `extract.complete`

Completion extraction accepts the same field-record form and may also be a function returning a record. Returned
completion fields are merged into the existing start data after `result` or `error` is available:

```js
extract: {
  complete: {
    status: result('status'),
  },
}
```

```js
extract: {
  complete: invocation => ({ status: invocation.result?.status }),
}
```

They run before `span.resultTags` and stage completion hooks.

### Extractor helpers

- `argument(index, ...path)` reads an argument and optional nested path.
- `self(...path)` reads the receiver and optional nested path.
- `result(...path)` reads the completed result and optional nested path.
- `field(name)` is a frame resolver returning `frame.data[name]`; it is not an invocation extractor by itself.

For example, this correctly extracts and then uses a resource:

```js
extract: {
  start: {
    resource: invocation => normalizeResource(invocation.arguments[0]),
  },
},
span: {
  name: 'example.request',
  resource: field('resource'),
},
```

If no extractor or stage assigns `frame.data.resource`, then `field('resource')` resolves to `undefined`.

### `when`

An early gate evaluated after start extraction. Returning `false` marks the operation as rejected.

A rejected operation:

- reserves no correlation context;
- starts no stages;
- creates no span;
- does not run completion extraction or result tags;
- still runs the original library call under the store selected by `skip`.

The gate must not reduce diagnostic-channel publication cardinality. Instrumentation should still publish once per
source call when AppSec, IAST, or another subscriber requires each invocation. The pipeline gate controls this
operation's work after publication; it is not a reason to move the instrumentation publish behind a dedupe gate.

### `skip`

Controls the legacy store for a rejected operation:

- `parent` or omitted: inherit the active legacy store.
- `noop`: bind `{ noop: true }`, suppressing nested legacy tracing.
- resolver: return either mode from the extracted frame.

The earlier Azure Cosmos compatibility-pipeline migration used a resolver because duplicate request-level hooks
needed to inherit their enclosing operation span, while empty-path account reads had to suppress their nested HTTP
span. The current package query source returns `{ skip: 'parent' }` or `{ skip: 'noop' }`; `DatabaseProcessor` maps
those fixed decisions directly without evaluating a second resolver.

`skip` is evaluated only for a rejected operation. Its frame has start-extracted data but no correlation context.

The current split between `when` and a resolved `skip` can evaluate the same predicate twice. A future combined gate
result may be cleaner, but do not change the contract without updating validation, lifecycle tests, both migrations,
and these documents.

### `context.parent`

Overrides parent selection. Parent precedence is:

1. explicitly declared `context.parent`;
2. correlation from the active `storage('context')` store;
3. span from the active `storage('legacy')` store.

Use this for extracted remote parents, as BullMQ consumer propagation does. Returning `null` explicitly requests a
root context. Returning `undefined` also creates a root context because an explicitly declared resolver suppresses the
normal active-context fallback; prefer `null` when that root intent should be obvious to a reviewer.

### `span`

Omit `span` for a correlation-only operation. When present, it supports:

```js
span: {
  enabled: frame => true,
  name: 'example.request',
  service: frame => frame.config.service,
  resource: field('resource'),
  type: 'custom',
  kind: 'client',
  tags: {
    'example.peer': field('peer'),
  },
  metrics: {
    'example.count': field('count'),
  },
  resultTags: {
    'example.status': field('status'),
  },
}
```

`tags`, `metrics`, and `resultTags` can instead be a function returning the complete record. This is the preferred
form when several fields come from one parsed object or when the integration already built a tag block during start
extraction:

```js
span: {
  name: 'example.request',
  tags: frame => frame.data.tags,
  resultTags: frame => buildResultTags(frame.invocation.result, frame.invocation.error),
}
```

Every field marked resolvable accepts either a literal or `frame => value`. Resolver functions are called without a
meaningful `this`; use only their frame argument.

- `enabled` is evaluated after span-independent stages start. When false, those stages still complete, but no span or
  tracing-dependent stage starts.
- `name` is required when `span` exists.
- `service`, `resource`, `type`, `kind`, `tags`, and `metrics` resolve when the span is materialized.
- Tag and metric entries resolving to `undefined` are omitted.
- `resultTags` resolves during completion, after `extract.complete`.

Definition records and block functions are compiled once when `createIntegrationPlugin()` runs. Do not add a
per-invocation map/filter pass when a block can be returned directly.

Do not add a raw span to the frame. Use `frame.trace.setTag()` for narrow annotation needs or design a new bounded
capability only after multiple integrations demonstrate the requirement.

### `stages`

This contract is compatibility-only. Processor/adapter integration declarations do not accept stage arrays.

A stage encapsulates product work:

```js
{
  name: 'trace-propagation',
  requires: ['tracing'],
  start (frame) {},
  error (frame) {},
  complete (frame) {},
}
```

Stages without `requires` start after correlation is bound and before span creation. Stages requiring `tracing` start
only after a recording span is materialized and bound in `storage('span')`.

Stages start in declaration order and unwind in reverse order. A started stage receives:

- `error` hooks in reverse order when the invocation fails;
- `complete` hooks in reverse order when terminal completion runs.

On a failed async operation, both `error` and later `complete` hooks may run. Hooks must tolerate that sequence. A
stage is recorded as started before its `start` hook is invoked, so its terminal hooks can still run if `start` throws.

Every stage hook is isolated by a catch-and-log boundary. A stage failure must not throw into the library or prevent
other stages and span cleanup from running.

Only the `tracing` requirement exists today. Unknown capabilities fail definition validation.

## The frame

One `PipelineFrame` is created for each accepted or rejected invocation prepared by the pipeline:

| Field | Contract |
| --- | --- |
| `invocation` | Normalized source data: `arguments`, `self`, and later `result` or `error`. |
| `data` | Per-invocation semantic values populated by extractors and integration code. |
| `correlation` | Reserved IDs and `inject(format, carrier)` for accepted operations. Undefined while gating a rejection. |
| `trace` | Narrow annotation capability. Tags are buffered until a span exists and discarded for permanently spanless calls. |
| `config` | Configured integration options after the optional definition transform. |
| `serviceName(options)` | Existing schema-aware service-name resolver. |
| `propagation.extract(format, carrier)` | Existing tracer propagation extraction. |
| `dataStreams.decode(carrier)` | Decode an incoming DSM pathway. |
| `dataStreams.setCheckpoint(tags, size)` | Create a DSM checkpoint using the operation's trace capability. |

The frame intentionally does not expose the plugin, tracer, raw span, or mutable invocation state. Internal state is
stored separately in a `WeakMap` and includes the selected parent, reserved span context, actual span, pending tags,
started stages, and lifecycle flags.

Do not confuse the frame with an Orchestrion `ctx`, JavaScript stack frame, or span. It is the integration-facing
workspace and capability boundary for one invocation.

## Store and lifecycle invariants

Start bindings execute in reverse registration order. The effective nesting is:

```text
storage('context')
  -> storage('legacy')
    -> storage('span')
      -> start subscribers
      -> original library function
```

- `storage('context')` carries span-independent correlation.
- `storage('legacy')` preserves existing tracer/plugin behavior during migration.
- `storage('span')` carries the recording span for tracing-dependent stages.

An inherited legacy `{ noop: true }` scope suppresses span creation and tracing stages, but accepted operations still
receive correlation and run span-independent stages. Store restoration is owned by diagnostic-channel binding.

The pipeline reserves a `DatadogSpanContext` before optional span creation. A later span adopts it exactly once, so IDs
observed or injected before tracing are the IDs recorded on the span.

Completion always deletes invocation state in a `finally` block. When a span exists, completion calls the selected
base's `finish(invocation)` rather than directly finishing the span. This preserves outbound/database finalization such
as peer-service tags.

## Reference migrations

### BullMQ

BullMQ demonstrates:

- a thin `createMessagingIntegration()` declaration with fixed produce and consume operations;
- package-only extraction for Queue, FlowProducer, and Worker calls;
- bounded propagation carrier write-back owned by producer sources;
- carrier extraction and cleanup owned by the consumer source;
- shared processor ownership of span shape, producer filters, remote-parent selection, propagation, and DSM;
- fixed lifecycle adapters and private, per-tracer span ownership;
- concurrent DSM pathway isolation inside the operation's bound store.

Read:

- [`src/index.js`](../../../datadog-plugin-bullmq/src/index.js)
- [`src/producer.js`](../../../datadog-plugin-bullmq/src/producer.js)
- [`src/consumer.js`](../../../datadog-plugin-bullmq/src/consumer.js)

### Azure Cosmos

Azure Cosmos demonstrates:

- a thin `createDatabaseIntegration()` declaration;
- package-only argument, result, and skip logic in `query-source.js`;
- one process-wide raw source bridge shared by independent product and APM consumers;
- one `DatabaseProcessor` per tracer using the fixed query lifecycle adapter and opaque trace manager;
- distinct span ownership and finalization when multiple tracers consume the same normalized event;
- preserved request-level dedupe, nested HTTP suppression, status tags, service naming, and peer-service behavior;
- source-boundary tests without exporting private helpers.

Read:

- [`src/index.js`](../../../datadog-plugin-azure-cosmos/src/index.js)
- [`src/query-source.js`](../../../datadog-plugin-azure-cosmos/src/query-source.js)
- [`test/get-resource.spec.js`](../../../datadog-plugin-azure-cosmos/test/get-resource.spec.js)
- [`test/index.spec.js`](../../../datadog-plugin-azure-cosmos/test/index.spec.js)

### MariaDB database lifecycles

MariaDB demonstrates:

- one explicit diagnostic-channel source descriptor using `start`, `error`, and `finish` channels;
- retained v2 callback/promise and v3 command wrappers because upstream completion is not a common method-return
  lifecycle;
- processor-owned DBM SQL injection written back to both string and object query inputs before driver execution;
- stable source-caller context restored around driver-owned completion callbacks;
- fixed pool-acquire and connection adapters preserving wait spans, lazy-pool growth, and internal no-op boundaries;
- no compatibility base or package-owned span lifecycle;
- one physical bridge per package source regardless of tracer count;
- preserved MariaDB span shape across minimum/current CJS versions and the latest ESM build.

Read:

- [`src/index.js`](../../../datadog-plugin-mariadb/src/index.js)
- [`src/query-source.js`](../../../datadog-plugin-mariadb/src/query-source.js)
- [`src/pool-acquire-source.js`](../../../datadog-plugin-mariadb/src/pool-acquire-source.js)
- [`test/query-source.spec.js`](../../../datadog-plugin-mariadb/test/query-source.spec.js)
- [`test/pool-acquire-source.spec.js`](../../../datadog-plugin-mariadb/test/pool-acquire-source.spec.js)
- [`test/index.spec.js`](../../../datadog-plugin-mariadb/test/index.spec.js)
- [`../datadog-instrumentations/src/mariadb.js`](../../../datadog-instrumentations/src/mariadb.js)

## Migration workflow

### 1. Establish the legacy behavior inventory

Read the existing instrumentation, plugin, tests, and upstream source. Record:

- source functions and supported versions;
- sync, promise, callback, iterator, and synchronous-throw behavior;
- span name, service, resource, type, kind, tags, metrics, and analytics;
- result and error tags;
- parent selection and propagation;
- DSM, AppSec, IAST, or other product work;
- filter, dedupe, recursion, and no-op rules;
- nested span behavior for accepted and rejected calls;
- selected base-class behavior;
- integration configuration and user callbacks;
- CJS, ESM, browser, or alternate build paths.

Do not migrate from memory. Compare at least the oldest and newest supported upstream versions.

### 2. Audit channel cardinality

Search every published channel and list all subscribers. Decide whether each subscriber needs once-per-call or
once-per-first-occurrence publication. Keep per-call publishers outside tracing-only dedupe gates when AppSec, IAST,
or another product depends on argument identity for every invocation.

### 3. Map source targets to operations

Use one operation per observed source target. Keep Orchestrion as the default when a source function can be matched
statically. Retain an existing diagnostic-channel wrapper when it owns a lifecycle that the matched function does not
expose, and document that limitation. MariaDB v3 commands, for example, complete through command `resolve` / `reject`
callbacks rather than the return value of `Command.start()`.

### 4. Separate package facts, product work, and lifecycle

For a processor/adapter migration, which is the default:

- keep package argument/result interpretation and source writeback in the package source;
- register product work as independent contributors over normalized facts;
- put shared semantic tracing policy in the domain processor;
- use a fixed lifecycle adapter and opaque trace manager for start, failure, completion, and exactly-once cleanup.

When maintaining an existing compatibility-pipeline caller, keep argument/result interpretation in extractors and
ordinary helpers, product work in stages, and lifecycle orchestration in the pipeline. Do not add a new caller merely
because the compatibility schema can express the operation.

### 5. Preserve the semantic base

If an incremental migration still needs a compatibility base for behavior outside the migrated slice, select it only
when the legacy plugin depends on its `configure`, `startSpan`, or `finish` behavior. Test the observable behavior
supplied by that base; inheritance alone is not proof of compatibility, and remove the base once fixed adapters own
the remaining behavior.

For a processor, retain that policy in the shared domain implementation. Database processors extend `DatabasePlugin`
for naming and peer-service behavior, and the trace manager calls the narrow `finishSpan()` boundary on the processor
that created the span. This preserves per-tracer finalization without exposing spans through package adapters.

### 6. Test the real boundary

Prefer actual library calls against the mock agent or a real service/emulator. For declaration-only cases, drive the
real source channel through `dc.tracingChannel` and assert emitted spans and active stores. Do not export helpers or
construct fake plugin prototypes only to make internal logic reachable.

At minimum cover:

- successful completion;
- synchronous throw or promise rejection, as applicable;
- completion result tags;
- the last accepted and first rejected boundary of every gate;
- every sibling path sharing the gate;
- parent versus no-op rejected behavior;
- selected base-class behavior such as service naming or peer service;
- context and store restoration;
- oldest and newest supported package versions;
- CJS and ESM builds;
- important changed production lines with scoped coverage.

### 7. Run CI-equivalent verification

Unset externally configured OTLP exporters before span-asserting plugin tests:

```bash
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
```

Run the shared source, registry, trace-manager, and relevant domain contracts:

```bash
./node_modules/.bin/mocha \
  packages/dd-trace/test/events/source-registry.spec.js \
  packages/dd-trace/test/events/registry.spec.js \
  packages/dd-trace/test/events/trace-manager.spec.js \
  "packages/dd-trace/test/events/<domain>/*.spec.js"
```

Run `packages/dd-trace/test/plugins/integration-pipeline.spec.js` only when changing the compatibility compiler or its
contract.

Run plugin CI:

```bash
PLUGINS="<name>" npm run test:plugins:ci
```

For services:

```bash
docker compose up -d <service>
PLUGINS="<name>" SERVICES="<service>" npm run test:plugins:ci
```

Azure Cosmos currently uses:

```bash
docker compose up -d azurite azurecosmosemulator
PLUGINS="azure-cosmos" \
SERVICES="azurite,azurecosmosemulator" \
NODE_OPTIONS="--experimental-global-webcrypto" \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
npm run test:plugins:ci
```

Use Colima when Docker is unavailable locally. Wait for `http://127.0.0.1:8080/ready` before running Cosmos tests.

Run scoped coverage over every changed production path, for example:

```bash
./node_modules/.bin/nyc \
  --include "packages/dd-trace/src/events/<domain>/**/*.js" \
  --include packages/datadog-plugin-<name>/src/**/*.js \
  ./node_modules/.bin/mocha \
  "packages/dd-trace/test/events/<domain>/*.spec.js" \
  packages/datadog-plugin-<name>/test/**/*.spec.js
```

Run focused ESLint and `git diff --check`. Repository-wide lint can traverse ignored local worktrees or generated
fixtures in a developer checkout; focused lint must still pass, and CI remains the authority for a clean checkout.

## Rules for extending the frameworks

Do not add a framework concept merely to shorten one migration. Before extending a contract:

1. Identify the concrete integration behavior the current model cannot express.
2. Check whether a second integration has the same need.
3. Prefer a narrow capability over exposing a plugin, tracer, span, or mutable state.
4. Preserve source independence in the lifecycle engine.
5. Add definition validation for invalid combinations.
6. Add direct boundary tests for ordering, errors, cleanup, no-op scopes, and restoration.
7. Update this guide, the mechanical notes, and the rationale.
8. Re-run every affected domain contract and its BullMQ, Azure Cosmos, or MariaDB regression suite.

Architecture changes must be scored against drift prevention, module coupling, explicit contracts, boundary
testability, extensibility, and hot-path fitness. Compare the existing design with the proposal; do not assign scores
only to the new design.

Never add a public method, export, getter, or mutable field solely for tests. Never make production behavior conform to
a fake test path that cannot occur through instrumentation and the plugin manager.

## Known limitations and open work

- Domain processors still extend existing tracing plugin bases. Tracing is not yet an independently loadable
  processor capability, although package sources and lifecycle adapters do not receive spans.
- `storage('legacy')` remains a migration bridge in the processor framework and compatibility engine.
- Only the `tracing` compatibility-stage requirement exists.
- MariaDB proves an explicit diagnostic-channel package source. It deliberately retains version-specific wrappers;
  the framework does not yet generate or replace imperative source instrumentation.
- The compatibility operation model explicitly distinguishes only `sync` and `async`; unusual callback, iterator, or
  streaming ownership may require source or lifecycle work.
- Compatibility `frame.data` is intentionally flexible but weakly typed across integration-specific fields.
- Compatibility `when` and resolved `skip` are separate and may repeat a gate computation.
- Priority sampling can still require a materialized span, so processor-owned BullMQ propagation remains bound to a
  traced operation.
- Globally disabled tracing still selects a no-op tracer that cannot reserve normal unique correlation contexts.
- The Azure Cosmos processor/adapter benchmark retains an isolated accepted-path cost of roughly 173 ns, about 14%,
  versus the compatibility pipeline. Duplicate rejection is materially faster, while empty-path and inherited-noop
  paths remain near parity. Real SDK/emulator trials cannot resolve that delta against roughly millisecond requests.
  See `benchmark/sirun/plugin-azure-cosmos-pipeline` and keep measuring before adopting the framework in much hotter
  integrations.
- The MariaDB benchmark adds roughly 94 ns for direct queries and 151 ns for pool-query facts versus its legacy
  plugin. The tracing-disabled source path remains effectively free. See `benchmark/sirun/plugin-mariadb-pipeline`;
  pool acquisition and connection lifecycle costs remain outside that query-slice measurement.
- The contributor registry contract is tested, including contributor-only source activation and APM composition, but
  no production non-APM contributor has migrated to it yet.
- The compatibility engine has no production callers, but removal is deferred while its low-level lifecycle contract
  remains useful to the experiment. New production use requires explicit architecture review.

The Azure and MariaDB benchmarks cover accepted, rejected/no-op, direct/pool-query-facts, and tracing-disabled paths.
Add equivalent persistent measurements for BullMQ and simple synchronous integrations before broad adoption. Warm up
for roughly one second, run at least five trials, and reproduce results in a fresh shell.

## Completion checklist

An agent should not declare a migration complete until all of the following are true:

- upstream source for supported boundary versions was inspected;
- one or two same-type reference integrations were read;
- every source target and build format is instrumented;
- channel subscriber cardinality was audited;
- processor/adapter sources have one physical raw binding regardless of tracer count;
- independent APM and product consumers compose correctly, including product-only source activation;
- legacy span shape, errors, propagation, DSM, and configuration are preserved;
- selected base-class behavior is asserted through observable output;
- every gate includes accepted, rejected, and sibling cases;
- no-op and parent inheritance behavior is pinned;
- source-boundary or real-library tests replace internal helper tests;
- focused engine and plugin tests pass;
- oldest/newest and ESM tests pass;
- scoped coverage includes important changed production lines;
- focused lint and `git diff --check` pass;
- shared lifecycle changes were regression-tested against BullMQ, Azure Cosmos, and MariaDB;
- notes and rationale reflect any new engine contract or remaining limitation.
