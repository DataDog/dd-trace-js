This benchmark runs the with runtime metrics and an accelerated flush. While
this can catch code regressions, it's mostly meant to catch things like memory
leaks where metrics would start piling up. This can be hard to catch in tests,
but it would cause the app to become slower and slower over time which would
be visible in the benchmark.
