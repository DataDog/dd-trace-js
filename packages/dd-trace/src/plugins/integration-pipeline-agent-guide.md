# IntegrationPipeline agent guide

This is the implementation and migration guide for agents continuing the experimental `IntegrationPipeline` work.
It is intentionally more prescriptive than the design notes: it documents the current executable contract, the
invariants migrations must preserve, and the checks required before changing or adopting the pipeline.

The pipeline is internal and experimental. It is not a public API, and its declaration shape may still change.

## Current checkpoint (2026-08-17)

At this checkpoint, branch `pabloerhard/feat-new-orchestrion-pipeline` has reached this implementation state:

- BullMQ is the first full pipeline migration and exercises producer, consumer, propagation, and DSM stages.
- Azure Cosmos is migrated to one async pipeline operation while retaining `DatabasePlugin` as its semantic base.
- The engine accepts a `TracingPlugin` subclass through `base`, evaluates `skip` as a literal or frame resolver, and
  completes materialized spans through the selected base class's `finish()` method.
- Correlation context is reserved before optional span materialization. The materialized span adopts the same context,
  preserving IDs exposed to span-independent stages.
- The compiler installs context/span stores only for operations whose stages need them. Frames, correlation strings,
  capability blocks, stage arrays, and retained state are lazy or omitted on paths that do not use them.
- Start/completion extraction and span tag records support coarse whole-record functions, letting integrations compute
  shared semantic facts once instead of assembling them through many resolver calls.
- Azure Cosmos preserves request-level deduplication, empty-path account-read suppression, service naming, resource and
  response tags, error handling, analytics, peer-service behavior, and CJS/ESM coverage.

Verification completed at this checkpoint:

- focused pipeline and Azure Cosmos tests: 21 passing;
- Azure Cosmos CI-equivalent matrix against `@azure/cosmos` 4.4.1 and 4.10.0, including ESM: 22 passing;
- BullMQ regression matrix after shared compiler optimization: 126 passing;
- Azure Cosmos changed production source: 100% line coverage;
- focused ESLint and `git diff --check`: passing.
- optimized Azure microbenchmark: 1,368 ns accepted, 251 ns duplicate rejection, 295 ns empty-path rejection, and
  74 ns inherited no-op; the respective exact legacy medians are 1,048, 231, 270, and 77 ns.
- real SDK/emulator trials found no detectable request-level difference; the sub-microsecond delta was below the
  roughly 0.9-1.4 ms request-time variance.

Repository-wide lint is not a valid clean-checkout signal in the current local workspace because it traverses an
unrelated nested worktree, generated integration-test artifacts, and a pre-existing OpenTracing indentation error.
Do not use that observation to waive focused lint or CI on subsequent changes.

## Read these files first

| File | Why it matters |
| --- | --- |
| [`integration-pipeline.js`](./integration-pipeline.js) | Authoritative implementation, JSDoc types, validation, lifecycle, stores, and exported helpers. |
| [`integration-pipeline.spec.js`](../../test/plugins/integration-pipeline.spec.js) | Executable contract for ordering, correlation, spanless operations, errors, no-op scopes, and validation. |
| [`stages/code-origin.js`](./stages/code-origin.js) | Shared exit code-origin capability. |
| [`stages/messaging.js`](./stages/messaging.js) | Shared propagation and Data Streams capability. Read before hand-writing either in a plugin. |
| [`stages/messaging.spec.js`](../../test/plugins/stages/messaging.spec.js) | Executable contract for edge tags, carrier sharing, batching, gating, and inbound decode ordering. |
| [`INTEGRATION_PIPELINE_NOTES.md`](../../../datadog-plugin-bullmq/INTEGRATION_PIPELINE_NOTES.md) | Mechanical walkthrough using BullMQ and Azure Cosmos. |
| [`INTEGRATION_PIPELINE_RATIONALE.md`](../../../datadog-plugin-bullmq/INTEGRATION_PIPELINE_RATIONALE.md) | Adoption argument, architecture score, risks, and rollout criteria. |
| [BullMQ plugin](../../../datadog-plugin-bullmq/src/index.js) | Messaging integration using multiple operations and product stages. |
| [Azure Cosmos plugin](../../../datadog-plugin-azure-cosmos/src/index.js) | Database integration using a compatibility base and a resolved skip mode. |
| [Orchestrion config index](../../../datadog-instrumentations/src/helpers/rewriter/instrumentations/index.js) | Registration point for source-rewriter definitions. |
| [Azure Cosmos benchmark](../../../../benchmark/sirun/plugin-azure-cosmos-pipeline/README.md) | Persistent baseline/candidate measurement for accepted, rejected, and inherited no-op paths. |

