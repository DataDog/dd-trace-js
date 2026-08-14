# BullMQ Orchestrion pipeline notes

This is an informal explanation of the pipeline experiment and why the BullMQ integration is easier to reason about
after the migration. It is not intended to define a public API or promise that this exact pipeline shape is final.

## The short version

The old and new designs both use diagnostic channels as the transport between instrumentation and tracing. Pub/sub
was not the part we replaced.

What changed is the code on the plugin side:

- Before, each instrumented BullMQ method had a plugin class that manually interpreted Orchestrion's context,
  created and finished a span, injected propagation, and handled DSM.
- Now, BullMQ declares the operations, fields, span metadata, filters, and optional stages. A shared pipeline owns the
  Orchestrion lifecycle and executes those declarations consistently.

In other words, the old design says, "Here are several event handlers; make sure they cooperate." The new design
says, "Here is an operation and the work it needs at each phase; the pipeline will run it correctly."

## What did not change

There are still two layers:

```text
BullMQ source
    |
    | rewritten by Orchestrion
    v
standard diagnostic-channel lifecycle
    |
    | tracing:orchestrion:bullmq:<target>:start/error/end/asyncEnd
    v
BullMQ tracing integration
```

Orchestrion still wraps the selected BullMQ source functions. The wrapper still provides a canonical context containing
values such as:

```js
{
  arguments, // the actual call arguments
  self,      // the BullMQ Queue, Worker, or FlowProducer instance
  result,    // present at completion
  error,     // present on failure
}
```

Diagnostic channels still provide decoupling: the instrumentation knows nothing about spans, DSM, filtering, or
Datadog propagation. It only reports the lifecycle of the original function.

## The old BullMQ plugin

Previously, `src/index.js` exported a `CompositePlugin` containing four plugin classes:

```text
BullmqPlugin (CompositePlugin)
├── QueueAddPlugin (ProducerPlugin)
├── QueueAddBulkPlugin (ProducerPlugin)
├── FlowProducerAddPlugin (ProducerPlugin)
└── BullmqConsumerPlugin (ConsumerPlugin)
```

Each class subscribed to one Orchestrion channel prefix. The producer classes shared an intermediate base class and
implemented methods such as:

```js
bindStart(ctx)             // filter, start span, inject propagation, return span store
start(ctx)                 // create DSM checkpoint
asyncEnd(ctx)              // finish span
shouldInstrument(ctx)      // interpret operation-specific arguments
getSpanData(ctx)           // calculate resource and tags
injectTraceContext(...)    // mutate BullMQ telemetry metadata
getDsmData(ctx)            // calculate queue and payload information
```

This worked, but the lifecycle was spread across inheritance, convention-based method names, and repeated context
interpretation. Understanding `Queue.addBulk()` required following this path:

```text
CompositePlugin
  -> QueueAddBulkPlugin
    -> BaseBullmqProducerPlugin
      -> ProducerPlugin
        -> TracingPlugin
          -> Plugin
```

The implementation also had to remember several implicit rules:

- `bindStart` must return the store created by `startSpan`.
- Filtering must happen before span creation.
- A filtered operation must return a `{ noop: true }` store so nested tracing is suppressed.
- The DSM `start` subscriber must run after the span store has been installed.
- Promise spans finish on `asyncEnd`, not `end`.
- Errors are reported before completion but must not finish the span twice.
- Bulk filtering, propagation, and DSM must all use the same selected job list.

None of these rules is individually difficult. The problem is that every plugin author has to reproduce the full set
correctly, and slightly different implementations naturally drift over time.

## The new pipeline

`src/index.js` now creates one generated plugin from one integration definition:

```js
createOrchestrionPlugin({
  id: 'bullmq',
  configure: normalizeBullmqConfig,
  operations: [
    queueAdd,
    queueAddBulk,
    flowProducerAdd,
    workerCallProcessJob,
  ],
})
```

The generated class still extends `TracingPlugin`, so the existing plugin manager does not need to know that BullMQ
uses a pipeline. The generated class is a compatibility adapter between the new declaration and the current plugin
system.

An operation declaration has four main parts:

