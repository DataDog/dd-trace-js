# Why proceed with IntegrationPipeline

This is the adoption case for the `IntegrationPipeline` experiment. It is intentionally separate from the mechanical
walkthrough in [INTEGRATION_PIPELINE_NOTES.md](./INTEGRATION_PIPELINE_NOTES.md): this file explains why the change is
worth pursuing, where the benefits are concrete, and where the design is still incomplete.

## Recommendation

Proceed with the approach, incrementally.

BullMQ demonstrates that we can preserve the existing diagnostic-channel contract and tracing behavior while moving
integration orchestration into one reusable engine. More importantly, it proves that correlation context can exist
before, or entirely without, a recording span. That is a capability the current plugin model cannot express cleanly.

This is not a recommendation to rewrite every plugin immediately. The next useful step is to migrate a few
representative integrations, measure the repeated code that disappears and the hot-path cost, and improve the
pipeline where those integrations expose missing capabilities.

## The problem is lifecycle ownership, not pub/sub

Diagnostic-channel pub/sub remains a good boundary between instrumentation and products. Instrumentation observes a
library call and publishes a neutral invocation; product code subscribes without making the instrumented library know
about tracing, DSM, AppSec, or IAST.

The problem is what happens after publication. Historically, each plugin has reconstructed some version of the same
orchestration:

- subscribe to the right channel set;
- understand the source-specific message shape;
- extract semantic data from arguments and results;
- decide whether the invocation should be instrumented;
- select a parent and create a span;
- bind async storage;
- run propagation and product-specific work;
- handle synchronous and asynchronous completion;
- record errors, finish spans, and restore storage.

Base classes provide helpers, but the integration still owns many ordering and cleanup decisions. Those decisions
have changed as instrumentation moved between manual channels, `tracingChannel`, shimmer, and Orchestrion. The result
is not merely verbose code: behavior can drift because the same lifecycle policy is encoded in many plugins.

`IntegrationPipeline` leaves pub/sub in place and gives the lifecycle one owner. Integrations declare the differences;
the engine implements the common control flow.

## What materially improves

### 1. Correlation is no longer a side effect of tracing

The existing model normally reaches trace and span IDs through the active span in `storage('legacy')`. This makes a
recording object the de facto context object for every product, even if that product never reads or changes a span.

The pipeline first reserves a `DatadogSpanContext` and exposes immutable correlation information through the frame.
Creating the actual span is a later, optional action. The current runtime carries correlation and the optional span in
`storage('legacy')` during the library call; if tracing is enabled, the span adopts the reserved context, so the IDs
seen before tracing are the IDs eventually recorded.

This is a real functional improvement:

- a context-only stage can run without allocating or finishing a span;
- `span.enabled` can disable tracing without disabling correlation-stage start and cleanup;
- correlation remains available inside a legacy no-op scope while nested tracing stays suppressed;
- tracing can move later without changing stages that only require IDs.

These cases are covered by the pipeline tests rather than existing only as design intent.

### 2. Product dependencies become explicit

Previously, a helper accepting a span did not tell us whether it genuinely annotated the span, only wanted IDs, or
used the span as a route back to the tracer. That ambiguity makes changes risky.

Pipeline stages receive a bounded frame. A stage is span-independent by default and declares
`requires: ['tracing']` when it must run after span materialization. The frame offers narrow capabilities for
correlation, propagation, trace tags, service naming, and DSM instead of exposing the plugin, tracer, or span.

This makes architectural coupling visible in code review. It also creates a practical path for AppSec, IAST, DSM, and
future products to participate without inheriting tracing as their execution model.

### 3. Ordering and cleanup policy live in one place

The pipeline defines a consistent sequence:

```text
extract -> gate -> correlate -> context stages -> optional tracing -> tracing stages -> invoke -> unwind
```

Stages start in declaration order and receive error and completion hooks in reverse order. Store restoration is owned
by the channel binding mechanism, and invocation state is deleted in a `finally` block. A stage exception is logged
and isolated so instrumentation does not break the customer application or prevent later cleanup.

Centralizing this does not make bugs impossible, but it changes their scope: an ordering fix in the engine applies to
every pipeline integration, and its contract can be pinned by one focused test suite.

### 4. Integration code describes domain behavior

The BullMQ producer declaration says which function is observed, how to find the queue and jobs, which calls pass the
filter, what the span should look like, and which propagation or DSM stages apply. The consumer declaration adds
carrier extraction and parent selection.

