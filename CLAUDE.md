See @AGENTS.md

## HTTP server request exclusion (`#5657`)

Incoming HTTP requests are excluded from traces through one shared path,
`excludeRequest` in `packages/dd-trace/src/plugins/util/web.js`. It tags the
span with `manual.drop`, forces a `USER_REJECT` sampling priority (overriding a
keep decision made upstream), and sets `_trace.isRecording = false` so the
span processor never exports the trace. The span still runs its lifecycle, so
context propagation, AppSec, and framework plugins keep working.

Two inputs feed that path:

- `blocklist` / `allowlist` URL filters, applied in `web.setConfig`.
- `DD_TRACE_HTTP_SERVER_OPTIONS_REQUESTS_ENABLED=false`, applied once at span
  creation in `web.startServerlessSpanWithInferredProxy` so the serverless path
  (Azure Functions), which never calls `setConfig`, is covered too.

The OPTIONS setting is environment-only (no `tracer.init()` or plugin option),
shared with every plugin through `PluginManager#getSharedConfig`, defaults to
`true` through v7, and is flipped to `false` from v8 in
`packages/dd-trace/src/config/major-overrides.js`. After editing
`supported-configurations.json`, run `node scripts/generate-config-types.js`.

Relevant tests:

```bash
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
./node_modules/.bin/mocha packages/dd-trace/test/plugins/util/web.spec.js --grep "request exclusion"
./node_modules/.bin/mocha packages/dd-trace/test/config/index.spec.js --grep "HTTP server OPTIONS"
PLUGINS="http|http2|express" npm run test:plugins
```
