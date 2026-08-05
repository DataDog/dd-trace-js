# Reference Integrations

Read a matching reference before implementing or reviewing a serverless integration.

## Preferred Plugin Model

- `packages/datadog-plugin-azure-functions/src/index.js`
  - root serverless invocation plugin;
  - HTTP trigger support through web helpers;
  - non-HTTP trigger support and span links;
  - `static kind = 'server'` and `static type = 'serverless'`.

- `packages/datadog-plugin-azure-durable-functions/src/index.js`
  - serverless-style plugin with durable-function-specific lifecycle handling;
  - finish only when the runtime result or error is available.

## AWS Lambda Bootstrap Path

- `packages/dd-trace/src/lambda/index.js`
  - Lambda registration and `DD_LAMBDA_HANDLER` resolution;
  - special-case hook path for `datadog-lambda-js`;
  - disabled instrumentation gate.

- `packages/dd-trace/src/lambda/handler.js`
  - timeout protection and crash flush behavior.

- `packages/dd-trace/src/lambda/runtime/patch.js`
  - raw handler/runtime wrapping.

Use this path only for AWS Lambda bootstrap work or an equivalent runtime wrapper problem. Do not copy it for normal
npm package integrations.

## Shared Serverless Files

- `packages/dd-trace/src/serverless.js`
  - runtime detection for AWS, GCP, and Azure.

- `packages/dd-trace/src/config/index.js`
  - service-name fallback and serverless flush behavior.

- `packages/dd-trace/src/plugins/tracing.js`
  - `TracingPlugin` behavior used by serverless plugins.

- `packages/dd-trace/src/plugins/util/web.js`
  - HTTP/serverless helpers, inferred proxy spans, and finish helpers.

- `packages/dd-trace/src/service-naming/schemas/v0/serverless.js`
- `packages/dd-trace/src/service-naming/schemas/v1/serverless.js`
  - serverless service naming rules.

## Normal APM References

When the work is a library integration used inside a function, stop using this skill and use `apm-integrations`.
The correct reference set is the normal instrumentation/plugin pair for the library category.
