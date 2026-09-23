# OpenFeature evaluation and incremental EVP cost

Runs the real SDK and Datadog provider on baseline and candidate source. Every
evaluation must return the configured boolean and variant. A loopback HTTP
collector in a separate child process receives actual production worker requests; hashing, aggregation,
serialization, networking and worker lifecycle are not stubbed. Historical
baselines without EVP remain supported and collect no rows.
The independent collector acknowledges requests even when stress-context merging
blocks the application thread, preventing benchmark-induced HTTP timeout retries.
Its CPU and memory are excluded from SDK-process measurements. The core-only child
binds loopback, strips preloads, has a 15-second ready/error deadline and a
5-second cleanup deadline. Process-tree profilers must filter the collector PID.

Normal runs pace admission only when the production input capacity is exhausted,
and yield every 256 evaluations. This is benchmark-only pacing, included in
evaluation-loop time; it is not uninterrupted application behavior. Every
preflight, warmup and measured evaluation must be delivered with zero drops.
The preflight is flushed to establish worker readiness even with WARMUP=0;
preflight and warmup delivery finish before timing starts. Worker startup is
therefore setup cost and remains included in the startup-share guard.

`SATURATED=true` disables admission pacing and periodic yields in the measured
loop, exercising uninterrupted SDK evaluation and the actual shared input cap.
It requires delivered counts plus input-capacity drops to equal attempted counts,
rejects other drop reasons, and retains the same raw privacy checks. Example:

```sh
STARTUP_GUARD_REPORT=/dev/null SATURATED=true OPERATIONS=100000 WARMUP=0 node index.js
```

Report mode is appropriate for short correctness smoke checks. Normal/CI runs
retain the unchanged startup-share assertion; a one-operation run without report
mode is expected to fail it. Final drain cannot dilute that guard because it is
evaluated immediately after the measured evaluation loop.

The standard variants use protected consent and the repository's installed
provider bundle. They remain runnable on master before EVP exists. Full consent
requires upstream evaluation-time metadata; no metadata is fabricated. To
measure that mode before publication, explicitly supply the exact staged bundle:

```sh
CONSENT=true DD_BENCH_PROVIDER_MODULE=/absolute/path/to/provider/bundle \
VARIANT=typical OPERATIONS=1000000 node --expose-gc index.js
```

Full mode fails if real result metadata does not contain literal true. Add full
CI variants when the dependency upgrade is available on both comparison sides.
Optional DD_BENCH_SOURCE_ROOT selects an exported baseline source directory.
Use the identical provider artifact for both sides. WARMUP defaults to 5000.
JSON output identifies the source, artifact, consent, dimensions, counts, timing,
and heap delta. `evaluationLoopNs` and `nsPerEvaluation` include benchmark admission
checks, capacity waits and scheduled yields. `admissionWaitNs` isolates capacity
waits; `evaluationElapsedNs` subtracts only those waits and is not a pure provider
microbenchmark. `drainElapsedNs` measures final delivery and actual worker exit;
`elapsedNs` is evaluation-loop plus drain time. Both worker and same-thread
historical writers use the real HTTP collector. Heap delta is an allocation
diagnostic, not retained memory.
`collected`, `rows`, and `bytes` include setup traffic; their `measured*` counterparts
exclude all preflight/warmup traffic. `delivery` identifies worker, historical
same-thread, or absent EVP delivery; `workerCount` counts production workers only.

Inputs: typical has three scalar fields plus targeting key; scale adds 256
fields; stress adds 10,000 nested objects with overlong strings; hostile includes
a cycle, million-element array, throwing accessor and throwing nested proxy.
Full snapshots bound selected values, but Object.keys still enumerates ordinary
object names. SDK context merging also copies root fields in both versions.

Sirun automatically discovers benchmark directories; helper-only production
changes already run standard scenarios. No source-path selection file exists.
The shared context fixture lives inside this scenario so copying the candidate's
benchmark/sirun tree to the baseline also copies every benchmark dependency.
Candidate-only capture and aggregation microbenchmarks remain in
`benchmark/openfeature.js`. Its explicitly named `consumer-only` cases isolate
enqueue/discard, queue-full rejection and enqueue/drain/serialize inside the
consumer with a synchronous transport sink. They exclude producer admission,
worker scheduling/copying and actual network I/O; use this sirun scenario for
the production worker path.
