Real-world bench. IAST's per-request taint-tracking cost, isolated from the
express / network / subprocess machinery of the `appsec-iast` live bench. A
request opens a transaction, taints its inputs (sources), and every instrumented
sink checks `isTainted` / `getRanges` on its argument. Variants: `request-lifecycle`
(open + taint + check tainted and untainted sinks + close) and `sink-check` (the
per-sink check looped). Backed by the native `@datadog/native-iast-taint-tracking`
through the production `operations.js` wrapper.
