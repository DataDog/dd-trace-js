This benchmark measures the apollo-style signature pipeline in
`packages/datadog-plugin-graphql/src/tools/signature.js`. Apollo Server,
Yoga, and Mercurius all hand the same parsed `DocumentNode` to the plugin's
signature builder on every `execute`, so per-call savings (memoization,
walk consolidation) compound across the request rate of any graphql server.

The bench wires graphql's `visitor`, `printer`, and `utilities` modules into
`globalThis[Symbol.for('dd-trace')]` directly, bypassing the production
`addHook` plumbing, so the hot loop only measures the signature pipeline
itself.

Variants:

- `same-document` — repeatedly sign one parsed `DocumentNode`. Worst case
  for any future memoization regression: every iteration is a cache hit, so
  a regression that breaks memoization shows up immediately as cold-pipeline
  cost.
- `rotating-documents` (`baseline: same-document`) — rotate through eight
  realistic queries (variables, aliases, fragments, multi-operation,
  directives, list / object literals, deep selections). Mimics a service
  handing distinct queries from its own document cache; combines warm and
  cold paths in a stable proportion.
