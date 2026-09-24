# Benchmarks

GitLab CI configuration for the benchmarks that run on the
[Benchmarking Platform](https://datadoghq.atlassian.net/wiki/spaces/APMINT/pages/2419261562/Benchmarking+Platform).

## Layout

- `gitlab-ci.yml`: sirun microbenchmarks.
    - `benchmark` runs them via `bp-runner`, splitting across Node major versions and groups,
      then analyzes and converts results.
    - `benchmark-serverless` triggers a downstream pipeline in `serverless-tools`.
    - `benchmarks-pr-comment` posts the results as a PR comment.
    - `check-big-regressions` fails on regressions above the threshold defined on
      `bp-runner.fail-on-regression.yml`.
- `bp-runner.yml`: defines the `Run benchmarks` and `Analyze results` steps, run against
  `benchmark/sirun`.
- `container/`: base CI image for the benchmark jobs, built manually via
  `build-benchmark-ci-images`.
- `node-express-realworld-parallel` and `node-hapi-redis-parallel` stages: included in the root
  `.gitlab-ci.yml` from
  [apm-sdks-benchmarks](https://gitlab.ddbuild.io/DataDog/apm-reliability/apm-sdks-benchmarks).
    - Change them there.

## Marking a benchmark as flaky

Add it to `FLAKY_BENCHMARKS_REGEX` in `.benchmarks` (the shared template in `gitlab-ci.yml`).

The benchmark still runs and reports, but doesn't fail the gate.

- The regex matches anywhere in the scenario name.
    - `debugger-line-probe-with-snapshot` quarantines every variant of that scenario.
    - Anchor with `^...$` to target one scenario.

```yaml
FLAKY_BENCHMARKS_REGEX: "debugger-line-probe-with-snapshot|^debugger-enabled-but-breakpoint-not-hit-24$"
```

Open a ticket to fix or remove it. See
[Flaky Benchmarks Monitoring](https://datadoghq.atlassian.net/wiki/spaces/APMINT/pages/7223313012/Flaky+Benchmarks+Monitoring).
