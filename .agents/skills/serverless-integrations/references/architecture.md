# Serverless architecture

The [parent skill](../SKILL.md#classify-the-boundary) owns boundary classification. This reference maps each
serverless shape to its current implementation owner.

## Runtime path

A plugin-backed invocation follows the normal instrumentation boundary:

1. Runtime-facing instrumentation wraps handler registration or execution.
2. A diagnostic `tracingChannel` carries context without importing the tracer.
3. A plugin starts the invocation span before user code.
4. Child integrations inherit the invocation context.
5. The plugin tags and finishes the span on the runtime's completion event.

HTTP triggers may add an inferred proxy span above the invocation span. Batch triggers keep one invocation span and
link the upstream message contexts the runtime exposes.

## Current references

- Azure Functions: `datadog-instrumentations/src/azure-functions.js` publishes to
  `datadog-plugin-azure-functions`; integration tests launch Azure Functions Core Tools.
- Azure Durable Functions: `datadog-instrumentations/src/azure-durable-functions.js` publishes to
  `datadog-plugin-azure-durable-functions`; integration tests launch Core Tools with Azurite.
- AWS Lambda bootstrap: `dd-trace/src/lambda/index.js` owns handler loading and timeout flush behavior;
  `dd-trace/test/lambda/` owns its tests.

AWS Lambda is the exception. Its loader resolves `DD_LAMBDA_HANDLER` or hooks `datadog-lambda-js`, then installs the
runtime patch. `lambda/handler.js` schedules the impending-timeout channel and flushes unfinished spans before the
configured deadline. This path does not start an invocation span and is not a `TracingPlugin` integration.

## Shared serverless behavior

- `packages/dd-trace/src/serverless.js` detects AWS, GCP, and Azure environments.
- `packages/dd-trace/src/config/index.js` derives the service fallback and applies serverless defaults for telemetry,
  crash tracking, and remote configuration.
- In AWS Lambda, that config sets `flushInterval` to `0` when `DATADOG_MINI_AGENT_PATH` is absent; the exporter then
  flushes each write instead of waiting on a timer.
- `packages/dd-trace/src/service-naming/schemas/v0/serverless.js` and `v1/serverless.js` own plugin-backed operation
  and service names.
- `packages/dd-trace/src/plugins/util/web.js` owns shared HTTP and inferred-proxy behavior.

Read these owners before adding a parallel runtime check, naming rule, context extractor, or flush mechanism.
