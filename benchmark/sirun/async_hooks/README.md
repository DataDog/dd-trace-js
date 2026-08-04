Critical-path bench. The tracer's async-context propagation rides on async_hooks,
so per-hook overhead is paid on every async operation in a traced app. Measures
the cost of enabling `createHook` over a fixed promise workload, with an init-only
and an all-hooks variant.
