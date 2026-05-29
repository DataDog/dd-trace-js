Measures the per-message websocket span-pointer hot path: `incrementWebSocketCounter`
and `buildWebSocketSpanPointerHash` (three bigint->hex conversions plus concat).
The `pointer-and-link` variant adds the `createWebSocketSpanContext` allocation
that backs the span link. Drives the real plugin util functions over a span
context with distributed tracing context.
