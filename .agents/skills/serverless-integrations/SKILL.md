---
name: serverless-integrations
description: |
  Use when adding, modifying, debugging, or reviewing dd-trace-js serverless platform integrations that own a cloud
  function invocation. Requests include "add a serverless integration", "instrument a function invocation", and
  "run a manual serverless test". Also use for "fix Lambda tracing", "add Azure Functions tracing", and
  "debug GCP Functions tracing". Trigger on serverless invocation spans, runtime bootstraps, DD_LAMBDA_HANDLER,
  datadog-lambda-js, timeout flushes, and deployed checks.
---

# Serverless integrations

This skill owns the serverless delta: invocation boundaries, runtime lifecycle, flushing, and deployed
verification. Follow the [APM execution sequence](../apm-integrations/SKILL.md#execution-sequence) for shared
instrumentation, plugin, registration, and test mechanics.

Use `apm-integrations` alone for a third-party library call that happens inside a function.

## Classify the boundary

- Third-party library call inside Lambda, Azure, or GCP: ordinary APM child span.
- Cloud function invocation: serverless invocation span or runtime-wrapper path.
- HTTP, queue, database, or event trigger: invocation span plus trigger-specific context, inferred proxy behavior,
  or span links.
- AWS Lambda handler loading, timeout, or crash flushing: the special Lambda bootstrap path.

Do not copy the Lambda bootstrap for an npm package integration. It is a runtime compatibility path, not the plugin
architecture.

## Read the runtime source first

Use the [APM source-retrieval procedure](../apm-integrations/SKILL.md#read-upstream-source-first), then read the
matching in-repo instrumentation, plugin, integration test, and workflow job. Do not infer lifecycle support from
provider documentation. The serverless design depends on:

1. How user handlers are registered, exported, or resolved.
2. Which completion forms exist in that version range.
3. Where the event, request, and context objects first cross into user code.
4. Whether timeout or shutdown is observable.
5. Which fields carry upstream trace context.

## Implemented shapes

The repository has plugin-backed invocation spans and the separate AWS Lambda bootstrap. Read
[Architecture](references/architecture.md) before choosing a shape; do not combine their responsibilities.

## Invariants

- Start the invocation span before user code and run child instrumentation under its context.
- Finish each started span exactly once on every completion path the runtime actually supports. Decide completion
  from recorded state, such as a result or error present on the context or a flag set once, never from the ordering
  of a timer against the handler.
- Keep instrumentation failures from escaping into the user handler.
- Extract distributed context at the runtime boundary. Use links when one invocation has several upstream contexts.
- Keep resource names low-cardinality; request ids, message ids, object keys, and payload values are tags or omitted,
  not resource-name components.
- Preserve diagnostic-channel events needed by AppSec, IAST, telemetry, or other subscribers when tracing is
  disabled.
- When the runtime can freeze or terminate the process, verify the writer and flush path against that real lifecycle.

Do not prescribe callbacks, streams, or shutdown hooks unless the target runtime exposes them. The upstream source
and supported version range define the matrix.

## Apply shared mechanics

For plugin-backed integrations, follow the
[APM execution sequence](../apm-integrations/SKILL.md#execution-sequence) and
[testing reference](../apm-integrations/references/testing.md). The serverless additions are both serverless
naming-schema files, the serverless workflow job, and a runtime-facing fixture.

Apply the shared hook decision to the runtime source. Runtime-created handler registration is the common
serverless reason shimmer wins.

## Verification

Read [Architecture](references/architecture.md) for ownership and source paths. Read
[Testing serverless integrations](references/testing-guide.md) for the runtime and deployed verification contract.
