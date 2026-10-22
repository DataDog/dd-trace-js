# Shimmer

Use `tracingChannel()` from the current instrumentation helper and its sync, promise, or callback operator when the
upstream contract maps to one. Return before context allocation when the relevant channel has no subscribers.

For an event-driven returned object:

1. Preserve the object's identity.
2. Create one context and call the original inside the start channel's `runStores()`.
3. Wrap its existing event boundary before returning.
4. Publish the error on the error event and completion on the actual terminal event.
5. Publish `end` in a `finally` around the original call.
6. Guard duplicate terminal events when upstream permits them.

Forward the receiver and arguments exactly. Keep legacy manual channels only when the lifecycle cannot map to a
tracing channel. Verify the chosen event and identity contract in upstream source, not from another integration.
