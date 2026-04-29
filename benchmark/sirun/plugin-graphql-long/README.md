Long-workload variant of `plugin-graphql`. Runs many sequential GraphQL
queries per process so per-query cost amortizes past the fixed startup
+ plugin-setup cost (tracer init, orchestrion rewrite of
`graphql/execution/execute.js`, schema parse, instrumentation one-time
work).

The query and variants mirror `plugin-graphql` exactly; only the loop
size differs (default `QUERIES=100` vs 6 in `plugin-graphql`). The
existing 6-query bench is preserved for catching regressions in the
startup path; this sibling catches regressions in the steady-state
per-query path.

`QUERIES` is parametric so the same bench can be re-aimed at larger
sizes (e.g. `QUERIES=500`) without forking the directory.
