This benchmark measures the per-Redis-command work in
`packages/datadog-plugin-redis/src/index.js` `bindStart`. Every traced
Redis command hits this code, so per-call savings (`formatCommand` arg
loop, the `formatArg` / `trim` chain, the meta literal allocation)
compound across the command rate of any redis-fronted service.

The plugin is exercised via `Object.create(RedisPlugin.prototype)` so
the hot loop never touches diagnostic channels or a real tracer; the
stubbed `startSpan` reads two keys off the meta literal so V8 cannot
DCE the per-call object.

Variants:

- `mixed-commands` — eight realistic shapes: PING / GET / SET / HSET /
  ZADD / MGET / LPUSH / AUTH, covering 0 / 1 / 4 / many args, the AUTH
  short-circuit, and the JSON-stringified large-value case. Megamorphic
  enough to mirror a typical service's hot-path mix.
- `long-args` (`baseline: mixed-commands`) — worst case: a single SET
  with a 5KB value. Exercises the per-character accumulation in
  `formatCommand` until the 1000-char trim trips. Catches regressions
  in the trim / slice path that only show up on large payloads.
