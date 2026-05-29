Critical-path bench. Every instrumentation in the tracer routes its wrapped
calls through shimmer, so a regression here taxes all of them. Measures runtime
performance of functions wrapped by `shimmer.wrap` and `shimmer.wrapFunction`,
with variants per function kind and wrap type. The `*-baseline` variant is the
unwrapped function; the delta is shimmer's per-call overhead.
