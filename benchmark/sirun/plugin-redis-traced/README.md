# plugin-redis-traced

Measures a full traced redis command end to end: the real tracer and the real
redis plugin run `bindStart` (meta build), span start, context entry via the
start channel's `runStores`, span finish, and the processor — the integrated
per-command cost the isolated `plugin-redis` bench omits by stubbing `startSpan`.
The processor erases each trace on finish, so spans are built and finished but
nothing is encoded or sent off-process.
