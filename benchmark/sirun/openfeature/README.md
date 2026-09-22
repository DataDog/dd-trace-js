# OpenFeature evaluation and incremental EVP cost

Runs the real SDK and Datadog provider on baseline and candidate source. Every
evaluation must return the configured boolean and variant. The baseline has no
EVP collector; the candidate must deliver exactly all warmup and measured
evaluations. I/O alone is replaced with a synchronous request sink. Deferred
queue draining runs every 256 evaluations, below the 4096 queue cap.

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
and heap delta. Heap delta is an allocation diagnostic, not retained memory.

Inputs: typical has three scalar fields plus targeting key; scale adds 256
fields; stress adds 10,000 nested objects with overlong strings; hostile includes
a cycle, million-element array, throwing accessor and throwing nested proxy.
Full snapshots bound selected values, but Object.keys still enumerates ordinary
object names. SDK context merging also copies root fields in both versions.

Sirun automatically discovers benchmark directories; helper-only production
changes already run standard scenarios. No source-path selection file exists.
The shared context fixture lives inside this scenario so copying the candidate's
benchmark/sirun tree to the baseline also copies every benchmark dependency.
Candidate-only capture, queue-full, enqueue/discard, aggregation and complete
enqueue/drain/serialize microbenchmarks remain in benchmark/openfeature.js.
