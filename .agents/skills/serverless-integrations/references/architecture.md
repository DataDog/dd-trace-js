# Serverless Architecture

## Mental Model

Serverless APM is a thin, platform-aware layer over the normal dd-trace-js tracer and plugin system. The main
difference is ownership: a serverless platform integration owns the function invocation as the root operation, while
ordinary APM integrations create child spans for library calls that happen during that invocation.

The normal dd-trace-js path is:

1. Instrumentation hooks a library or runtime boundary.
2. Instrumentation publishes trace-agnostic diagnostic-channel events.
3. A plugin subscribes to events and starts, tags, and finishes spans.
4. The tracer encodes and flushes spans through the configured writer.

The serverless root path adds stricter lifecycle constraints:

1. Detect the cloud runtime and load only the needed integration path.
2. Wrap or bind the platform handler before user code executes.
3. Start the invocation span at the platform boundary.
4. Extract distributed context from the trigger.
5. Run user code and any child instrumentation under the invocation context.
6. Finish or mark the span on every success, error, timeout, or shutdown path.
7. Flush before the provider freezes or terminates the process.

## Classification

Ask "what owns the unit of work?"

- If the cloud provider owns it, this is a serverless platform integration.
- If a third-party npm package owns it, this is a normal APM integration even when used in a function.
- If one platform invocation can contain multiple upstream contexts, keep one invocation span and represent the
  upstream relationships with extraction plus span links where applicable.

## Existing Runtime Shapes

AWS Lambda is currently special-cased in `packages/dd-trace/src/lambda/`. It resolves `DD_LAMBDA_HANDLER` when
available, otherwise hooks `datadog-lambda-js`, then wraps the handler to manage timeout protection and crash flush.
Treat this as legacy/runtime bootstrap behavior rather than the template for ordinary integrations.

Azure Functions is closer to the preferred plugin model. `packages/datadog-plugin-azure-functions` extends
`TracingPlugin`, declares `kind = 'server'` and `type = 'serverless'`, handles HTTP and non-HTTP triggers, and uses
web helpers for inferred proxy behavior.

## Serverless Configuration Effects

Serverless detection and configuration live primarily in:

- `packages/dd-trace/src/serverless.js`
- `packages/dd-trace/src/config/index.js`
- `packages/dd-trace/src/service-naming/schemas/*/serverless.js`

Important effects include serverless service-name fallback, immediate flush behavior when no mini-agent ready file is
available, and reduced startup work in code paths that must stay cheap during cold start.
