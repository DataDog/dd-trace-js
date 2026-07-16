Measures the per-call fs instrumentation overhead with a subscriber attached:
the orphan guard, the getMessage-shape ctx build, the AbortController allocation,
and the two startChannel/finishChannel runStores around the operation. Loads the
real fs instrumentation and drives the wrapper with a no-op underlying op so the
measurement is the tracer's added cost per fs call, free of filesystem syscall
noise.
