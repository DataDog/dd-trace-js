This benchmark measures the per-query work in
`packages/datadog-plugin-pg/src/index.js` `bindStart`, including the
inherited `injectDbmQuery` -> `createDbmComment` chain in
`packages/dd-trace/src/plugins/database.js`. Every traced PostgreSQL
query hits the DBM comment construction (eight string allocations on
the master shape) and the meta literal. Per-query savings compound
across the query rate of any pg-fronted service, especially services
with high prepared-statement reuse.

The plugin is exercised via `Object.create(PGPlugin.prototype)` so the
hot loop never touches diagnostic channels or a real tracer; the
stubbed `serviceName` / `startSpan` reads two keys off the meta literal
so V8 cannot DCE the per-call object. The shared stub span returns the
same `_tags` object every call so the bench measures the plugin's
allocations, not the tag-build cost.

Variants:

- `mixed-queries` — eight realistic shapes: parameterised select /
  insert / update / delete, prepared and unnamed queries, a CTE, an
  aggregate, and a constant. Mirrors a service running quick reads
  alongside analytics queries.
- `repeated-prepared` (`baseline: mixed-queries`) — the same query
  repeated. Worst case for any per-(span, service) DBM cache: a future
  memoization should drop the per-call DBM cost to nearly zero on this
  variant, while master allocates eight strings per call regardless.
