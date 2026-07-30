# Performance

Assume tracer, instrumentation, propagation, span, and request paths are hot unless the code proves otherwise:

- Look for avoidable objects, arrays, closures, promises, callbacks, copies, boxing, and string construction.
- Check repeated parsing, regex compilation, stringification, logging work, and other work that can move to setup.
- Check listeners, timers, buffers, maps, caches, and queues for leaks or unbounded growth.
- Verify disabled and common no-op cases take a cheap fast path.
- Check whether a new abstraction adds work at every call site.
- Require a reproducible microbenchmark when the change claims a performance trade-off.

State the call path and cost mechanism. If runtime behavior decides the cost, ask for a benchmark or profile instead of declaring a regression.
