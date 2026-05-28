This benchmark measures the per-mongo-op work in
`packages/datadog-plugin-mongodb-core/src/index.js` `bindStart`. Every traced
mongo op walks `bindStart` -> `getQuery` -> `sanitiseAndStringify`, builds the
meta literal, then calls `serviceName` / `startSpan` (the DBM-comment chain
is stubbed off so the signal is the sanitiser, not the DBM concat).

The bench instantiates a real `MongodbCorePlugin` subclass that overrides
`addTraceSubs` (skip diagnostic-channel wiring) and `serviceName` /
`startSpan` / `getPeerService` / `injectDbmComment` (skip tracer plumbing
and DBM construction), so the loop measures the per-op work end to end while
keeping the production `bindStart` shape intact. Subclassing instead of
`Object.create` is required because the parent `DatabasePlugin` uses private
methods that need a real instance.

Variants:

- `plain-find` (control) -- a flat `{ filter: { user_id, status, region },
  limit }`. Goes through the `canStringifyDirect` fast path and exits via the
  native `JSON.stringify`. Pins the per-op baseline cost; should not regress.
- `deep-aggregate` (`baseline: plain-find`) -- a 5-stage aggregation
  pipeline (`$match` / `$lookup` / `$group` / `$sort` / `$limit`) with
  nested operators. Still on the fast path, but exercises the deeper
  walk in `canStringifyDirect` and the longer `JSON.stringify` output.
  Catches regressions in either the fast-path probe or any future
  per-pipeline caching.
- `bigint-id` (`baseline: plain-find`) -- a sharded read whose `_id`
  overflows `Number.MAX_SAFE_INTEGER` and arrives as a native bigint.
  Disqualifies the fast path and forces the manual walker on every call.
  Every customer that shards on 64-bit ids hits this shape on every read.
- `binary-hash` (`baseline: plain-find`) -- a Buffer-typed query field
  (32-byte SHA-256 hash, content-addressable lookup, idempotency key,
  etc.). The driver accepts Buffer in place of `BSON.Binary` for
  binary columns; binary fields are common in production mongodb
  workloads (hash indexes, blob references, idempotency keys). This
  shape disqualifies the fast path, pinning the slow path's cost on a
  realistic per-op shape.
- `mixed-ops` (`baseline: plain-find`) -- eight realistic shapes
  (`find` / `insert` / `update` / `delete` / `aggregate` / `count` /
  `findAndModify` / `ping`) interleaved. Megamorphic input, closest to
  what a busy customer's process actually feeds the plugin.

Expected noise budget: `wall.time.stddev_pct` ≤ ~3 % overall (control
variant ≤ ~1 % since it is fully synchronous);
`instructions.stddev_pct` ≤ ~0.5 % on every variant. Total wall-clock
per variant ≈ 1 min at 30 iterations.
