---
name: serverless-integrations
description: |
  Use when adding, modifying, debugging, or reviewing dd-trace-js serverless platform integrations that create
  root invocation spans for AWS Lambda, Azure Functions, Google Cloud Functions, or similar runtimes. Triggers:
  serverless integration, function invocation root span, Lambda runtime, Azure Functions, GCP Functions,
  type = 'serverless', DD_LAMBDA_HANDLER, datadog-lambda-js, deployed serverless verification,
  manual serverless test.
---

# Serverless Integrations

Use this skill for platform-boundary instrumentation where dd-trace-js owns the function invocation lifecycle.
Use `apm-integrations` instead for ordinary library instrumentation that runs inside a serverless function.

## Decision Gate

Classify the request before touching code:

| Request shape | Skill path | Span model |
| --- | --- | --- |
| Trace a third-party library call inside Lambda/Azure/GCP | `apm-integrations` | Child spans under the invocation |
| Trace the cloud function invocation itself | This skill | Root `type = 'serverless'` span |
| Trace an HTTP, queue, or event trigger | This skill plus trigger references | Root span plus context or links |
| Change AWS Lambda bootstrap or timeout behavior | This skill | Special-case runtime wrapper path |

Do not model ordinary library plugins after the Lambda bootstrap. Lambda is a compatibility/runtime wrapper path,
not the default architecture for new integrations.

## Core Invariants

- Serverless platform integrations represent the invocation as the primary unit of work.
- Root plugins set `static kind = 'server'` and `static type = 'serverless'`.
- Use `TracingPlugin` unless a more specific local pattern clearly applies. Do not default to `ServerPlugin` just
  because the span kind is server.
- The integration owns every completion path: success, thrown error, rejected promise, callback completion,
  timeout, and runtime shutdown when the platform exposes it.
- Flush behavior must be designed around the platform freezing or terminating the process.
- Context extraction happens at the platform boundary: HTTP headers, event/message attributes, client context, or
  batch span links.
- Preserve diagnostic-channel subscriber behavior. AppSec, IAST, telemetry, and other subscribers may depend on
  published events even when the tracing plugin is disabled.
- Prefer Orchestrion for static module hooks. Use shimmer/runtime wrapping only when the platform's handler model
  requires dynamic interception, and document why.

## Workflow

1. Read `references/architecture.md` to confirm whether the work is serverless-root or ordinary APM.
2. Read `references/reference-integrations.md` and inspect at least one matching in-repo implementation.
3. For implementation work, follow `references/implementation-guide.md`.
4. For tests and deployed verification, follow `references/testing-guide.md`.

## Implementation Checklist

- Add or update instrumentation in `packages/datadog-instrumentations/` when the runtime can be observed through
  normal hooks.
- Add or update the plugin under `packages/datadog-plugin-<name>/` when spans are created from diagnostic-channel
  events.
- Register the plugin in `packages/dd-trace/src/plugins/index.js`.
- Add service naming behavior under `packages/dd-trace/src/service-naming/schemas/*/serverless.js`.
- Add docs, TypeScript config surface, and supported-integration metadata only when the user-facing configuration
  surface changes.
- For HTTP-triggered functions, reuse web helpers such as `web.patch`, `web.startServerlessSpanWithInferredProxy`,
  and `web.finishAll` when they match the trigger model.
- For batch/message triggers, extract upstream context per item when possible and use span links for multiple
  upstream contexts.

## Review Checklist

- The invocation span starts before user handler execution and finishes exactly once.
- Errors are tagged on the invocation span without crashing the user app.
- Async, promise, callback, and synchronous handlers are all covered when the runtime supports them.
- Timeout or near-shutdown behavior finishes or flushes trace data before the platform freezes execution.
- Disabled instrumentation still leaves unrelated integrations intact.
- Deployed/manual verification instructions confirm traces in Datadog, not only local unit behavior.
