Critical-path bench. The tracer's async-context propagation rides on async_hooks,
so per-hook overhead is paid on every async operation in a traced app. Measures
the cost of enabling `createHook` (init-only and all-hooks) against a `no-hooks`
baseline over a fixed promise workload; the delta is the per-hook cost.
