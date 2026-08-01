# Reference plugins

Choose a reference by hook, lifecycle, and plugin base—not by a similar package name. Read the instrumentation,
plugin, tests, and workflow job together; no single file carries the complete contract.

## Vetted reference pairs

- Legacy database query:
  `datadog-instrumentations/src/pg.js` and `datadog-plugin-pg/src/index.js`.
  Use for manual channels, DB tags, DBM injection, and service configuration.
- Cache command:
  `datadog-instrumentations/src/redis.js` and `datadog-plugin-redis/src/index.js`.
  Use for `CachePlugin.startSpan(options, ctx)` and command resources.
- HTTP client:
  `datadog-instrumentations/src/fetch.js` and `datadog-plugin-fetch/src/index.js`.
  Use for an existing tracing-channel boundary and `HttpClientPlugin` behavior.
- Generic RPC client:
  `datadog-instrumentations/src/grpc/client.js` and `datadog-plugin-grpc/src/client.js`.
  Use for client propagation, metadata, and callback completion.
- HTTP server:
  `datadog-instrumentations/src/http/server.js` and `datadog-plugin-http/src/server.js`.
  Use for request lifecycle, web helpers, errors, and status.
- Router or middleware:
  `datadog-instrumentations/src/express.js` and `datadog-plugin-express/src/index.js`.
  Use for `RouterPlugin`, which does not use the `TracingPlugin` lifecycle.
- Producer and consumer:
  `datadog-instrumentations/src/kafkajs.js` and `datadog-plugin-kafkajs/src/index.js`.
  Use for a composite split, propagation, and DSM.
- Orchestrion async methods:
  `helpers/rewriter/instrumentations/bullmq.js` and `datadog-plugin-bullmq/src/index.js`.
  Use for several async source hooks and a role-specific composite plugin.
- Orchestrion iterator:
  `helpers/rewriter/instrumentations/langgraph.js` and `datadog-plugin-langgraph/src/stream.js`.
  Use for `returnKind: 'AsyncIterator'` and the second `:next` channel.
- Multiple module prefixes:
  `helpers/rewriter/instrumentations/graphql.js` and `datadog-plugin-graphql/src/execute.js`.
  Use for one logical operation emitted by two packages.
- Runtime-created handler:
  `datadog-instrumentations/src/azure-functions.js` and `datadog-plugin-azure-functions/src/index.js`.
  Use for justified shimmer and real runtime-launcher tests.
- Event-driven result:
  `datadog-instrumentations/src/http2/client.js` and `datadog-plugin-http2/src/client.js`.
  Use for returned request identity and emitted completion events.
- Log correlation:
  `datadog-instrumentations/src/pino.js` and `datadog-plugin-pino/src/index.js`.
  Use for `LogPlugin` correlation without span creation.

Paths in the table are relative to `packages/` unless they start with `helpers/`; those are relative to
`packages/datadog-instrumentations/src/`.

## Reading order

1. Read the exact upstream function and completion contract.
2. Read the reference instrumentation and list every event and context field it emits.
3. Read the plugin base before the reference plugin override.
4. Read the reference tests for version loading, real API use, errors, disabled behavior, and module formats.
5. Read the workflow job for services, Node versions, and the command that selects the tests.
6. Copy the structure, then replace every library-specific assumption with one proven by the target source.

## Selection checks

- A database-shaped library is not enough to choose `DatabasePlugin`; verify it needs the database naming,
  service, DBM, and peer-service behavior that base supplies.
- A method returning a promise is not enough to choose Orchestrion `Async`; verify the returned object is a native
  promise or that preserving a subclass or thenable identity is sufficient.
- A web framework is not enough to choose `RouterPlugin`; choose it only when middleware routing behavior is the
  integration's contract.
- A package with several methods is not enough to choose `CompositePlugin`; use it when those methods need distinct
  prefixes, bases, or configuration keys.
- A reference using manual channels does not make manual channels the default. Prefer a tracing channel or
  Orchestrion unless the target lifecycle cannot map to them.

## Test references

Use the test beside the selected plugin first. For cross-cutting helpers:

- naming schemas: `packages/dd-trace/test/setup/mocha.js` (`withNamingSchema`);
- peer service: the same module (`withPeerService`);
- ESM import variants: `integration-tests/helpers/index.js` (`varySandbox`);
- mock-agent assertions: `packages/dd-trace/test/plugins/agent.js`;
- structural registration: `packages/dd-trace/test/plugins/plugin-structure.spec.js`.