That is closer to the information we actually need to review. Subscription wiring, weak-map state, sync/async terminal
events, store binding, error recording, and span finishing do not obscure BullMQ-specific behavior.

This should reduce copy-and-edit mistakes when humans add integrations. It should also make AI-assisted integration
work more reliable: a model can fill a constrained declaration and reuse known stages instead of generating a bespoke
plugin lifecycle whose hidden invariants vary by reference plugin. That is an expected benefit, not yet a measured
quality claim; it should be evaluated on subsequent migrations.

### 5. Orchestrion supplies the intended lifecycle shape

The engine depends on a small source contract: resolve lifecycle channel names and normalize a message into an
invocation. Extraction, gating, correlation, tracing, and stages do not build Orchestrion channel names themselves.
That boundary keeps source mechanics out of integration definitions.

It does not mean arbitrary sources are equally good pipeline candidates. Orchestrion supplies the uniform function
lifecycle the pipeline standardizes. Shimmer integrations commonly exist because they need dynamic interception,
pre-lifecycle mutation, streaming or callback ownership, or result-identity preservation. Encoding those exceptions in
a source adapter would recreate bespoke plugin orchestration behind a different name. Adopt another source only when
it can provide the same bounded lifecycle without integration-specific control flow.

### 6. Operation lists replace lifecycle-only composites

BullMQ's former `CompositePlugin` existed to group producer and consumer classes that repeated the same subscription,
storage, and completion machinery. A pipeline definition lists those operations directly, while stages express shared
capabilities such as propagation, DSM, and code origin. Adding an operation no longer requires another plugin subclass
or another composite entry.

Composites that coordinate independent products, configuration domains, or genuinely different lifecycles remain
valid. Moving those concerns into extractors or stages would be a regression to plugin-style imperative orchestration,
not successful pipeline composition.

### 7. The design supports incremental adoption

The generated class still satisfies the current plugin-manager contract and extends `TracingPlugin`. Azure Cosmos
resolves service naming through the existing schemas and declares peer-service and code-origin behavior as stages.
Existing plugin loading, configuration, span creation, and error tagging continue to work. Correlation and recording
remain separate frame capabilities and stage phases while sharing `storage('legacy')` until a non-tracing product
demonstrates the permanent context-store boundary.

That compatibility lets us validate the new model integration by integration. We do not need a flag day, and a plugin
that does not fit the model can remain on the existing base classes while the missing abstraction is understood.

## Evidence from the BullMQ and Azure Cosmos migrations

The current experiment establishes more than a smaller source file:

- producer and consumer behavior are expressed through the same operation contract;
- correlation-only operations execute without emitting traces;
- optionally untraced operations still run their context stages;
- the span, when created, uses the exact IDs reserved before tracing;
- filtered operations reserve no correlation IDs, start no stages, and create no spans;
- nested legacy no-op scopes keep correlation but suppress traced stages;
- malformed customer metadata and stage failures do not break the BullMQ call;
- store restoration, error hooks, reverse completion, and definition validation have direct tests;
- the Redis-backed BullMQ plugin CI passes across the versions in the test matrix.
- a database client uses the same lifecycle while composing its required outbound behavior explicitly;
- one Cosmos source target resolves either parent inheritance or no-op suppression for rejected invocations;
- Cosmos response and error fields are applied through the common completion path;
- the emulator-backed Cosmos plugin CI passes for the oldest and newest supported SDKs and for ESM loading.

These properties are useful regardless of whether integration declarations eventually use this exact syntax.

## Architecture score: current plugins versus the pipeline

These are provisional engineering scores, not measurements. They make the trade-off explicit and identify what must
still be proven. A higher number means the design better satisfies the dimension.

| Dimension | Existing plugin model | IntegrationPipeline | Reason for the change |
| --- | ---: | ---: | --- |
| Drift prevention | 5/10 | 9/10 | Shared ordering, cleanup, storage, and terminal behavior move from each integration into one engine. |
| Module coupling | 4/10 | 8/10 | Stages receive bounded capabilities rather than spans, tracer internals, or plugin internals; `TracingPlugin` inheritance remains a bridge. |
| Explicit contracts | 5/10 | 8/10 | Operation validation, source normalization, stage requirements, and a bounded frame replace lifecycle conventions spread across handlers. |
| Testability at boundaries | 6/10 | 9/10 | Context reservation/materialization, store separation, stage order, no-op behavior, and invalid definitions have direct contract tests. |
| Extensibility | 5/10 | 8/10 | New operations primarily add declarations and stages; new sources have an adapter boundary. More product capabilities still need design. |
| Hot-path fitness | 8/10 | 7/10 | The runtime uses one store and lazy capabilities, but broader persistent benchmark coverage is still needed. |

