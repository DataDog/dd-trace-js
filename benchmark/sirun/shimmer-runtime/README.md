Critical-path bench. Every instrumentation in the tracer routes its wrapped
calls through shimmer, so a regression here taxes all of them. Measures the
per-call cost of a shimmer-wrapped function. Two variants: `declared-wrap`
(wrapped via `shimmer.wrap`) and `declared-wrapfn` (via `shimmer.wrapFunction`).
Only a sync target is exercised; an async one would mostly measure promise
allocation rather than shimmer.
