# MariaDB integration architecture comparison

## Scope

This branch migrates MariaDB directly to `IntegrationPipeline` operations and stages without the shared database
processor, lifecycle adapters, source registry, domain registry, or trace manager. It is intended to be compared with:

- legacy MariaDB plugin at `5fcbd3750`;
- processor/adapter branch `crysmags/integration-processor-adapters`;
- direct-stage branch `crysmags/mariadb-integration-pipeline-stages`.

All three retain the existing manual MariaDB instrumentation. The v2 query wrapper and v3 command wrapper continue to
own actual callback/promise completion; neither design treats `Command.start()` as the logical async lifecycle.
Both comparison branches restore BullMQ to its pre-pipeline plugin, so the framework and package-local totals below
measure only the Azure Cosmos and MariaDB database migrations.

## Direct-stage shape

```text
apm:mariadb:query:start
  -> source adapter preserves caller store and context identity
  -> query facts are extracted
  -> mariadb.query span is created and bound
  -> IAST stage analyzes the original statement
  -> DBM stage injects into the driver-owned SQL shape
  -> driver runs through its existing callback/command lifecycle
  -> error/finish channels unwind stages and finalize database peer-service tags

apm:mariadb:pool:acquire:start
  -> publish-only operation creates mariadb.pool.acquire
  -> existing finish notification applies error/wait metadata and finishes the span
```

MariaDB-specific connection restoration, queued-command parent capture, and pool no-op scopes live in a 31-line
compatibility base. Pool acquisition is publish-only and cannot declare stages because its start notification does
not surround the original library call with a bound operation scope.

## Behavioral comparison

| Concern | Legacy plugin | Direct stages | Processor/adapters |
| --- | --- | --- | --- |
| Query tracing | `MySQLPlugin.bindStart()` | Declarative query operation | Fixed database query adapter |
| Pool acquire | Bespoke subscriptions in `MySQLPlugin` | Publish-only pipeline operation | Fixed pool lifecycle adapter |
| Connection/no-op context | Inherited subscriptions plus MariaDB overrides | Narrow MariaDB compatibility base | Fixed connection/source lifecycle adapters |
| DBM | Plugin mutates `ctx.sql` | Tracing-dependent DBM stage through a narrow capability | Database processor policy plus source write-back |
| IAST | No MariaDB subscription on the base branch | Tracing-dependent MariaDB stage | Independent database contributor |
| Product-only activation | Not available | Not available; APM must activate the source | Available; a contributor can activate the source without APM |
| Span ownership | Plugin context | Pipeline-private `WeakMap` state | Per-tracer opaque trace manager |
| Multi-tracer/product composition | Existing plugin-manager behavior | Existing plugin-manager behavior | Explicit source/domain registries and per-tracer ownership |
| Raw span exposed to extension code | Plugin owns it | No; stages receive bounded capabilities | No; processor/trace manager own it |

The direct-stage declaration keeps query shape, stage order, and span metadata close together. The processor version
leaves a smaller MariaDB package source (135 lines versus 271), because service naming, DBM, tracing, product
composition, and lifecycle policy move into reusable database-domain modules. Its framework is correspondingly much
larger: the database-only registries, source routing, processor, lifecycle adapters, and trace manager total 1,653
production lines, while the direct-stage engine is 825 lines. Across the two migrated database packages, the
processor branch has 294 package-local production lines versus 439 on the direct-stage branch; including their
frameworks, the totals are 1,947 versus 1,264 lines.

Measured as migration production-code churn from each approach's immediate framework baseline, direct stages add 413
and remove 39 lines across seven files. The processor MariaDB query/pool/IAST slice adds 925 and removes 307 lines
across 13 files. That is not a pure verbosity comparison: the processor slice also establishes independently
activatable contributors, process-wide source ownership, per-tracer trace ownership, and reusable fixed pool and
connection lifecycles that the stage branch deliberately omits.

## Isolated performance

