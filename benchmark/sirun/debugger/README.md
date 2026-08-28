# Dynamic Instrumentation Benchmarks

Measures application overhead from installed line probes, including real stack and snapshot capture. Each active run
validates one probe payload before timing, resets its completion state, then waits for every production pause handler and
verifies the exact payload count and capture kind. HTTP export is stubbed because it runs after the application resumes
and is outside this benchmark's hot path. Line probes omit Sirun's main-thread-only instruction count because capture work
runs in the inspector worker.
