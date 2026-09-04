# LLM Validation — `dd-apm-sdk-review`

This directory is a [LLM Validation Platform](https://github.com/ddoghq/llm-validation-platform)
suite. It is **not** a Jest / Mocha test. The cases live here; the runner lives in the
internal platform repo (`ddoghq/llm-validation-platform`).

It answers: *did an edit to `dd-apm-sdk-review` (SKILL.md, a reviewer, or an override)
make the agent better or worse?* — by comparing **baseline** (those files at
`--base-sha`, usually `master`) against **candidate** (this working tree) under the same
model, judge, and case set.

Same gate as [`DataDog/dd-trace-dotnet#8845`](https://github.com/DataDog/dd-trace-dotnet/pull/8845).
CI includes the reusable `"llm validation"` job from the platform repo (see the top-level
`.gitlab-ci.yml`). It lives in the built-in `.post` stage, skips early when no monitored
file changed, and uses this directory's `default_level` (`gate`) unless `LLMVAL_LEVEL` is set.

## Layout

| Path | Role |
|---|---|
| [`config.yaml`](./config.yaml) | Monitored instruction files, model, `--level` presets, gate policy |
| [`suites/dd-apm-sdk-review.yaml`](./suites/dd-apm-sdk-review.yaml) | Cases (auto-discovered; do not pass this path to the CLI) |

## Prerequisites

- Docker (for the published platform image), **or** a .NET 8/10 SDK + `claude` on `PATH`
- `ddtool` on the host for real (non-`--fake`) runs — to mint a gateway token
- This `dd-trace-js` checkout, with `.llm-validation/` present

You do **not** need a checkout of `llm-validation-platform` when using Docker.

## Run locally (Docker)

The platform publishes the runner image (CLI + toolchain baked in):

`registry.ddbuild.io/ci/llm-validation-platform/llmval`

Use `:latest` or pin a pipeline id from the platform's manual `publish-llmval-image` job.
Run from the **`dd-trace-js` repo root** (the directory that contains `.llm-validation/`):

```bash
export LLMVAL_IMAGE=registry.ddbuild.io/ci/llm-validation-platform/llmval:latest
docker pull "$LLMVAL_IMAGE"

# Offline smoke — no gateway, no Claude (1 case)
docker run --rm -v "$PWD:/repo" "$LLMVAL_IMAGE" \
  --repo /repo --base-sha master --level minimum --fake

# Cheap real smoke — still 1 case (`minimum` is a case filter, not "run everything cheaply")
export LLMVAL_AUTH_HEADER="$(ddtool auth token rapid-ai-platform --datacenter us1.staging.dog --http-header)"
docker run --rm -e LLMVAL_AUTH_HEADER -v "$PWD:/repo" "$LLMVAL_IMAGE" \
  --repo /repo --base-sha master --level minimum --runs 1

# All cases in suites/ (one repeat each)
docker run --rm -e LLMVAL_AUTH_HEADER -v "$PWD:/repo" "$LLMVAL_IMAGE" \
  --repo /repo --base-sha master --level full --runs 1

# CI-shaped set (10 cases)
docker run --rm -e LLMVAL_AUTH_HEADER -v "$PWD:/repo" "$LLMVAL_IMAGE" \
  --repo /repo --base-sha master --level gate --runs 1

# One named case (id from suites/dd-apm-sdk-review.yaml)
docker run --rm -e LLMVAL_AUTH_HEADER -v "$PWD:/repo" "$LLMVAL_IMAGE" \
  --repo /repo --base-sha master --case js-security-secret-into-log --runs 1
```

`--level` picks **which cases** run. `--runs` only changes how many times **those** cases
repeat. `--case`, `--runs`, `--max-cases`, `--concurrency` override the `config.yaml`
preset. Artifacts land in this directory (`results.json`, `report.md`, `details.json`).

`ANTHROPIC_BASE_URL` defaults to the staging gateway inside the image. Override if needed:

```bash
docker run --rm \
  -e LLMVAL_AUTH_HEADER \
  -e ANTHROPIC_BASE_URL=https://ai-gateway.us1.ddbuild.io \
  -v "$PWD:/repo" \
  "$LLMVAL_IMAGE" \
  --repo /repo --base-sha master --level minimum
```

Renew `LLMVAL_AUTH_HEADER` when it expires (typical symptom: Claude/`api_error_status`:401).

## Run locally (host .NET)

From the **platform** repo, point `--repo` at **this** `dd-trace-js` checkout (the
directory that contains `.llm-validation/`), not at the suite YAML:

```bash
cd /path/to/llm-validation-platform

dotnet run --project src/Datadog.LlmValidation.Cli -- run \
  --repo /path/to/dd-trace-js \
  --base-sha master \
  --level minimum \
  --out results.json \
  --report report.md \
  --details details.json
```

Start with `--level minimum`. `gate` is the CI-shaped run and is slow / expensive.

### `--level` presets

Defined in [`config.yaml`](./config.yaml). **`--level` is a case filter, not a
cheapness knob.** `--runs N` does not expand the set — it only repeats the cases
that level already selected.

| Level | Cases | Default runs | Use |
|---|---|---|---|
| `minimum` | **1** (`js-perf-lens-ungated-publish`) | 3 | First smoke |
| `gate` (default) | **10** listed in `config.yaml` | 5 | CI-shaped |
| `full` | **every** case in `suites/` | 3 | Broader pass |

So this command runs **one** case once, not the whole suite:

```bash
docker run --rm -e LLMVAL_AUTH_HEADER -v "$PWD:/repo" "$LLMVAL_IMAGE" \
  --repo /repo --base-sha master --level minimum --runs 1
```

To run every case once, use `--level full`. To run the CI set once, use `--level gate`.

### One specific case

`--case` takes the `id` from [`suites/dd-apm-sdk-review.yaml`](./suites/dd-apm-sdk-review.yaml)
(e.g. `js-perf-lens-ungated-publish`, `js-security-secret-into-log`). It overrides
the preset’s case list; `--level` still supplies default `--runs` unless you pass `--runs`.

```bash
# Docker
docker run --rm -e LLMVAL_AUTH_HEADER -v "$PWD:/repo" "$LLMVAL_IMAGE" \
  --repo /repo --base-sha master --case js-security-secret-into-log --runs 1

# Host .NET (from the platform repo)
dotnet run --project src/Datadog.LlmValidation.Cli -- run \
  --repo /path/to/dd-trace-js \
  --base-sha master \
  --case js-security-secret-into-log \
  --runs 1 \
  --out results.json --report report.md --details details.json
```

### What a pass means

This is an A/B comparison, not an absolute score of the suite:

- **Candidate** = the working tree (`File.ReadAllText`). Uncommitted edits count; you do
  not need a commit.
- **Baseline** = `git show <base-sha>:<file>`. If a file is not on `master` yet, the CLI
  prints `note: <file> not found at master — treated as added in the PR` and compares
  *no skill vs this skill*. That is a smoke test, not “does this rubric catch the bug?”

The gate fails only on a **confident regression** (a new safety / bad signal, or a tight
pairwise loss). Noisy or marginal changes WARN and do not block.

The report also prints an advisory **Candidate criteria coverage** line (how many
`expected_criteria` the candidate met) and **Candidate bad signals (all)** (every trip,
not only ones newly introduced vs baseline). Neither changes PASS/WARN/FAIL.

Per-response `expected_criteria` / `bad_signals` / `criteria_met` land in `details.json`.
