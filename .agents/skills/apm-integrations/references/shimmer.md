# Shimmer

The [hook decision](../SKILL.md#choose-the-hook) owns when shimmer is allowed. This reference owns how to implement
that choice.

## Prefer tracing channels

Use `tracingChannel()` from `helpers/instrument` for new shimmer instrumentation. Its operators own the standard
lifecycle:

- `traceSync()` for synchronous return or throw;
- `tracePromise()` for native promise completion;
- `traceCallback()` for callback completion.

Use the operator instead of publishing matching start, end, async, and error events manually. Keep a direct
`hasSubscribers` return before setup when the operator does not already provide that fast path.

## Event-driven results

When completion belongs to events on a returned stream or request object:

1. Return directly when the start channel has no subscribers.
2. Create one context and call the original operation inside `start.runStores()`.
3. Wrap the returned object's event boundary before the `runStores()` callback returns; do not replace an
   identity-sensitive result.
4. Publish `error` with `ctx.error`, and publish `asyncEnd` on the actual terminal event.
5. Publish `end` in a `finally` block around the original call.
6. Prevent duplicate terminal publication when the upstream contract permits several terminal events.

Read the exact upstream event contract before choosing event names. Use
`packages/datadog-instrumentations/src/http2/client.js` for a returned request whose `emit` boundary defines
completion, `src/undici.js` for the standard tracing-channel fast path, and `src/azure-functions.js` for
runtime-created handler registration.

Use legacy manual channels only when the lifecycle cannot map to a tracing channel. A start event that establishes
context uses `runStores()`, never `publish()`; `src/pg.js` is the current legacy reference.
