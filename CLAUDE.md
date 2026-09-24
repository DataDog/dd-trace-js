# CLAUDE.md

See @AGENTS.md for repository-wide agent guidance.

## React Router Framework Mode (`#5486`)

Official APM support for React Router v7+ Framework Mode lives in:

- `packages/datadog-instrumentations/src/react-router.js` — wraps
  `createRequestHandler` and injects Datadog `ServerInstrumentation`
  into `build.entry.module.instrumentations` (and legacy
  `unstable_instrumentations`).
- `packages/datadog-plugin-react-router/src/index.js` — tags the active
  Express/http span with `http.route` from matched patterns, and creates
  `react-router.loader` / `react-router.action` child spans.

Requires `react-router` >= 7.9.5. No application code changes are needed
when the tracer is loaded before the app (`node --import dd-trace/register.js`).

Run plugin tests:

```bash
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
PLUGINS="react-router" npm run test:plugins
```
