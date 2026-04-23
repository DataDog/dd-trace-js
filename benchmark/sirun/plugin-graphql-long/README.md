Long-workload variant of `plugin-graphql`.

Runs many sequential GraphQL queries per process so per-query cost
amortizes past the fixed startup + plugin-setup costs (tracer init,
orchestrion rewrite of `graphql/execution/execute.js`, schema walk).

Variants mirror `plugin-graphql` but with `QUERIES=100` so the
measurement reflects steady-state per-query CPU rather than startup.
This is closer to how real graphql servers behave — thousands of
requests per process lifetime rather than cold-start-and-exit.
