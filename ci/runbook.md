# Datadog Test Optimization Validation Runbook

You are running inside the repository that needs Datadog Test Optimization validation.

Your task is to discover how tests are run, write a validation manifest, run the deterministic
Datadog validator, and report the result. Do not debug Datadog internals and do not add Datadog
instrumentation during discovery.

Use this file as the execution path. Read reference docs only when a step needs more detail:

- `ci/test-optimization-validation-runbook-reference.md`: CI/provider discovery, manifest fields,
  command roles, dependency setup, and generated test strategy details.
- `ci/test-optimization-validation-runbook-troubleshooting.md`: sandbox blockers, diagnosis
  language, reporting shape, and common failure interpretation.

Write the manifest to:

`./dd-test-optimization-validation-manifest.json`

## Record Installed Package Location

Use the same installed `dd-trace` package for this runbook, its reference docs, the manifest schema,
the example manifest, and the validator. If you are already reading this file from an installed
`dd-trace` package, record that `ci/` directory and skip package discovery.

If the runbook text was pasted, copied, or opened without a reliable file path, resolve the installed
package with the repository's normal Node/package-manager resolution. Try the direct path first, then
the cheapest resolver that matches this repository:

```bash
test -f ./node_modules/dd-trace/ci/runbook.md && echo ./node_modules/dd-trace/ci/runbook.md
node -e "console.log(require.resolve('dd-trace/ci/runbook.md'))"
yarn node -e "console.log(require.resolve('dd-trace/ci/runbook.md'))"
pnpm exec node -e "console.log(require.resolve('dd-trace/ci/runbook.md'))"
npm exec -- node -e "console.log(require.resolve('dd-trace/ci/runbook.md'))"
```

Use only the command that works in this repository, then read any referenced `ci/` files from the
same resolved package. Do not run unrestricted recursive `find` commands across `node_modules`,
workspace caches, or the whole repository unless all resolver commands fail.

## Anchor Repository Root

At the start of discovery, record the repository root and return to it before root-relative
commands:

```bash
REPO_ROOT=$(pwd)
```

After running package-level preflights or generated-test commands, do not assume the shell stayed at
the repository root. Prefix later discovery and manifest-writing commands with `cd "$REPO_ROOT"` or
use absolute paths.

## What You Produce

- `./dd-test-optimization-validation-manifest.json`
- `./dd-test-optimization-validation-results`
- direct-initialization Basic Reporting results for each supported runnable framework
- CI wiring findings for each replayable CI test job, or an explicit skip/blocker when Basic
  Reporting did not pass or CI wiring could not be reproduced locally
- advanced feature results for each framework whose Basic Reporting passed
- a concise console report ordered as Basic Reporting, CI wiring, then advanced features
- `./dd-test-optimization-validation-results/report.md`

## Privacy and Sharing Warning

The generated Markdown report and run artifacts, including low-level intake request artifacts, are
local/internal diagnostic outputs. They may include repository paths, package names, CI
workflow/job/step names, commands, runner/tool chains, validation payload JSON, and sanitized
environment variable structure. Secret-like values are redacted on a best-effort basis, but these
files are not public-shareable as-is. Review and redact them before sharing outside trusted
channels.

## Core Model

The validator separates two questions:

1. **Direct-initialization capability**: can this repository, framework, and selected command report
    when the validator applies the required Datadog setup directly?
2. **CI wiring**: does the customer's CI-shaped test command already pass the required Datadog setup
    to the process that actually runs tests?

Direct-initialization Basic Reporting is the prerequisite diagnostic control. A Basic Reporting pass
must not be reported as "CI wiring passed" unless the separate CI wiring path also proves that the
CI-provided initialization reaches the final test process.

In customer terms: the project can report when `dd-trace` is initialized correctly, but CI may still
run tests without passing `NODE_OPTIONS=-r dd-trace/ci/init` and the required Datadog environment all
the way to Jest, Vitest, Mocha, Playwright, or the detected runner.

## Command Roles

Use these roles consistently. Most bad manifests blur these fields.

- `existingTestCommand`: small real project test command used for preflight and Basic Reporting.
  Prefer a CI-derived command but remove CI Datadog initialization. Datadog env: no. Generated
  files: no.
- `preflight`: the dd-trace-less result of `existingTestCommand`. Datadog env: no. Generated files:
  no.
- `forcedLocalCommand`: optional direct runner command for Basic Reporting when
  `existingTestCommand` is too broad or wrapper-heavy. Datadog env: no. Generated files: no.
- `ciWiringCommand`: replay of the CI test step to prove whether CI-provided initialization reaches
  the final test process. Datadog env: yes, but only when CI configured those variables. Generated
  files: no.