The proposal clears the architectural bar on five dimensions. Hot-path fitness remains below the direct plugin model
until representative persistent benchmarks establish the cost across accepted, rejected, and tracing-disabled paths.

## What this approach does not yet prove

A credible adoption case needs to be clear about its gaps.

### Performance was optimized but is not free

The first pipeline measurement was materially worse because every operation eagerly allocated every capability and
entered three async-context stores, even when its declaration used none of them. It also resolved declarations
field-by-field and created per-invocation closures and argument arrays.

The runtime now uses only the existing legacy store while retaining reserved correlation and separate context/tracing
stage phases. It also lazily materializes correlation and capability blocks, precompiles extractors/resolvers, supports
whole-record extraction and tag blocks, avoids rejected-operation state retention, and keeps the inherited no-op path
ahead of frame allocation. These are reusable pipeline optimizations rather than Azure-specific shortcuts.

Performance still needs a durable gate. Add representative benchmarks for BullMQ, simple synchronous operations,
rejected gates, inherited no-op scopes, and globally disabled tracing before broad adoption into hotter libraries.
The benchmark must drive the real diagnostic-channel lifecycle and context reservation; timing isolated resolver
helpers would hide the engine costs the measurement is intended to constrain.

### Tracing is separated logically, not fully modularized

The generated plugin still extends `TracingPlugin`, and span construction still flows through existing tracer
internals. The raw span is private to the engine, but tracing is not yet a separately loadable pipeline capability.

This is enough to make stage dependencies honest and to support spanless operations. It is not yet the final product
composition architecture.

### Sampling still constrains propagation

A newly reserved local context has IDs, but current priority sampling can require span metadata and a started trace.
BullMQ propagation therefore declares `requires: ['tracing']` even though it injects `frame.correlation` rather than a
span. Moving injection fully before tracing requires a context-level sampling plan.

### Globally disabled tracing still selects the no-op tracer

`DD_TRACE_ENABLED=false` currently replaces the tracer with an implementation that does not allocate real unique
correlation contexts. The pipeline can omit spans per operation, but product execution with the entire tracer disabled
is a broader lifecycle/configuration problem.

### The capability vocabulary is intentionally small

Only the `tracing` requirement is currently validated. AppSec, IAST, DSM, and other capabilities need explicit
contracts, configuration gates, ordering rules, and cardinality tests before they become general reusable stages.

### Declarations will not fit every integration unchanged

Highly dynamic libraries, streaming lifecycles, callbacks with unusual ownership, or operations requiring mutation
before the source lifecycle begins may expose limits. Those cases should improve the source or operation contracts;
they should not be forced into declarations that hide imperative behavior.

## Risks and how to control them

| Risk | Control |
| --- | --- |
| A generic engine becomes a large conditional framework | Keep integration-specific decisions in extractors and stages; add engine concepts only after multiple consumers need them. |
| The declaration becomes a less readable programming language | Prefer ordinary functions for domain logic and reserve schema fields for stable lifecycle concepts. |
| Central bugs affect several integrations | Pin engine boundary contracts directly and migrate gradually before expanding usage. |
| Abstraction overhead hurts hot paths | Benchmark representative operations and preserve an early gate/skip fast path. |
| Product stages silently receive fewer events | Preserve per-invocation source publication and test subscriber cardinality, especially for AppSec and IAST. |
| Context remains coupled to legacy storage | Introduce a dedicated product-context store only when a non-tracing consumer establishes its contract. |

## Proposed adoption criteria

Proceed beyond BullMQ if the next migrations demonstrate all of the following:

1. A second integration type can use the lifecycle without BullMQ-specific engine changes.
2. Shared stages remove real duplication across at least two integrations.
3. Hot-path benchmarks show acceptable overhead, including filtered and tracing-disabled calls.
4. Existing span shapes, propagation headers, DSM behavior, errors, and configuration remain compatible.
5. A non-tracing product can run from `frame.correlation` without reaching through a span; if it needs async access
   outside stage hooks, use that requirement to define a dedicated context store.
6. Source adapters preserve the invocation cardinality required by every subscriber.

If those conditions hold, the pipeline gives us a better foundation than continuing to add helpers to plugin classes:
one explicit lifecycle, independently usable context, bounded product capabilities, and declarations focused on what
makes an integration unique.
