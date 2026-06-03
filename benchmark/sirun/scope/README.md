Measures the scope manager's per-hop async-context cost. Chains `COUNT` promise
continuations; the `scope_enabled` variant wraps each in `scope.activate()`, the
path the tracer drives under every traced async operation. The delta is the
`AsyncLocalStorage` enterWith plus store-copy cost per continuation.
