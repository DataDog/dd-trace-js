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

Use this skill when the cloud runtime owns the unit of work or dd-trace-js manages its handler lifecycle. Use
`apm-integrations` for a third-party library call that happens inside a function.

## Classify the boundary

- Third-party library call inside Lambda, Azure, or GCP: ordinary APM child span.
- Cloud function invocation: serverless invocation span or runtime-wrapper path.
- HTTP, queue, database, or event trigger: invocation span plus trigger-specific context, inferred proxy behavior,
  or span links.
- AWS Lambda handler loading, timeout, or crash flushing: the special Lambda bootstrap path.

Do not copy the Lambda bootstrap for an npm package integration. It is a runtime compatibility path, not the plugin
architecture.

## Read the runtime source first

Do not infer lifecycle support from a provider's documentation. Read the runtime source for the supported version
range, plus the matching in-repo instrumentation, plugin, integration test, and workflow job. The source answers
what the design depends on:

1. How user handlers are registered, exported, or resolved.
2. Which completion forms exist in that version range.
3. Where the event, request, and context objects first cross into user code.
4. Whether timeout or shutdown is observable.
5. Which fields carry upstream trace context.

## Implemented shapes

### Plugin-backed invocation

Azure Functions is the current reference:

- instrumentation wraps handler registration and calls a `tracingChannel` lifecycle named
  `datadog:<platform>:<operation>`, so the plugin prefix starts with `tracing:datadog:` rather than `tracing:apm:`;
- `AzureFunctionsPlugin` extends `TracingPlugin` with `kind = 'server'` and `type = 'serverless'`;
- HTTP triggers use `web.patch`, `web.startServerlessSpanWithInferredProxy`, and `web.finishAll`;
- non-HTTP triggers start the invocation span with `childOf: null` and add message links where the runtime exposes
  upstream contexts;
- service naming is registered in both `service-naming/schemas/*/serverless.js` files.

### AWS Lambda bootstrap

`packages/dd-trace/src/lambda/` resolves `DD_LAMBDA_HANDLER`, falls back to `datadog-lambda-js`, installs the runtime
patch, and manages impending-timeout flushing. Read `index.js`, `runtime/patch.js`, `handler.js`, and the tests under
`packages/dd-trace/test/lambda/` before changing this path.

This Lambda path does not start an invocation span or use the serverless plugin model. It composes the existing
handler or `datadog-lambda-js` wrapper with timeout protection. Preserve that distinction when reviewing or
designing a new platform integration.

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

## Change map

For plugin-backed integrations, inspect and update the applicable surfaces:

- `packages/datadog-instrumentations/src/<name>.js` and `helpers/hooks.js`, where `{ serverless: false, fn }` skips
  a hook that must not load in serverless environments;
- `packages/datadog-plugin-<name>/`;
- `packages/dd-trace/src/plugins/index.js`;
- both serverless service-naming schema files;
- `versions/` fixtures, public plugin types/docs, CODEOWNERS, and the serverless workflow job.

Use Orchestrion for a static source function. Use shimmer when handler registration or export resolution is dynamic,
and leave a short comment naming that constraint.

## Verification

Read [Architecture](references/architecture.md) for ownership and source paths. Read
[Testing serverless integrations](references/testing-guide.md) for the real-runtime test shape and commands.

Local tests must exercise the runtime-facing entry point. Add deployed verification only when the change depends on
provider behavior the local runtime or emulator cannot reproduce; state the exact provider-only assumption being
checked.
