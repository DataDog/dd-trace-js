# Why proceed with shared integration lifecycle frameworks

> Historical compatibility snapshot: this rationale records the experiment that led to the fixed processor/adapter
> model. BullMQ has since migrated from `IntegrationPipeline` stages to the shared messaging processor and fixed
> produce/consume adapters, and MariaDB pool/connection behavior has moved off its compatibility base. Use the
> [current agent guide](../dd-trace/src/plugins/integration-pipeline-agent-guide.md) for the active architecture and
> migration policy.

The remainder is intentionally preserved as a point-in-time decision record and contains present-tense statements
that no longer describe the branch.

This is the adoption case for the compatibility `IntegrationPipeline` and fixed processor/adapter experiments. It is
intentionally separate from the mechanical walkthrough in
[INTEGRATION_PIPELINE_NOTES.md](./INTEGRATION_PIPELINE_NOTES.md): this file explains why the change is worth pursuing,
where the benefits are concrete, and where the design is still incomplete.

## Recommendation

Proceed with the approach, incrementally.

BullMQ demonstrates that we can preserve the existing diagnostic-channel contract and tracing behavior while moving
integration orchestration into one reusable engine. More importantly, it proves that correlation context can exist
before, or entirely without, a recording span. That is a capability the current plugin model cannot express cleanly.

Azure Cosmos demonstrates the safer shape for integrations sharing a stable semantic domain: one package-fact source,
one process-wide bridge, independent product contributors, one processor per tracer, a fixed lifecycle adapter, and
opaque per-tracer trace ownership. The compatibility pipeline remains useful for variable stage composition; it
should not be the default when a narrower domain contract can express the integration.

MariaDB queries validate that shape against a hotter SQL integration and a non-Orchestrion source lifecycle. The
shared query policy is reusable without replacing source wrappers that own real callback/command completion. Pool and
connection lifecycles remain on the compatibility base until their separate adapter slice is designed and verified.

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

Both approaches leave pub/sub in place and give shared lifecycle policy an explicit owner. Compatibility-pipeline
integrations declare variable operations and stages. Processor/adapter integrations extract package facts while a
shared domain processor and fixed adapter implement common policy and control flow.

## What materially improves

### 1. Correlation is no longer a side effect of tracing

The existing model normally reaches trace and span IDs through the active span in `storage('legacy')`. This makes a
recording object the de facto context object for every product, even if that product never reads or changes a span.

The pipeline first reserves a `DatadogSpanContext`, exposes immutable correlation information, and binds it in
`storage('context')`. Creating and binding the actual span is a later, optional action. If tracing is enabled, the span
adopts the reserved context, so the IDs seen before tracing are the IDs eventually recorded.

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

### 5. Orchestrion becomes an input, not an architectural constraint

Orchestrion remains the preferred source when a lifecycle maps to a statically matched function, but the engines
depend on small source contracts rather than Orchestrion channel names. MariaDB now supplies explicit `start`, `error`,
and `finish` channels from its established instrumentation wrappers. Extraction, gating, correlation, tracing, and
completion policy are unchanged by that source choice.

This matters even if no second source is added soon. Source-specific assumptions have a named boundary, so a future
instrumentation change should require replacing an adapter instead of reshaping every integration declaration.

### 6. The design supports incremental adoption

All generated plugin shells still satisfy the current plugin-manager contract. BullMQ extends `TracingPlugin`
through the compatibility pipeline. Azure Cosmos uses a thin `Plugin` shell while one shared `DatabaseProcessor` per
tracer retains `DatabasePlugin` service naming, peer-service finalization, code-origin behavior, span creation, and
error tagging. MariaDB selects `MySQLPlugin` as a compatibility base: generated query subscriptions are suppressed,
but its explicit pool and connection subscriptions remain active. `storage('legacy')` is mirrored during migration.

That compatibility lets us validate the new model integration by integration. We do not need a flag day, and a plugin
that does not fit the model can remain on the existing base classes while the missing abstraction is understood.

## Evidence from the BullMQ, Azure Cosmos, and MariaDB migrations

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
- one physical Cosmos source bridge serves multiple tracers and product contributors;
- in-flight operations retain that bridge and their start-time consumer ownership until terminal cleanup;
- package extraction publishes normalized Cosmos facts without broadcasting raw arguments;
- one Cosmos source target returns parent inheritance or no-op suppression as fixed source decisions;
- each tracer owns and finalizes a distinct span for the same normalized event, including errors;
- Cosmos response and error fields are applied through atomic trace-manager completion;
- product-only activation and product/APM store composition have direct boundary tests;
- the emulator-backed Cosmos plugin CI passes for the oldest and newest supported SDKs and for ESM loading.
- one explicit MariaDB source descriptor reuses the same database processor and fixed query adapter as Cosmos;
- v2 callback/promise and v3 command paths retain their real completion owners while sharing semantic lifecycle code;
- DBM mutation remains processor-owned and reaches driver string and object query inputs through source write-back;
- finish-store restoration, multi-tracer primary-only mutation, and physical bridge cardinality have direct tests;
- minimum/current CJS and latest ESM MariaDB paths preserve their query spans and return behavior.

