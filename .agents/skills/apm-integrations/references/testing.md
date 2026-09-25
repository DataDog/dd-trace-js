# Testing integrations

Load the real plugin with the test agent and call the installed library's public entry point. Start the trace
assertion before the operation; await both together when both are asynchronous. Let `agent.close()` own teardown.

## Versions and module formats

- Read supported ranges from instrumentation and pin only the latest tested release in
  `packages/dd-trace/test/plugins/versions/package.json`.
- Use `withVersions` from the current setup helper; run `yarn services` only to materialize its generated fixtures.
- Exercise each CJS/ESM implementation that differs in upstream source.
- For sandbox variants, read the current `varySandbox` signature. Non-empty named exports require
  `namedExportBinding`; its supported modes are `destructure`, `direct`, and `namespace`, with `direct` limited to
  one export.

## Cases

First find the closest integration in the same category (database, queue, cache, web, client, log), plus the specs of
shared helpers it uses (e.g. `packages/datadog-instrumentations/test/helpers/pool-acquire.spec.js` for pools). They
are the minimum contract: list every case they pin as `ported` or `skipped: <upstream difference>`, and port each
with its exact assertions. Then cover
success/error, each completion form upstream exposes, enabled/disabled tracing, parenting, version boundaries, and
sibling operations sharing changed instrumentation. Assert observable spans, propagated values, or channel effects
rather than plugin internals.

Sandbox processes do not contribute to nyc coverage. Keep a same-process path for changed production branches when
needed.

## Commands

Unset `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER`, and `OTEL_METRICS_EXPORTER` before span assertions.
Use the owning workflow's `PLUGINS` value:

```bash
PLUGINS="<name>" yarn services
PLUGINS="<name>" npm run test:plugins
./node_modules/.bin/mocha packages/dd-trace/test/plugins/plugin-structure.spec.js
```

For service-backed tests, use the workflow's Docker service and `SERVICES` values:

```bash
docker compose up -d <service>
SERVICES="<service>" PLUGINS="<name>" npm run test:plugins:ci
```

Add `SPEC="<prefix>"` to the test command when the workflow narrows the spec selection.
Run nyc with `--include` scoped to changed production files and inspect changed lines and branches.
