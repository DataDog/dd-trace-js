This benchmark compares the Azure Cosmos plugin hot path across its legacy,
`IntegrationPipeline`, and shared database processor/adapter implementations. Sirun runs the benchmark definition
against baseline and candidate source revisions, so `src/index.js` resolves to
the implementation belonging to each revision.

The timed loop drives the real Orchestrion diagnostic-channel start, end, and
async-end events through the process-wide source bridge. Span export is stubbed, but accepted calls allocate one real
`DatadogSpanContext` and exercise resource/tag construction and base-class
finalization in both implementations.

Variants cover the distinct lifecycle paths introduced or affected by the
migration:

- `accepted`: creates and completes a Cosmos database span.
- `duplicate`: rejects a request-level create already represented by its parent
  operation.
- `empty-path`: rejects an account read and binds a no-op legacy scope.
- `inherited-noop`: receives an otherwise accepted operation under an existing
  no-op legacy scope.

The fixture ring keeps invocation shapes stable and prevents the benchmark from
measuring per-iteration fixture construction. Preflight and post-loop assertions
pin span/context cardinality so a source change cannot silently turn a variant
into a no-op. Each process warms the selected path for at least one second before
resetting counters and starting the timed loop.

For a quick local sample without the sirun controller:

```sh
LOCAL_BENCHMARK_REPORT=true \
STARTUP_GUARD_REPORT=/tmp/ddtrace-pipeline-startup-share \
VARIANT=accepted OPERATIONS=1000000 node index.js
```

Five fresh-process trials per implementation, interleaved on 2026-08-21 with Node.js 25 on Apple Silicon. Each trial
ran 1,000,000 timed operations after the one-second warmup:

| Path | Compatibility pipeline ns/op | Processor/adapter ns/op | Delta |
| --- | ---: | ---: | ---: |
| accepted | 1,273.6 | 1,446.2 | +172.5 ns / +13.5% |
| duplicate | 238.6 | 98.1 | -140.5 ns / -58.9% |
| empty-path | 283.7 | 278.3 | -5.4 ns / -1.9% |
| inherited-noop | 68.6 | 71.6 | +3.0 ns / +4.3% |

The compatibility implementation was loaded from commit `2301aab1d`; the processor/adapter numbers used the working
tree. The accepted-path increase is a real isolated cost, but 173 ns is below request-level variance for this
networked SDK. Treat ratios as hot-path regression signals and absolute deltas as the input to application-level
impact estimates.
