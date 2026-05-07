This benchmark measures the per-gRPC-call work in
`packages/datadog-plugin-grpc/src/util.js` and the inline peer-parse
inside the client `finish` handler. Every traced gRPC call hits these
paths, so per-call savings scale with RPC throughput.

The plugin's pure helpers are exercised directly (no diagnostic channels
or real tracer); a tiny stub span counts `setTag` calls so V8 cannot DCE
the dispatch loop. Method paths and peer strings cover the realistic
shape distribution (zero / one / multi-package services, ipv4 / ipv6 /
unix / unix-abstract peers).

Variants:

- `method-metadata` — `getMethodMetadata` parsing the path on every call
  via `split('/')` + `serviceParts.split('.')` + `serviceParts.pop()`.
  Method paths are stable per-service definition; a regression that
  removes a future per-path cache would show up here as cold-parse cost
  on every call.
- `peer-parse` (`baseline: method-metadata`) — the inline peer parser
  the client `finish` handler runs on every RPC: `split(':')` + two
  `parts.at(-1)` reads + `parts.slice(0, -1).join(':')`. The parser is
  not exported, so the bench inlines a copy that mirrors the production
  shape exactly.

The `addMetadataTags` empty-filter short-circuit was prototyped as a
third variant but the work is small enough that V8 inlines it almost
entirely once the sentinel filter is in scope; the resulting timings
were below the JIT noise floor and the variant was dropped.
