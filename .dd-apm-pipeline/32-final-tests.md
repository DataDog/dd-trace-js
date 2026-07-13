# Step 32: final > tests

- Type: required final gate
- Objective: Prove all required tests pass against the current implementation.

## Instructions

Start with the tracer adapter's targeted command:

```bash
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER && PLUGINS=genkit npm run test:plugins:ci
```

Test path: `packages/datadog-plugin-genkit/test/index.spec.js`. Also run any broader suite required by the repository for the
changed shared code. Pass only when every required test exits zero. Deleted, skipped,
weakened, or mocked-away coverage is a failure. Record commands, counts, exit statuses,
and log paths in `PROGRESS.md`.

## Completion

Mark this gate complete in `PROGRESS.md` only with concrete evidence from the current
source state. If this gate causes any code change, clear all final-gate
checkmarks and restart at `final > build`.
