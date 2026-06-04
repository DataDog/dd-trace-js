Drives the per-lookup work the dns instrumentation's callback instrumentor adds
(argument capture, context build, start/finish channel dispatch, callback wrap)
over a no-op underlying lookup, so the measurement isolates the tracer's cost
from the libuv `getaddrinfo` syscall.