- `generatedTestStrategy.scenarios[*].runCommand`: commands for temporary generated tests used by
  EFD, ATR, and Test Management checks. Datadog env: no. Generated files: yes.

For every runnable framework, `existingTestCommand` and `preflight` are required.
`forcedLocalCommand` is optional and must target an existing stable project test or direct project
runner command. It must not depend on generated validation files.

During live validation, the validator may overlay fake-intake transport variables,
noise-suppression variables, and for CI wiring dd-trace debug logging. Those overlays are diagnostic
plumbing for the local mock intake. They are not customer CI recommendations and must not be
interpreted as proof that CI had those settings.

## Happy Path

Do not wait for a perfect manifest. Write the checkpoint manifest as soon as you have one supported
framework, one representative CI test command when available, and a Datadog-clean preflight result.
In large monorepos, do not enumerate every package before checkpointing.

1. Discover CI workflow definitions before choosing local package scripts.
2. Identify CI jobs, stages, or steps that install dependencies, set up Node, and run tests.
3. Reproduce the CI test command shape as faithfully as practical and record whether CI appears to
    provide Test Optimization initialization to the final test process.
4. Discover every test framework present in the repository.
5. Install declared project dependencies or run documented setup only when needed for runner
    availability.
6. Select `existingTestCommand` for each runnable framework. Prefer the CI-derived test command,
    but keep it Datadog-clean: do not include CI-provided `NODE_OPTIONS` or Datadog env here.
7. Run each selected `existingTestCommand` without adding Datadog instrumentation and record the
    preflight result.
8. Immediately write `./dd-test-optimization-validation-manifest.json` with framework detection,
    CI wiring evidence, existing commands, preflight results, and non-runnable reasons.
9. Create and verify temporary generated validation tests for each runnable framework.
10. Delete temporary files.
11. Update the manifest with generated test strategies.
12. Run `dd-trace/ci/validate-test-optimization`.
13. Report Basic Reporting, CI wiring, and advanced feature results separately, including the
    detailed Markdown report path.

## Discovery Rules

- Search hidden CI directories explicitly. A search that excludes `.github`, `.circleci`, or
  `.buildkite` is incomplete.
- Prefer CI-derived test commands over local package scripts. Fall back to package scripts only
  when CI discovery fails, is unsupported, or cannot be safely replayed.
- Include every detected test framework, even if it cannot be run. For non-runnable frameworks,
  record a concrete `notes` reason.
- Treat a framework as detected only when there is evidence of the runner itself: dependency,
  config file, CLI binary, or command. Reporter names and output formats are not enough.
- Prefer the smallest reliable passing test command.
- Try at most one representative existing command and one smaller fallback per framework before
  recording the failure.
- In large monorepos, validate one representative command per distinct framework/runner shape,
  working directory shape, setup requirement, and CI environment shape. Record duplicate packages or
  jobs as omitted or duplicate CI candidates instead of live-replaying every package.
- If a command shape requires a full monorepo build, Docker, databases, browser binaries, or
  external services, omit it unless that setup is already available or documented and cheap to run.
- Do not use benchmark/performance commands as representative test commands.
- For Jest, record custom `runner` configuration. Custom runners can run tests while bypassing the
  lifecycle hooks dd-trace uses for individual suites and tests.
- Respect the repository's declared Node and package-manager versions before judging a command
  failure.
- Do not include secrets. Record required secret variable names only.
- Schema path fields must be absolute: repository root, project roots, package JSON paths, command
  cwd values, generated file paths, cleanup paths, and generated test identity files.
- Write only valid JSON to `./dd-test-optimization-validation-manifest.json`.

For detailed provider-specific extraction rules and manifest examples, read
`ci/test-optimization-validation-runbook-reference.md`.

## CI Discovery Minimum

Start with an explicit CI inventory:

```bash
find .github/workflows -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) -print 2>/dev/null
test -f .gitlab-ci.yml && printf '%s\n' .gitlab-ci.yml
test -f .gitlab-ci.yaml && printf '%s\n' .gitlab-ci.yaml
find .circleci -maxdepth 2 -type f 2>/dev/null
find .buildkite -maxdepth 2 -type f 2>/dev/null
test -f bitbucket-pipelines.yml && printf '%s\n' bitbucket-pipelines.yml
test -f bitbucket-pipelines.yaml && printf '%s\n' bitbucket-pipelines.yaml
test -f azure-pipelines.yml && printf '%s\n' azure-pipelines.yml
test -f azure-pipelines.yaml && printf '%s\n' azure-pipelines.yaml
test -f Jenkinsfile && printf '%s\n' Jenkinsfile
```

If using `rg --files`, include `--hidden` or pass explicit CI paths. Do not rely on unguarded shell
globs such as `.github/workflows/*.yaml`; shells like zsh can fail before discovery starts when a
glob has no match.

