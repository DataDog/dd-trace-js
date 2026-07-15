# Step 11: final > tests

- Type: required final gate

## Instructions

Run `unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER && PLUGINS=ai npm run test:plugins:ci` and any broader suite required by shared changes. Deleted, skipped, weakened, or mocked-away coverage does not pass.

This gate is verification-only: do not edit product code here. Record exact commands,
exit status, source revision, and artifact paths in a bounded `evidence/11/summary.md`.
Keep raw output in `evidence/11/raw/`. All final gates must validate the same source
state; after any code change, clear their checkmarks and restart at `final > build`.
