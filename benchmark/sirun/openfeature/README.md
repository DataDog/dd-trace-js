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

The standard variants cover protected and full consent using each revision's
installed provider bundle. Historical master without EVP emits no rows and does
not need consent metadata; every EVP-capable revision must receive literal true
from the real evaluator in full mode. No metadata is fabricated. The output
records `evaluationConsentMetadata` so older providers are visible.

The always-on CI matrix contains four scenarios:

- `typical`: normal context, protected mode.
- `typical-full`: normal context, full consent.
- `scale-full`: near-limit context, full consent.
- `stress-full`: oversized nested context, full consent.

The latter two measure capture near the retained-field limit and the cost of
discarding excess input. Protected-mode size variants and hostile inputs remain
available on demand, rather than multiplying the end-to-end CI matrix. This keeps
the current suite within six 24-core groups without reducing retained scenarios'
iterations, privacy checks, or startup-share assertions.

`scale-full` uses 20,000 measured evaluations on Node 20 and 40,000 on newer
runtimes through the runner's existing `operations_by_node` setting. Node 20
takes substantially longer per evaluation on both baseline and candidate:
40,000 made the candidate's 12 repetitions take over 18 minutes, leaving too
little of the 30-minute CI job for the baseline. At 20,000, Node 20 passed both
CI sides and measured below 4% setup share in workspace checks. Newer runtimes
need 40,000 to leave headroom below the unchanged 7% setup-share guard.
Both sides use the same count for each runtime; 500 warmup evaluations,
12 repetitions, context dimensions, and all delivery/privacy checks stay unchanged.

Run the additional cases from this directory:

```sh
VARIANT=scale CONSENT=false OPERATIONS=20000 WARMUP=500 node index.js
VARIANT=stress CONSENT=false OPERATIONS=2000 WARMUP=50 node index.js
for consent in false true; do
  VARIANT=hostile CONSENT="$consent" OPERATIONS=1000000 node index.js
done
```

These direct runs retain the assertions but are not repeated Sirun measurements.
The focused snapshot microbenchmarks below still cover all four input shapes.

CI compares the total PR change, including the provider upgrade. For a separate
comparison isolating tracer overhead, use the identical released provider bundle
on both sides and explicitly report this baseline-only dependency overlay:

```sh
CONSENT=true DD_BENCH_PROVIDER_MODULE=/absolute/path/to/released/provider/bundle \
VARIANT=typical OPERATIONS=1000000 node --expose-gc index.js
```

Optional DD_BENCH_SOURCE_ROOT selects an exported baseline source directory.
WARMUP defaults to 5000.
JSON output identifies the source, artifact, consent, dimensions, counts, timing,
and heap delta. Standalone runs write this summary to stdout; under Sirun
(`SIRUN_VARIANT` set), it goes to stderr so it cannot enter Sirun's NDJSON
measurement stream. Only Sirun's own records contain its `iterations` array.
`evaluationLoopNs` and `nsPerEvaluation` include benchmark admission
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