Before changing an integration or its Orchestrion match, read the relevant upstream library source for the oldest and
newest supported versions. Inspect the matched function, its callers, its result and error shapes, and sibling paths
that may publish the same logical operation.

## What the pipeline owns

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

## Definition reference

The top-level definition passed to `createIntegrationPlugin` has this shape:

```js
createIntegrationPlugin({
  id: 'integration-id',
  base: DatabasePlugin, // optional; defaults to TracingPlugin
  source,               // optional; defaults to the Orchestrion adapter
  configure,            // optional config transformation
  operations: [],       // required and non-empty
})
```

### `id`

The existing integration ID used by the plugin manager, configuration, telemetry, and integration tagging.

### `base`

An optional `TracingPlugin` subclass. The default is `TracingPlugin` itself.

Select the same semantic base as the legacy integration when that base has behavior the migration must retain. Azure
Cosmos selects `DatabasePlugin`, which preserves storage service naming, peer-service computation, code-origin exit
tags, database configuration, and base-class `finish()` behavior.

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
    parent: frame => null,
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

Azure Cosmos uses a resolver because duplicate request-level hooks should inherit their enclosing operation span,
while empty-path account reads must suppress their nested HTTP span.

`skip` is evaluated only for a rejected operation. Its frame has start-extracted data but no correlation context.

The current split between `when` and a resolved `skip` can evaluate the same predicate twice. A future combined gate
result may be cleaner, but do not change the contract without updating validation, lifecycle tests, both migrations,
and these documents.

### `context.parent`

Overrides parent selection. Parent precedence is:

1. explicitly declared `context.parent`;
2. correlation from the active `storage('context')` store;
3. span from the active `storage('legacy')` store.

Use this for extracted remote parents, as BullMQ consumer propagation does. Returning `undefined` falls back to the
active context. Returning `null` explicitly requests a root context.

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

### Shared capability stages

Do not hand-write a stage for behavior another integration already needs. Two shared stages exist:

| Stage | Import | Shape |
| --- | --- | --- |
| `exitCodeOrigin` | `plugins/stages/code-origin` | Nullary. Declared by naming it; takes no parameters. |
| `createMessagingStage(descriptor)` | `plugins/stages/messaging` | Parameterized by where the library keeps its messages. |

`exitCodeOrigin` is the model for a reusable stage: it binds to nothing library-specific, so all three BullMQ producer
operations share the same object. A stage that needs to bind to library data cannot be shared that way, which is what
`createMessagingStage` exists to solve.

```js
createMessagingStage({
  direction: 'out',              // 'out' injects and encodes; 'in' decodes
  system: 'bullmq',              // Data Streams `type` tag
  topic: field('queueName'),     // (frame) => string
  messages: frame => [...],      // (frame) => unknown[] | undefined
  carrier: newCarrier,           // (message, frame) => object | undefined
  commit: commitCarrier,         // optional (message, carrier, frame) => void
  payload: job => job.data,      // optional (message, frame) => unknown, for DSM sizing
})
```