The persistent benchmark drives the same `apm:mariadb:query:start` and `finish` channels for every implementation.
Accepted calls allocate a real `DatadogSpanContext`, construct span tags, run lifecycle policy, and finalize the span;
only export and the database server are stubbed. Five fresh-process trials per implementation were interleaved on
2026-08-25 with Node.js 25 on Apple Silicon. Each process warmed up for at least one second. Accepted variants timed
1,000,000 operations and disabled variants timed 5,000,000.

| Query path | Legacy ns/op | Processor ns/op | Direct stages ns/op | Processor vs legacy | Stages vs legacy | Stages vs processor |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct | 845.9 | 973.1 | 1,413.0 | +127.3 / +15.0% | +567.1 / +67.0% | +439.8 / +45.2% |
| Pool facts | 869.6 | 1,016.3 | 1,453.8 | +146.7 / +16.9% | +584.2 / +67.2% | +437.5 / +43.0% |
| Tracing disabled | 2.57 | 2.59 | 2.56 | +0.02 / +0.6% | -0.02 / -0.7% | -0.03 / -1.3% |

Disabled-path differences are within the roughly ±2% equality band. The accepted-path result is clear and
reproducible in these trials: the fixed processor/adapter path is about 43-45% faster than direct stages, while the
legacy plugin remains fastest. These are isolated nanosecond costs rather than end-to-end database latency, but they
are the relevant regression signal for a query hot path.

## Architecture scores

The direct-stage engine extension was scored before commit against the pipeline that existed on the feature branch:

| Dimension | Existing pipeline → MariaDB extension | Reason |
| --- | ---: | --- |
| Drift prevention | 7 → 8 | Query and pool span lifecycle move into the existing compiler; MariaDB source context remains narrow. |
| Module coupling | 8 → 8 | DBM is a bounded structural capability and the raw span remains private; IAST remains package-local. |
| Explicit contracts | 8 → 9 | DBM requires tracing and a database base; invalid requirements and source modes fail validation. |
| Boundary testability | 8 → 9 | Publish-only completion, DBM write-back, source identity, error handling, and real driver behavior are pinned. |
| Extensibility | 7 → 8 | The source contract now represents explicit notification lifecycles without adding MariaDB branches to the engine. |
| Hot-path fitness | 6 → 5 | Accepted queries add roughly 567-584 ns over legacy and 438-440 ns over the fixed processor. |

The extension clears the repository architecture bar on five dimensions, but hot-path fitness declines. For adoption,
the three complete designs compare as follows:

| Dimension | Legacy | Direct stages | Processor/adapters |
| --- | ---: | ---: | ---: |
| Drift prevention | 5 | 9 | 9 |
| Module coupling | 4 | 7 | 9 |
| Explicit contracts | 5 | 8 | 9 |
| Boundary testability | 6 | 9 | 9 |
| Extensibility | 5 | 8 | 9 |
| Hot-path fitness | 8 | 5 | 7 |

## Conclusion

For a one-integration migration, direct stages are the smaller framework change and the full operation is easier to
read in one declaration. They preserve behavior without introducing global registries or a trace manager.

For a reusable database architecture, the processor/adapters design is cleaner and more efficient. It is materially
faster on accepted queries, leaves less MariaDB-specific policy, provides fixed query/pool/connection contracts, and
allows IAST or another product to activate and consume the source independently of APM. Its cost is substantially
more shared infrastructure and a larger initial test/maintenance surface.

The practical recommendation from this comparison is therefore:

- keep the legacy plugin if minimizing isolated overhead is the only goal;
- use direct stages for genuinely integration-specific, variably composed lifecycles;
- prefer fixed processor/adapters for MariaDB and other database integrations that share stable semantic operations
  and need independent product participation.

## Verification

- IntegrationPipeline contract: 14 passing.
- MariaDB plugin matrix: 327 passing across generated v2/v3 fixtures.
- MariaDB DBM driver write-back regression against 3.4.5: passing.
- SQL-injection analyzer: 20 passing.
- Focused ESLint and `git diff --check`: passing.

The MariaDB matrix prints an existing mock-agent listener diagnostic when an unfiltered promise test observes a
`SET NAMES utf8mb4` connection-setup span before its target query. The suite exits successfully, and the resource-
filtered span tests and the new DBM regression pass; this diagnostic is not counted as a failing test.