```js
{
  target: { module: 'bullmq', name: 'Queue_add' },
  lifecycle: 'async',

  extract: {
    start: {
      name: argument(0),
      data: argument(1),
      queueName: context => context.self?.name || 'bullmq',
    },
  },

  when: frame => shouldInstrument(frame, ...),

  span: {
    name: 'bullmq.add',
    resource: field('queueName'),
    type: 'messaging',
    kind: 'producer',
    tags: { ... },
  },

  stages: [tracePropagation, dataStreams],
}
```

The declaration describes what is different about this operation. The pipeline supplies what should be identical for
all Orchestrion integrations.

## A `Queue.add()` call, step by step

Suppose application code runs:

```js
await queue.add('send-email', { recipient: 'someone@example.com' })
```

### 1. Orchestrion publishes `start`

The rewritten BullMQ method creates its context and runs the stores attached to:

```text
tracing:orchestrion:bullmq:Queue_add:start
```

The pipeline's store binding receives the context before the original method body proceeds.

### 2. The pipeline creates a frame

The frame is the pipeline's normalized, per-invocation state:

```js
{
  context, // canonical Orchestrion context
  data,    // extracted semantic fields
  span,
  config,
  tracer,
  plugin,
}
```

It is stored in a `WeakMap` keyed by the Orchestrion context. Later `error` and `asyncEnd` events carry the same
context, so they retrieve the correct frame without adding BullMQ-specific properties to the context.

For this call, extraction produces data roughly like:

```js
{
  name: 'send-email',
  data: { recipient: 'someone@example.com' },
  opts: undefined,
  queueName: 'email-queue',
}
```

This is the semantic boundary. Code after extraction can refer to `queueName` without repeatedly knowing that it came
from `context.self.name` for this particular BullMQ method.

### 3. The gate decides whether to trace

The operation's `when` function applies `producerFilter`, if configured. If it rejects the operation, the pipeline does
not create a span and returns a no-op store. This preserves the old behavior that prevents lower-level instrumentation
from creating an unexpected trace for a deliberately filtered publish.

The pipeline owns the ordering: extraction always precedes the gate, and the gate always precedes span creation.

### 4. The pipeline creates and binds the span

The span declaration resolves literals and functions against the frame. It produces the same BullMQ span fields as
before, including the messaging service naming schema, resource, kind, type, and tags.

The new span store is returned from the diagnostic-channel store binding. `runStores()` installs it as the active
async context.

This boundary is important: the pipeline does not run the start stages inside the binding transform. It runs them in a
`start` subscriber after the store has been installed. DSM and any other stage therefore see the new span as the active
span, including when several jobs are interleaved concurrently.

### 5. Start stages add capabilities

BullMQ's producer stages run in declaration order:

```text
trace propagation
    -> inject trace carrier into opts.telemetry.metadata

data streams
    -> create producer checkpoint
    -> encode pathway context into the same metadata
```

The pipeline does not contain BullMQ propagation or DSM logic. It only guarantees when stages run and what frame they
receive.

Stages make cross-cutting capabilities composable without hiding the operation behind another inheritance layer. An
integration that does not need DSM simply does not declare that stage.

### 6. BullMQ executes normally

The original BullMQ function runs with the possibly augmented options argument. Orchestrion observes its returned
promise without the plugin manually wrapping it.

### 7. Errors are recorded

If the promise rejects, Orchestrion publishes `error`. The pipeline retrieves the frame, adds the error to that frame's
span, and invokes error stages in reverse order.

The span is not finished at this point because completion still follows. This avoids lifecycle code having to guess
whether an error event is terminal.

### 8. The async operation completes

Orchestrion publishes `asyncEnd`. The pipeline:

1. extracts any completion fields;
2. applies result tags;
3. unwinds completion stages in reverse order;
4. removes the frame;
5. finishes the span exactly once.

For synchronous declarations, the same completion work happens on `end`. The integration author selects the lifecycle
in the declaration instead of implementing a differently named finish handler.

## Why stages unwind in reverse order

Start stages run in declaration order, while error and completion stages run in reverse order:

```text
start:     propagation -> DSM -> another capability
complete:  another capability -> DSM -> propagation
```

This gives stages stack-like semantics. A capability can set something up during `start` and reliably tear it down
around all capabilities declared after it. BullMQ's current stages only need start behavior, but the contract supports
capabilities that need all phases.