The descriptor answers only the library-specific questions: which messages does this invocation handle, where does each
one carry its Datadog fields, and what sizes its payload. The stage owns everything neither the library nor the
integration should decide — the edge-tag format, the pathway encoding, the `dsmEnabled` gate, the ordering of injection
against encoding, and the fact that both write one shared carrier per message.

`carrier` may return a live reference the stage mutates in place (a header map, no `commit` needed) or a detached object
the integration merges back in `commit` (a serialized envelope). Either way the carrier is read or written exactly once
per message, so a fused stage costs one JSON round trip where two separate stages cost two.

### When a capability earns a shared stage

A shared, parameterized stage is justified when two or more of these hold. Otherwise write a plain stage local to the
integration and wait for a second consumer.

- Two capabilities consume the same per-operation input, so that input has to be hoisted above both.
- It encodes a Datadog-owned format or spec rather than library semantics.
- It has an ordering constraint against another capability that no per-author array can enforce.
- Its gate is tracer configuration rather than library state.

Propagation and Data Streams hit all four, which is why they are one stage instead of six. `exitCodeOrigin` hits none,
which is why it stays a bare object.

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

- multiple operations in one definition;
- producer and consumer span shapes;
- configuration transformation for producer filters;
- extracted remote-parent selection;
- four operations sharing one `createMessagingStage` capability through per-operation descriptors;
- single, batched, and flow-node message sets expressed as `messages` accessors rather than separate stages;
- argument mutation through `frame.invocation.arguments`;
- correlation and span IDs remaining identical.

Read:

- [`src/index.js`](../../../datadog-plugin-bullmq/src/index.js)
- [`src/producer.js`](../../../datadog-plugin-bullmq/src/producer.js)
- [`src/consumer.js`](../../../datadog-plugin-bullmq/src/consumer.js)

### Azure Cosmos

Azure Cosmos demonstrates:

- one async database operation;
- selecting `DatabasePlugin` as a compatibility base;
- response and error fields through `resultTags`;
- a resolved skip mode;
- preserving request-level dedupe and nested HTTP suppression;
- source-boundary tests without exporting private helpers.

Read:

- [`src/index.js`](../../../datadog-plugin-azure-cosmos/src/index.js)
- [`test/get-resource.spec.js`](../../../datadog-plugin-azure-cosmos/test/get-resource.spec.js)
- [`test/index.spec.js`](../../../datadog-plugin-azure-cosmos/test/index.spec.js)

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

Use one operation per observed source target. Keep Orchestrion as the default. If an existing source function can be
matched statically, do not replace it with shimmer. When shimmer is unavoidable, document the concrete limitation.

### 4. Separate semantic extraction from lifecycle

Put argument/result interpretation in extractors and ordinary helper functions. Put product work in stages. Keep
subscription, state, stores, errors, completion, and span finishing in the pipeline.

### 5. Preserve semantic behavior

Represent operation-specific behavior as reusable stages when it does not require a different lifecycle. For example,
producer operations use the standard `exitCodeOrigin` stage instead of inheriting the outbound plugin hierarchy.
Test the observable behavior supplied by the stage; its presence in a declaration is not proof of compatibility.

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
- selected standard-stage behavior such as code-origin tagging;
- context and store restoration;
- oldest and newest supported package versions;
- CJS and ESM builds;
- important changed production lines with scoped coverage.

### 7. Run CI-equivalent verification

Unset externally configured OTLP exporters before span-asserting plugin tests:

```bash
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
```

Run the focused engine contract:

```bash
./node_modules/.bin/mocha packages/dd-trace/test/plugins/integration-pipeline.spec.js
```

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
  --include packages/dd-trace/src/plugins/integration-pipeline.js \
  --include packages/datadog-plugin-<name>/src/**/*.js \
  ./node_modules/.bin/mocha \
  packages/dd-trace/test/plugins/integration-pipeline.spec.js \
  packages/datadog-plugin-<name>/test/**/*.spec.js
