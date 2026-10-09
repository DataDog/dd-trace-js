# Benchmarks

GitLab CI configuration for the benchmarks that run on the
[Benchmarking Platform](https://datadoghq.atlassian.net/wiki/spaces/APMINT/pages/2419261562/Benchmarking+Platform).

## Layout

- `gitlab-ci.yml`: sirun microbenchmarks.
    - `benchmark` runs them via `bp-runner`, splitting across Node major versions and groups,
      then analyzes and converts results.
    - `benchmark-serverless` triggers a downstream pipeline in `serverless-tools`.
    - `benchmark-serverless-pr-performance` starts optional, asynchronous Lambda PR measurements.
      It forwards the commit and branch; serverless-tools resolves the PR through GitHub.
      Its failures do not block the PR, and existing regression checks keep their failure policy.
    - `benchmarks-pr-comment` posts the results as a PR comment.
    - `check-big-regressions` fails on regressions above the threshold defined on
      `bp-runner.fail-on-regression.yml`.
- `bp-runner.yml`: defines the `Run benchmarks` and `Analyze results` steps, run against
  `benchmark/sirun`.
- `container/`: base CI image for the benchmark jobs, built manually via
  `build-benchmark-ci-images`.
- `node-express-realworld-parallel` and `node-hapi-redis-parallel` stages: included in the root
  `.gitlab-ci.yml` from
  [apm-sdks-benchmarks](https://github.com/DataDog/apm-sdks-benchmarks/tree/main/.gitlab).
    - Change them there.

## Marking a benchmark as flaky

Add it to `FLAKY_BENCHMARKS_REGEX` in `.benchmarks` (the shared template in `gitlab-ci.yml`).

The benchmark still runs and reports, but doesn't fail performance quality gates:
`check-big-regressions` (percentage-based) and the `*-check-slo-breaches` jobs of the
apm-sdks-benchmarks suites (SLO-based).

- The regex matches anywhere in the scenario name.
    - `debugger-line-probe-with-snapshot` quarantines every variant of that scenario.
    - Anchor with `^...$` to target one scenario.

```yaml
FLAKY_BENCHMARKS_REGEX: "debugger-line-probe-with-snapshot|^debugger-enabled-but-breakpoint-not-hit-24$"
```

Open a ticket to fix or remove it. See
[Flaky Benchmarks Monitoring](https://datadoghq.atlassian.net/wiki/spaces/APMINT/pages/7223313012/Flaky+Benchmarks+Monitoring).

## Asynchronous Lambda PR measurements

`benchmark-serverless-pr-performance` starts a separate serverless-tools pipeline
with `PR_BENCHMARK_ENABLED` and `PR_BENCHMARK_ONLY` set to `"true"`. The trigger has
no `strategy`, so it finishes after dispatch, and `allow_failure: true` keeps a
failed dispatch from failing PR checks. The downstream lookup/build/publish job is
also allowed to fail. Results are collected by the deployed Lambda pool afterward.

The job supports branch pipelines and external GitHub PR pipelines, passing the
source commit and branch for API lookup. Default-branch, tag, native GitLab MR, and
`graphite-base/*` runs do not launch this job. No PR number is hardcoded or inferred
from a GitLab MR IID. Missing open PRs skip; ambiguous matches and API errors remain
visible in the optional downstream job.

`SLS_PR_BENCHMARK_CI_BRANCH` selects the serverless-tools branch/tag for this feature
and defaults to its `main` branch. Merge the downstream publisher before enabling
this trigger. `SLS_CI_BRANCH` independently selects the version for existing
regression tests. The jobs avoid automatic interruption once started, but this
remains best-effort measurement: failed or cancelled jobs can miss commits.
