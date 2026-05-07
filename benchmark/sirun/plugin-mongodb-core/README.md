This benchmark measures the per-mongo-op work in
`packages/datadog-plugin-mongodb-core/src/index.js` `bindStart`. Every
traced mongo op walks `getQuery` -> `limitDepth` /
`extractQuery` / `sanitizeBigInt` (a `JSON.stringify` with a reviver
for bigints), builds the meta literal, calls `serviceName` /
`startSpan`, then hits the inherited `injectDbmComment` ->
`createDbmComment` chain.

The bench instantiates a real `MongodbCorePlugin` subclass that
overrides `addTraceSubs` (skip diagnostic-channel wiring) and
`serviceName` / `startSpan` / `getPeerService` (skip tracer plumbing),
so the loop measures the per-op work end-to-end including the real
DBM comment construction. Subclassing instead of `Object.create` is
required because the parent `DatabasePlugin` uses private methods that
need a real instance.

Variants:

- `mixed-ops` — eight realistic shapes: find / insert / update /
  delete / aggregate / count / findAndModify / ping. Mix of single
  statements and arrays-of-statements; mix of flat and nested filters
  so `limitDepth`'s queue walker is exercised over a megamorphic input.
- `deep-aggregate` (`baseline: mixed-ops`) — worst case for `limitDepth`:
  a 5-stage aggregate pipeline with nested `$match` / `$group` / `$sort`
  / `$limit` operators. Exercises the queue-walker depth-limit path on
  every call. Catches regressions in any future per-pipeline cache or
  in the queue-walk shape.