```

Run focused ESLint and `git diff --check`. Repository-wide lint can traverse ignored local worktrees or generated
fixtures in a developer checkout; focused lint must still pass, and CI remains the authority for a clean checkout.

## Rules for extending the engine

Do not add an engine concept merely to shorten one migration. Before extending the contract:

1. Identify the concrete integration behavior the current model cannot express.
2. Check whether a second integration has the same need.
3. Prefer a narrow capability over exposing a plugin, tracer, span, or mutable state.
4. Preserve source independence in the lifecycle engine.
5. Add definition validation for invalid combinations.
6. Add direct pipeline tests for ordering, errors, cleanup, no-op scopes, and restoration.
7. Update this guide, the mechanical notes, and the rationale.
8. Re-run BullMQ and Azure Cosmos CI when the shared lifecycle changes.

Architecture changes must be scored against drift prevention, module coupling, explicit contracts, boundary
testability, extensibility, and hot-path fitness. Compare the existing design with the proposal; do not assign scores
only to the new design.

Never add a public method, export, getter, or mutable field solely for tests. Never make production behavior conform to
a fake test path that cannot occur through instrumentation and the plugin manager.

## Known limitations and open work

- The generated plugin still extends `TracingPlugin`, directly or through a compatibility base. Tracing is not an
  independently loadable pipeline capability.
- `storage('legacy')` remains a compatibility bridge.
- Only the `tracing` stage requirement exists.
- No non-Orchestrion source adapter has been proven.
- The operation model explicitly distinguishes only `sync` and `async`; unusual callback, iterator, or streaming
  ownership may require source or lifecycle work.
- `frame.data` is intentionally flexible but weakly typed across integration-specific fields.
- `when` and resolved `skip` are separate and may repeat a gate computation.
- Priority sampling can still require a materialized span, so BullMQ propagation remains tracing-dependent.
- Globally disabled tracing still selects a no-op tracer that cannot reserve normal unique correlation contexts.
- The optimized Azure Cosmos benchmark still shows a 31% isolated accepted-path regression (about 320 ns), while
  explicit rejections are 9-10% slower (20-25 ns) and inherited no-op is at parity. Real SDK/emulator trials cannot
  resolve that delta against roughly millisecond requests. See `benchmark/sirun/plugin-azure-cosmos-pipeline` and
  keep measuring before adopting the engine in much hotter integrations.
- `createMessagingStage` is shared across BullMQ's four operations but has only one integration as a consumer. Its
  descriptor shape is not frozen; confirm or correct it against a header-map carrier (kafkajs or amqplib) before
  promoting propagation and Data Streams to declarative operation keywords alongside `span`.
- Azure Cosmos shares no product stage with BullMQ, so no capability is yet proven across integration types.
- Compatibility removal criteria for the legacy store and base-class bridge are not defined.

The Azure benchmark covers accepted, rejected, and inherited no-op paths plus a one-off real emulator comparison. Add
equivalent persistent measurements for BullMQ, simple synchronous integrations, and globally disabled tracing before
broad adoption. Warm up for roughly one second, run at least five trials, and reproduce results in a fresh shell.

## Completion checklist

An agent should not declare a migration complete until all of the following are true:

- upstream source for supported boundary versions was inspected;
- one or two same-type reference integrations were read;
- every source target and build format is instrumented;
- channel subscriber cardinality was audited;
- legacy span shape, errors, propagation, DSM, and configuration are preserved;
- selected base-class behavior is asserted through observable output;
- every gate includes accepted, rejected, and sibling cases;
- no-op and parent inheritance behavior is pinned;
- source-boundary or real-library tests replace internal helper tests;
- focused engine and plugin tests pass;
- oldest/newest and ESM tests pass;
- scoped coverage includes important changed production lines;
- focused lint and `git diff --check` pass;
- shared lifecycle changes were regression-tested against BullMQ and Azure Cosmos;
- notes and rationale reflect any new engine contract or remaining limitation.
