Critical-path bench. Every instrumentation wraps its targets through shimmer at
load time, so a regression here slows startup across all integrations. Measures
the wrap operations themselves (`shimmer.wrap` and `shimmer.wrapFunction`), with
variants per function kind and wrap type. The `*-baseline` variant is the
unwrapped function; the delta is shimmer's wrap cost.