## How `Queue.addBulk()` benefits

Bulk publishing is where the shared frame is especially useful. The integration extracts the allowed job list once:

```text
raw jobs
  -> apply producerFilter once per job
  -> store allowed jobs in frame.data.jobs
```

The gate, trace propagation stage, and DSM stage all consume that same list. There is no symbol cache attached to the
Orchestrion context and no risk that one part of the plugin independently recalculates a different selection.

The raw list is retained separately because the span's `messaging.batch.message_count` describes the original call,
while propagation and DSM apply only to allowed jobs.

## How the consumer differs

`Worker.callProcessJob()` uses the same pipeline with a different declaration:

- extraction reads the job and queue name;
- extraction removes the Datadog carrier from BullMQ metadata;
- `span.childOf` extracts the remote parent from that carrier;
- the span is declared as a messaging consumer;
- the DSM stage decodes the incoming pathway and creates its consumer checkpoint.

The pipeline itself has no producer/consumer special case. Those differences are data in the span declaration and
behavior in the selected stages.

## Configuration

The integration definition can provide one configuration normalizer. BullMQ uses it to validate and resolve
`producerFilter` once when the plugin is configured.

Boolean configuration still passes through unchanged so the existing plugin manager can enable or disable the
generated plugin. This matters because plugin handler failures use the same disable mechanism as legacy plugins.

## Side-by-side responsibility comparison

| Concern | Old BullMQ plugin | New pipeline design |
| --- | --- | --- |
| Channel transport | Diagnostic channels | Diagnostic channels |
| Hooking BullMQ source | Orchestrion | Orchestrion |
| Channel subscription | Convention across four classes | Compiled from four operation targets |
| Context interpretation | Repeated in plugin methods | Start/completion extraction declarations |
| Span lifecycle | `bindStart`, `error`, `asyncEnd` methods | Shared pipeline lifecycle |
| Filtering order | Manually implemented by producers | Extract → gate → span is enforced |
| Filtered child suppression | Manual `{ noop: true }` return | Declarative `skip: 'noop'` |
| Async context activation | Relies on handler conventions | Start stages explicitly run after binding |
| Span fields | Built imperatively | Span declaration |
| Trace propagation | Overridden producer methods | Reusable start stage |
| DSM | Base/subclass methods | Reusable producer/consumer stages |
| Bulk shared state | Symbols and context mutations | Semantic fields on one invocation frame |
| Service naming | Inherited from producer/consumer classes | Explicit resolver using the same schema |
| Completion order | Implemented by every plugin class | Centralized and consistent |

## What this improves

The main benefit is not fewer lines by itself. It is a smaller space of valid implementations.

An integration author can still write a bad extractor or an incorrect tag, but they no longer need to independently
implement the mechanics of store binding, error ordering, async completion, frame cleanup, or finishing exactly once.
Those mechanics are centralized and tested at the pipeline boundary.

That also makes the integration easier for an AI system to modify. The operation target, inputs, span fields, gate, and
capabilities are visible together. Adding a tag does not require inferring which base class method should be overridden,
and adding a capability does not require another layer in the class hierarchy.

## Trade-offs and open questions

The pipeline is still a proof of concept, and BullMQ is its first realistic consumer. A few trade-offs are worth keeping
in mind:

- It adds a small runtime abstraction: a frame, a `WeakMap` lookup across phases, and resolvable declaration fields.
- Messaging defaults are currently explicit in BullMQ instead of being supplied by `ProducerPlugin` and
  `ConsumerPlugin`. A mature pipeline may want capability-level defaults without recreating the old inheritance tree.
- Stages are ordinary functions, so their input/output contracts are currently expressed through the frame rather than
  a stronger schema.
- Validation currently catches structural definition errors, but it could eventually validate stage names, skip modes,
  extractor shapes, and incompatible lifecycle choices more thoroughly.
- More integrations are needed before treating the declaration format as stable. BullMQ exercises async producers,
  consumers, filtering, propagation, argument mutation, errors, bulk operations, service naming, and DSM, but it does
  not represent every integration type.

The important architectural boundary is nevertheless clear: diagnostic channels remain the event transport, while the
pipeline becomes the consistent interpreter of Orchestrion's standard lifecycle.