These properties are useful regardless of whether integration declarations eventually use this exact syntax.

## Architecture score: current plugins, compatibility pipeline, and processor/adapter

These are provisional engineering scores, not measurements. They make the trade-off explicit and identify what must
still be proven. A higher number means the design better satisfies the dimension.

| Dimension | Existing plugin | Compatibility pipeline | Processor/adapter | Reason for the processor/adapter score |
| --- | ---: | ---: | ---: | --- |
| Drift prevention | 5/10 | 9/10 | 9/10 | Database tracing and DBM policy have one domain owner across Cosmos and MariaDB. |
| Module coupling | 4/10 | 8/10 | 9/10 | Package sources expose facts, contributors receive normalized events, and spans remain private to per-tracer trace managers. |
| Explicit contracts | 5/10 | 8/10 | 9/10 | Registries enforce ownership and configuration; a fixed query adapter replaces open-ended lifecycle conventions. |
| Testability at boundaries | 6/10 | 9/10 | 9/10 | Raw binding cardinality, contributor composition, multi-tracer ownership, source write-back, and atomic terminals have direct tests. |
| Extensibility | 5/10 | 8/10 | 9/10 | Orchestrion and explicit-channel packages supply facts while reusing the processor and lifecycle adapter unchanged. |
| Hot-path fitness | 8/10 | 7/10 | 7/10 | Accepted calls add 94-173 ns on direct paths and 151 ns for MariaDB pool-query facts; rejected/disabled paths improve or remain near parity. |

The processor/adapter proposal clears the architectural bar on five dimensions. For the MariaDB query slice, the
baseline-to-proposal scores are drift prevention 5→9, module coupling 5→8, explicit contracts 5→9, boundary
testability 6→9, extensibility 4→9, and hot-path fitness 8→7. Composition owns query behavior; inheritance is limited
to the compatibility base required for pool/connection behavior outside this slice. The measured cost is bounded for
network database operations but remains a regression gate.

## What this approach does not yet prove

A credible adoption case needs to be clear about its gaps.

### Performance was optimized but is not free

The compatibility compiler already treats declarations as executable plans: it installs only stores needed by
declared stages, lazily materializes correlation and capability blocks, precompiles extractors and resolvers, supports
whole-record extraction and tag blocks, avoids rejected-operation state retention, and keeps the inherited no-op path
ahead of frame allocation. The processor/adapter benchmark therefore compares against that optimized baseline, not an
unoptimized prototype.

On 2026-08-21, five fresh-process trials per implementation interleaved the exact compatibility-pipeline baseline at
`2301aab1d` with the processor/adapter working tree. Each trial used Node.js 25 on Apple Silicon, warmed the selected
path for one second, and timed 1,000,000 operations. The persistent benchmark drives real diagnostic-channel bindings
and completion handlers, allocates real `DatadogSpanContext` instances, and stubs only span export.

| Azure Cosmos path | Compatibility pipeline ns/op | Processor/adapter ns/op | Delta |
| --- | ---: | ---: | ---: |
| Accepted and completed span | 1,273.6 | 1,446.2 | +172.5 ns / +13.5% |
| Duplicate request rejected to parent | 238.6 | 98.1 | -140.5 ns / -58.9% |
| Empty-path read rejected to no-op | 283.7 | 278.3 | -5.4 ns / -1.9% |
| Accepted operation under inherited no-op | 68.6 | 71.6 | +3.0 ns / +4.3% |

The accepted-path increase is reproducible and should remain a regression gate. The fixed source decision also makes
duplicate rejection materially cheaper, while empty-path and inherited-noop behavior remains near parity.

The MariaDB benchmark compares the legacy plugin at `286fc250d` with the processor/adapter query slice. Five
fresh-process trials per implementation were interleaved on the same machine and runtime. Accepted paths timed
1,000,000 operations after warmup; the disabled path timed 5,000,000:

| MariaDB query path | Legacy plugin ns/op | Processor/adapter ns/op | Delta |
| --- | ---: | ---: | ---: |
| Direct query | 837.3 | 931.4 | +94.1 ns / +11.2% |
| Pool query facts | 847.7 | 998.8 | +151.1 ns / +17.8% |
| Tracing disabled | 2.59 | 1.33 | -1.26 ns / -48.6% |