If multiple CI providers or jobs run the same command shape, run one representative live replay and
record the others as duplicate CI command candidates or omitted test commands with source metadata.
Run multiple CI wiring commands live only when command, working directory, setup, or environment
differs in a way that can affect Test Optimization initialization.

## Manifest Checkpoint

Write the manifest twice if needed:

1. First as a basic checkpoint after existing-command preflights and non-runnable classifications.
2. Then as an enriched manifest after generated tests are verified and cleaned up.

Hard checkpoint: after existing-command preflights, the next file-writing action must create
`./dd-test-optimization-validation-manifest.json`. If any framework is incomplete, write it as
`requires_manual_setup`, `detected_not_runnable`, `unsupported_by_validator`, or `unknown`; then
enrich the file later. Do not create temporary generated tests while this file is absent.

Use the published manifest contract:

- schema: `./node_modules/dd-trace/ci/test-optimization-validation-manifest.schema.json`
- example: `./node_modules/dd-trace/ci/test-optimization-validation-manifest.example.json`

If `./node_modules/dd-trace` is absent because the repository uses Yarn Plug'n'Play, pnpm, portals,
or another layout, locate the installed `dd-trace` package first and read those files from its
`ci/` directory.

The minimum useful manifest has:

- repository root, environment, and one framework entry per detected framework
- top-level `ciDiscovery` with searched/found CI paths and notes
- top-level `omitted` and optional `omittedTestCommands` for discovered commands that are not live
  validation targets
- `status`, `supportLevel`, `project.evidence`, and `notes`
- `setup.commands` when install/build/setup prerequisites must be replayed
- `existingTestCommand` and `preflight` for each runnable framework
- optional `ciWiringCommand`, `ciWiring`, and `forcedLocalCommand`
- `generatedTestStrategy` only when generated tests were verified or deliberately proposed/skipped

Do not put unresolved shell placeholders such as `${NODE_OPTIONS}` into fields the validator
executes. The validator does not perform shell substitution for manifest values.

## Generated Tests

Generated files are available only for advanced scenarios. Do not reference generated validation
files from `existingTestCommand`, `preflight`, `forcedLocalCommand`, or `ciWiringCommand`.

For each runnable framework, generated tests should provide:

- `basic-pass`: stable passing test used for basic reporting and EFD new-test validation
- `atr-fail-once`: test that fails once and passes on retry
- `test-management-target`: stable named test identity for Test Management checks

If a generated scenario cannot be verified, mark the strategy as `proposed` or `not_possible` and
include the limitation explicitly. See `ci/test-optimization-validation-runbook-reference.md` for
the detailed generated-test rules.

## Run Deterministic Validation

After writing `./dd-test-optimization-validation-manifest.json`, run the validator shipped with the
installed library. Do not manually evaluate raw Datadog payloads.

Resolve the validator module:

```bash
node -e "console.log(require.resolve('dd-trace/ci/validate-test-optimization'))"
```

Run the resolved validator:

```bash
node /absolute/path/to/validate-test-optimization.js \
  --manifest ./dd-test-optimization-validation-manifest.json \
  --out ./dd-test-optimization-validation-results
```

If a target framework was requested, add `--framework <normalized-target>`.

For Yarn Plug'n'Play, pnpm, workspaces, or another non-standard module layout, execute the resolved
validator through the package-manager mechanism that works in this repository, such as `yarn node`
or `pnpm exec node`.

Live validation requires localhost sockets. If the fake intake fails with `EPERM` or `EACCES` on
`127.0.0.1`/localhost, this is an execution-environment blocker, not a Test Optimization
misconfiguration. Preserve the manifest and artifacts, then ask the user to rerun live validation
from CI, the host shell, or an agent mode that allows localhost sockets. See
`ci/test-optimization-validation-runbook-troubleshooting.md`.

Host-shell fallback command:

```bash
cd "$REPO_ROOT"
node node_modules/dd-trace/ci/validate-test-optimization.js \
  --manifest ./dd-test-optimization-validation-manifest.json \
  --out ./dd-test-optimization-validation-results
```

## Report Results

When validation finishes, show a concise summary in the console or local agent response, then link
to `./dd-test-optimization-validation-results/report.md`.

Include:

- path to `./dd-test-optimization-validation-manifest.json`
- path to `./dd-test-optimization-validation-results/report.md`
- validator exit code
- Basic Reporting pass/fail/skip summary by framework
- CI wiring pass/fail/skip summary by framework or CI job
- advanced feature pass/fail/skip summary
- any execution-environment blocker

Use validator diagnoses as the source of truth. Do not claim that Datadog Test Optimization is
broken unless the validator reports that diagnosis. If the manifest was incomplete, invalid, or
based on unverified commands, report that as the primary issue.
