# Reference integrations

Read a complete runtime path before implementing or reviewing a serverless change.

## Plugin-backed invocation spans

- Azure HTTP functions:
  `datadog-instrumentations/src/azure-functions.js`, `datadog-plugin-azure-functions/src/index.js`, and
  `datadog-plugin-azure-functions/test/integration-test/http-test/`.
- Azure Service Bus: the same instrumentation and plugin with `integration-test/servicebus-test/`.
- Azure Event Hubs: the same instrumentation and plugin with `integration-test/eventhubs-test/`.
- Azure Cosmos DB trigger: the same instrumentation and plugin with `integration-test/cosmosdb-test/`.
- Azure Durable Functions:
  `datadog-instrumentations/src/azure-durable-functions.js`,
  `datadog-plugin-azure-durable-functions/src/index.js`, and
  `datadog-plugin-azure-durable-functions/test/integration-test/`.

Paths in the table are relative to `packages/`; workflow job fragments refer to `.github/workflows/serverless.yml`.

Read the Azure Functions path for runtime-created registration, HTTP inferred proxies, non-HTTP resources, batch
span links, and Azure Functions Core Tools fixtures. Read the durable path for a separate runtime lifecycle and its
Azurite-backed launcher; do not assume its completion event matches the ordinary Azure Functions plugin.

## AWS Lambda bootstrap

| Responsibility | Owner |
| --- | --- |
| Disabled-instrumentation gate and handler resolution | `packages/dd-trace/src/lambda/index.js` |
| Runtime API wrapping | `packages/dd-trace/src/lambda/runtime/patch.js` |
| Context extraction | `packages/dd-trace/src/lambda/context.js` |
| Impending-timeout scheduling and crash flush | `packages/dd-trace/src/lambda/handler.js` |
| Registration and lifecycle tests | `packages/dd-trace/test/lambda/` |

This path does not create the Lambda invocation span. Use it only for handler loading, runtime compatibility, and
flush behavior.

## Shared owners

- Runtime detection: `packages/dd-trace/src/serverless.js`.
- Serverless configuration defaults and service fallback: `packages/dd-trace/src/config/index.js`.
- Invocation operation and service names: `packages/dd-trace/src/service-naming/schemas/v0/serverless.js` and
  `v1/serverless.js`.
- HTTP and inferred-proxy behavior: `packages/dd-trace/src/plugins/util/web.js`.
- Generic tracing lifecycle: `packages/dd-trace/src/plugins/tracing.js`.
- Runtime and emulator matrix: `.github/workflows/serverless.yml`.

## Selection checks

- A library used inside a function is ordinary APM; switch to `apm-integrations`.
- A provider event source does not automatically require a new plugin. First check whether an existing invocation
  plugin already receives that trigger through the same runtime registration API.
- A Lambda timeout symptom does not automatically belong in `lambda/handler.js`. Trace it through the extension,
  bootstrap, writer, and active-span owner before choosing the layer.
- A locally passing direct handler call is not a serverless integration test. Use the provider runtime or emulator
  whenever it can reproduce the path.
