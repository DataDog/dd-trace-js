Measures the scope manager's per-hop async-context cost: chains `COUNT` promise
continuations, each wrapped in `scope.activate()` -- the path the tracer drives
under every traced async operation (an `AsyncLocalStorage` enterWith plus the
parent store copy). Rendered commit-over-commit; there is no baseline variant.
