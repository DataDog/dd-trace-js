Critical-path bench. Every instrumentation wraps its targets through shimmer at
load time, so a regression here slows startup across all integrations. Measures
the wrap operation itself. Two variants: `declared-wrap` (`shimmer.wrap`, which
manipulates property descriptors) and `declared-wrapfn` (`shimmer.wrapFunction`,
a standalone wrap). The wrapped function's shape does not affect the wrap cost,
so a single sync target is used.
