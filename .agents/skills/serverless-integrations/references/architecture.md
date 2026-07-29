# Serverless architecture

The ownership boundary distinguishes serverless integration work from ordinary APM. A cloud runtime owns the
invocation; an npm package owns a library operation inside it.

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

| Shape | Instrumentation | dd-trace-js responsibility | Tests |
| --- | --- | --- | --- |
| Azure Functions | `datadog-instrumentations/src/azure-functions.js` | invocation spans in `datadog-plugin-azure-functions` | plugin integration tests with Azure Functions Core Tools |
| Azure Durable Functions | `datadog-instrumentations/src/azure-durable-functions.js` | invocation spans in `datadog-plugin-azure-durable-functions` | plugin integration tests with Core Tools and Azurite |
| AWS Lambda bootstrap | `dd-trace/src/lambda/index.js` | handler loading and timeout flush | `dd-trace/test/lambda/` |

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
