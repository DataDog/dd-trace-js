# Testing serverless integrations

Use the real local entry point:

- Azure Functions: launch Core Tools and assert through `FakeAgent`.
- Azure triggers and Durable Functions: copy emulator, readiness, and fixture setup from the current serverless
  workflow.
- AWS Lambda bootstrap: exercise handler registration and wrapping through `packages/dd-trace/test/lambda/`.

Cover only lifecycle forms the supported runtime exposes: success, thrown/rejected errors, supported sync/callback
forms, disabled instrumentation, child parenting, carrier extraction, batch-link cardinality, HTTP/AppSec behavior,
and one finish per started span. Use fake timers for timeout boundaries.

For plugin-backed paths, assert the naming-schema result, `serverless` span type, service, low-cardinality resource,
platform tags, parentage, and links. Do not assume the invocation span is the trace root when inferred proxies exist.

Run the focused fixture command from `.github/workflows/serverless.yml`; run Lambda specs with:

```bash
npm run test:lambda
```

Use deployed verification only when a provider behavior cannot be reproduced locally. Record runtime/version,
region, probe id, trace query, expected parentage, timeout, and cleanup; confirm the trace reaches Datadog.
