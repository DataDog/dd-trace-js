This benchmark compares the MariaDB query hot path across the legacy plugin, direct pipeline-stage, and shared
processor/adapter implementations. Every candidate is driven through the same `apm:mariadb:query:start` and `finish`
channel boundary, so the v2 callback/promise and v3 command instrumentations are represented without measuring a
database server.

Span export is stubbed, but accepted calls allocate a real `DatadogSpanContext` and exercise resource/tag
construction, legacy-store binding, DBM-stage dispatch, and database finalization. Variants cover direct query facts,
pool query facts with `mariadb.pool.wait_time`, and disabled tracing. The fixture ring prevents per-iteration setup
from dominating the result; each process warms the selected path for at least one second and pins span/context
cardinality before and after the timed loop.

For a quick local sample against any checkout:

```sh
LOCAL_BENCHMARK_REPORT=true \
STARTUP_GUARD_REPORT=/tmp/ddtrace-mariadb-pipeline-startup \
BENCHMARK_REPOSITORY_ROOT=/path/to/dd-trace-js \
VARIANT=direct OPERATIONS=1000000 node index.js
```

The measured comparison and architecture assessment live in
[`INTEGRATION_PIPELINE_COMPARISON.md`](../../../packages/datadog-plugin-mariadb/INTEGRATION_PIPELINE_COMPARISON.md).