This benchmark drives the existing MariaDB diagnostic-channel lifecycle shared by v2 and v3, allocates real span
contexts, and stubs export. It measures query normalization and lifecycle policy, not the driver wrapper or database
server. The pool variant includes pool-wait normalization/tagging but not pool acquisition, which remains in the next
adapter slice.

End-to-end trials also ran the baseline and candidate with the real Cosmos SDK, tracer, mock-agent export path, and
local Cosmos emulator. Across 32 fresh processes with 1,000-5,000 timed item reads each, request times were roughly
0.9-1.4 ms and the distributions completely overlapped. In six simultaneous paired runs, the candidate process was
faster five times, which is not evidence that it is faster; it demonstrates that emulator and scheduler variance is
much larger than the sub-microsecond instrumentation delta. No request-level slowdown was detectable.

At a representative 1 ms request, the largest accepted-path delta measured here adds about 0.017% request time; even
two accepted callbacks are about 0.035%. The CPU delta is roughly 0.017% of one core at 1,000 accepted callbacks/s,
0.17% at 10,000/s, and 1.7% at 100,000/s. This cost applies only to matching integration callbacks, not to every tracer
operation. Keep the persistent microbenchmarks as regression gates, and add BullMQ and simple synchronous
measurements before broad adoption into substantially hotter libraries.

### Tracing is separated at package and product boundaries, not fully modularized

The generated BullMQ plugin still extends `TracingPlugin`, and `DatabaseProcessor` still extends `DatabasePlugin`.
Span construction flows through existing tracer internals. The raw span is private to the compatibility engine or
per-tracer trace manager, and package sources and product contributors do not receive it, but tracing is not yet a
separately loadable capability.

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

Only the `tracing` compatibility-stage requirement is currently validated. The process-wide contributor registry has
explicit activation, source filtering, ordering, store composition, failure isolation, and cardinality tests, but no
production AppSec, IAST, DSM, or other non-APM contributor has adopted it yet.

### Declarations will not fit every integration unchanged

Highly dynamic libraries, streaming lifecycles, callbacks with unusual ownership, or operations requiring mutation
before the source lifecycle begins may expose limits. Those cases should improve the source or operation contracts;
they should not be forced into declarations that hide imperative behavior.

## Risks and how to control them

| Risk | Control |
| --- | --- |
| A generic engine becomes a large conditional framework | Use the compatibility pipeline only for variable stage composition; prefer a fixed domain adapter when a stable contract exists. |
| The declaration becomes a less readable programming language | Prefer ordinary functions for domain logic and reserve schema fields for stable lifecycle concepts. |
| Central bugs affect several integrations | Pin engine boundary contracts directly and migrate gradually before expanding usage. |
| Abstraction overhead hurts hot paths | Benchmark representative operations and preserve an early gate/skip fast path. |
| Product stages silently receive fewer events | Preserve per-invocation source publication and test subscriber cardinality, especially for AppSec and IAST. |
| One physical bridge accidentally shares one tracer's span | Broadcast only normalized facts and event identity; keep span maps inside each tracer's trace manager and test multi-tracer success/error paths. |
| Package arguments leak to unrelated products | Contributors receive allowlisted facts and lifecycle metadata, never raw argument, credential, or header containers or package object graphs. |
| A generated source lifecycle finishes before the driver does | Retain source wrappers that own real completion; MariaDB v3 completes through command `resolve` / `reject`, not `Command.start()` return. |
| Compatibility code becomes permanent | Track removal criteria for `storage('legacy')` and the `TracingPlugin` inheritance bridge. |

## Next adoption criteria

The MariaDB query slice proves that a second database package and an explicit diagnostic-channel source can reuse the
fixed processor/query adapter unchanged. Shared DBM and tracing policy now replaces real package duplication, and the
direct, pool-query-facts, and tracing-disabled paths have persistent measurements. Query span shape, context
restoration, configuration isolation, source write-back, and source cardinality are pinned.

Proceed to the next slices only if they preserve those results and demonstrate the remaining boundaries:

1. MariaDB pool acquisition and connection behavior move through fixed adapters without losing caller context,
   lazy-pool growth, or no-op internal boundaries.
2. A production non-tracing contributor activates and consumes a source without reaching through APM or a span.
3. Pool/connection and later messaging measurements keep absolute overhead acceptable on their actual hot paths.
4. Compatibility removal criteria are defined before the selected MySQL base or `storage('legacy')` becomes an
   untracked permanent layer.

If those conditions hold, the two paths give us a better foundation than continuing to add helpers to plugin classes:
flexible composition where needed, fixed domain lifecycles where possible, independently usable product context, and
package declarations focused on what makes an integration unique.
