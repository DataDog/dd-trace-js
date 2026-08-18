This benchmark compares the Azure Cosmos plugin hot path across the legacy and
`IntegrationPipeline` implementations. Sirun runs the same benchmark definition
against baseline and candidate source revisions, so `src/index.js` resolves to
the implementation belonging to each revision.

The timed loop drives the real Orchestrion diagnostic-channel start, end, and
async-end events. Span export is stubbed, but accepted calls allocate one real
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
into a no-op.

For a quick local sample without the sirun controller:

```sh
LOCAL_BENCHMARK_REPORT=true \
STARTUP_GUARD_REPORT=/tmp/ddtrace-pipeline-startup-share \
VARIANT=accepted OPERATIONS=1000000 node index.js
```

Seven-trial medians measured on 2026-08-17 with Node.js 25 on Apple Silicon:

| Path | Legacy ns/op | Optimized pipeline ns/op | Delta |
| --- | ---: | ---: | ---: |
| accepted | 1,048 | 1,368 | +320 ns / +31% |
| duplicate | 231 | 251 | +20 ns / +9% |
| empty-path | 270 | 295 | +25 ns / +9% |
| inherited-noop | 77 | 74 | parity |

The exact legacy implementation was loaded from the branch `HEAD`; the pipeline
numbers used the working tree. Treat ratios as hot-path regression signals and
absolute deltas as the input to application-level impact estimates.
