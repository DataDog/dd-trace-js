# Dynamic Instrumentation Benchmarks

Measures application overhead from installed line probes, including real stack and snapshot capture. Each run waits for
a fixed number of completed probe hits; the downstream exporter is stubbed after capture because it runs after the
application resumes and is outside this benchmark's hot path. Line probes omit Sirun's main-thread instruction count
because capture work runs in the inspector worker.
