# Datadog Test Optimization Validation Manifest Runbook

You are running inside the repository that needs Datadog Test Optimization validation.

Your task is to discover how tests are run here and write a validation manifest for a deterministic
Datadog validator.

Do not debug Datadog behavior. Do not add Datadog instrumentation during discovery. If a CI wiring
replay preserves Datadog initialization that the CI workflow already configured, record that as CI
evidence rather than inventing or moving preloads yourself. Do not add new dependencies to the
project. You may run the project's normal dependency install or documented setup commands when they
are required to make an already-declared test runner available. Do not permanently modify source
files. You may create temporary validation test files only to prove that generated tests can run,
and you must delete them before finishing.

Write the manifest to:

`./dd-test-optimization-validation-manifest.json`

## Locate Installed Package

Before broad filesystem searches, locate the installed `dd-trace` package with the repository's
normal Node/package-manager resolution. Try the direct path first, then the cheapest resolver that
matches this repository:

```bash
test -f ./node_modules/dd-trace/ci/runbook.md && echo ./node_modules/dd-trace/ci/runbook.md
node -e "console.log(require.resolve('dd-trace/ci/runbook.md'))"
yarn node -e "console.log(require.resolve('dd-trace/ci/runbook.md'))"
pnpm exec node -e "console.log(require.resolve('dd-trace/ci/runbook.md'))"
npm exec -- node -e "console.log(require.resolve('dd-trace/ci/runbook.md'))"
```

Use only the command that works in this repository. Do not run unrestricted recursive `find`
commands across `node_modules`, workspace caches, or the whole repository unless all resolver
commands fail.

## What You Produce

- `./dd-test-optimization-validation-manifest.json`
- `./dd-test-optimization-validation-results`
- forced local Basic Reporting results for each supported runnable framework
- CI wiring findings for each replayable CI test job, or an explicit skip/blocker when forced local
  Basic Reporting did not pass or CI wiring could not be reproduced locally
- advanced feature results for each framework whose Basic Reporting passed
- a concise console report ordered as Basic Reporting, CI wiring, then advanced features
- any `ci/test/validation#pako:...` UI path or paths emitted by the validator

## Happy Path

1. Discover CI workflow definitions before choosing local package scripts.
2. Identify CI jobs, stages, or steps that install dependencies, set up Node, and run tests.
3. Reproduce the CI test command shape as faithfully as practical and record whether the CI wiring
   appears to provide Test Optimization initialization to the final test process.
4. Discover every test framework present in the repository.
5. Install declared project dependencies or run documented setup only when needed for runner
   availability.
6. Prefer a replayable CI-derived test command as `existingTestCommand` for each framework. Fall
   back to local package scripts only when CI discovery fails, is unsupported, or cannot be safely
   replayed.
7. Run each selected command without adding Datadog instrumentation and record the preflight result.
8. Immediately write `./dd-test-optimization-validation-manifest.json` with framework detection,
   CI wiring evidence, existing commands, preflight results, and non-runnable reasons.
9. Create and verify temporary generated validation tests for each runnable framework.
10. Delete temporary files.
11. Update `./dd-test-optimization-validation-manifest.json` with generated test strategies.
12. Run `dd-trace/ci/validate-test-optimization`.
13. Report Basic Reporting, CI wiring, and advanced feature results separately, including the UI path.

## Optional Target Framework

If the prompt asks to target, focus on, or validate only one framework entry, still discover the
repository normally, but run live validation only for the requested entry.

Normalize the requested target by trimming whitespace and removing trailing colons. For example,
`vitest:root-unit:` means the manifest entry with id `vitest:root-unit`.

Pass the target to the validator with `--framework`:

```bash
node /absolute/path/to/validate-test-optimization.js \
  --manifest ./dd-test-optimization-validation-manifest.json \
  --out ./dd-test-optimization-validation-results \
  --framework vitest:root-unit
```

If the target is a framework kind such as `vitest`, the validator runs all matching Vitest entries.
If the requested target is not discovered, report the available framework entry ids and do not run
an unrelated framework as a substitute.

## Goal

Create a complete, verified manifest and report that distinguish two validation paths:

1. **CI wiring validation**: does the customer's CI-shaped test command already pass Datadog Test
   Optimization initialization to the process that actually runs tests?
2. **Forced local capability validation**: can this repository, framework, and installed `dd-trace`
   report when the required Datadog setup reaches the test runner directly?

The CI wiring path is the primary customer question. Forced local Basic Reporting is the prerequisite
diagnostic control: CI wiring should only be interpreted after the selected framework/test command
has proven it can report when the required Test Optimization environment reaches the test runner.

Create a manifest that tells a deterministic validator:

1. Which test frameworks are present.
2. Which CI jobs or steps appear to run those frameworks, and how much of their runtime shape can be
   replayed locally.
3. How to set up and run a small existing passing test subset for each framework, preferring the
   CI-derived command when one is available.
4. How to create temporary validation tests for each framework.
5. How to run only those generated validation tests.
6. Which generated test identities the validator should expect in Datadog payloads.

The manifest is discovery only. The deterministic validator replays any declared setup commands,
starts the mock intake, runs forced local Basic Reporting with the required Datadog setup added to
the selected test command, runs `ciWiringCommand` with only the CI-provided setup when Basic
Reporting passed and a CI command is present, then runs advanced feature checks. Do not treat a
forced local validator pass as proof that CI wiring is correct; report the CI wiring result
separately.

For Vitest, the validator injects both the Test Optimization init preload and
`dd-trace/register.js` through `NODE_OPTIONS`. Do not add these preloads to the manifest commands.

Before live validation, the deterministic validator also runs `dd-trace/ci/diagnose.js`. Static
diagnosis can stop live execution for known hard blockers such as unsupported frameworks
(`node:test`, AVA, tap, Jasmine, Karma, uvu, TestCafe) or unsupported supported-framework versions.
Advisory findings such as missing static `NODE_OPTIONS` do not block this validator because forced
local Basic Reporting is intentionally testing whether the project can report when the required
Datadog setup reaches the test runner directly.

## Validation Paths

### CI Wiring Validation

Inspect CI workflow definitions before choosing a local package script. Prefer test commands derived
from CI jobs over commands invented from `package.json`.

For the CI wiring path:

- Preserve the CI command shape as closely as practical: setup commands, package-manager entry
  points, working directories, shell semantics, environment inheritance, matrix values, runner or
  image details, and package manager/runtime setup.
- Do not add `dd-trace/ci/init`.
- Do not add `dd-trace/register.js`.
- Do not invent or move `NODE_OPTIONS`.
- Preserve whether Datadog-related variables are configured by the CI workflow. Secret values may
  be replaced with explicit safe dummy values for local fake-intake replay, but record the original
  secret variable names in CI metadata such as `requiredSecretEnvVars`, `safeEnv`, or `notes`.
- Local endpoint or transport overrides may be used only as validator plumbing to redirect traffic
  to a local fake intake; they must not change whether Test Optimization initialization is
  configured.
- If CI workflow logic cannot be reproduced locally, record the blocker explicitly. Do not silently
  replace the CI command with a local guess and call that CI wiring validation.

CI wiring validation can pass only when the CI-shaped command appears to run the relevant tests and
the CI-provided environment already initializes Test Optimization in the final test process. If you
cannot prove that locally, report CI wiring as `skip` or `fail` with the concrete reason.

### Forced Local Capability Validation

The deterministic validator's forced local scenarios may inject `NODE_OPTIONS=-r dd-trace/ci/init`,
and for Vitest may also inject `dd-trace/register.js`, while redirecting traffic to the local fake
intake.

Forced local scenarios also suppress Datadog side channels that are not part of this validation.
This keeps the fake intake focused on Test Optimization test-cycle events and the scenario-specific
endpoints the validator intentionally enables:

- `DD_INSTRUMENTATION_TELEMETRY_ENABLED=false`
- `DD_CIVISIBILITY_GIT_UPLOAD_ENABLED=false`
- `DD_CIVISIBILITY_GIT_UNSHALLOW_ENABLED=false`
- `DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED=false`
- `DD_TEST_FAILED_TEST_REPLAY_ENABLED=false`

Do not treat those forced-local suppressions as customer CI recommendations. In real CI, git upload
and impacted-test detection may be required for normal Test Optimization features. In this
validator, they are disabled because they can create unrelated intake traffic, large git packfile
uploads, extra debugger/log endpoints, or impacted-test behavior that distracts from the question
being validated.

Forced local validation proves that the framework and `dd-trace` can report when configured
correctly. It does not prove that the customer's CI workflow is wired correctly.

If forced local Basic Reporting passes but CI wiring fails, explain the differential in customer
terms: the test command can report data when `dd-trace` is initialized correctly, but the CI-shaped
path runs the tests without the required Datadog setup reaching the final test runner. This often
happens when a package manager, monorepo runner, or wrapper sits between the CI workflow command and
the real test process and drops `NODE_OPTIONS=-r dd-trace/ci/init` or other required Datadog
environment. If forced local Basic Reporting fails, do not diagnose CI wiring yet; the selected test
command, dependency setup, framework support, or local Test Optimization capability must be fixed
first.

## CI Workflow Discovery

Search CI definitions before broad package-script exploration. Read only the files needed to
identify test-running jobs and their setup; avoid dumping whole workflow collections into context.

### GitHub Actions

Inspect `.github/workflows/*.yml` and `.github/workflows/*.yaml`.

For candidate test jobs, record:

- workflow file and workflow name when present
- job id and job name
- `runs-on`
- workflow, job, and step `env`, preserving inheritance order
- `defaults.run.working-directory` at workflow and job levels
- `strategy.matrix` values selected for local replay
- `actions/setup-node` inputs, including `node-version`, `node-version-file`, `cache`, and
  package-manager setup implications
- dependency install steps
- test-running `run` steps, their shell, working directory, and step name/id
- unresolved expressions, contexts, outputs, secrets, reusable workflows, or dynamically generated
  values that cannot be safely resolved locally

### GitLab CI/CD

Inspect `.gitlab-ci.yml` and local includes when they are easy to resolve without network access.

For candidate test jobs, record:

- stages and selected job/stage name
- `variables` from global, default, inherited, and job levels
- `image`, `services`, and runner tags when present
- `before_script`, `script`, and `after_script`
- `extends`, `default`, `rules`, `only`, and `except` effects when understandable
- `parallel:matrix` values selected for local replay
- unresolved remote includes, generated child pipelines, dynamic variables, or protected secrets

### CircleCI

Inspect `.circleci/config.yml`.

For candidate test jobs, record:

- workflow and job names
- executor, Docker image, machine executor, and `working_directory`
- job and step `environment`
- reusable `commands` that expand into dependency install or test steps
- dependency install steps and test-running `run` steps
- orb usage when the expanded command is obvious; otherwise record the orb command as unresolved

### Jenkins

Inspect `Jenkinsfile`.

For candidate test stages, record:

- declarative or scripted pipeline shape where understandable
- `pipeline`, `agent`, `tools`, `environment`, `stages`, and `steps`
- `sh`, `bat`, and `powershell` commands that install dependencies or run tests
- `matrix` and `parallel` branches selected for local replay
- unresolved shared libraries, dynamic Groovy, credentials bindings, or generated commands that are
  not safely reproducible

### Best-Effort CI Providers

Recognize these CI systems and extract test-command evidence when practical:

- Azure Pipelines: `azure-pipelines.yml`, `.azure-pipelines/*.yml`, `variables`, `jobs`, `steps`,
  `strategy.matrix`, `NodeTool`, `UseNode`, npm/yarn/pnpm tasks, and script/bash/pwsh test steps.
- Bitbucket Pipelines: `bitbucket-pipelines.yml`, `pipelines`, `definitions`, `steps`, `script`,
  `caches`, and `services`.
- Buildkite: `.buildkite/pipeline.yml`, `steps`, `command`, `env`, `agents`, and plugins. Mark
  dynamic pipeline uploads unresolved unless the generated pipeline is locally inspectable.

## Rules

- Include every detected test framework, even if it cannot be run.
- Treat a framework as detected only when there is evidence of the test runner itself: a dependency,
  config file, CLI binary, or command that invokes that runner. Reporter names, output formats, and
  script names are not enough. For example, `mocha --reporter tap ...` or a `test-tap` script that
  invokes Mocha is still a Mocha run, not a TAP framework entry. Record the reporter detail in the
  Mocha entry's `project.evidence` or `notes`; do not add a separate `tap:*` framework unless a TAP
  runner/package/config/command is actually present.
- Do not create runnable `custom` framework entries for test commands that use unsupported
  non-Node or native runtime test runners, such as `bun test` or `deno test`, unless the validator
  has a real adapter for that runner. Record those commands as omitted evidence instead of failed
  validation targets. Use top-level `omitted` for a concise human-readable summary, and when useful
  add a structured top-level `omittedTestCommands` extension containing command, source, reason,
  classification, and impact. Omitted commands are informational only; they must not affect the
  validation result.
- For every framework that is not `runnable`, include a concrete `notes` entry explaining why:
  no package script, no config file, no safe passing test, missing setup step, missing external
  service, unsupported framework, or unsupported version.
- Prefer the smallest reliable passing test command.
- Prefer CI-derived commands over local package scripts. Prefer existing package scripts over
  invented commands only after CI discovery fails, is unsupported, or cannot be safely replayed.
- Prefer `argv` arrays over shell strings.
- Honor the repository's declared runtime before judging a command failure. Check `package.json`
  `engines`, `devEngines`, `volta`, `.node-version`, `.nvmrc`, `.tool-versions`, and available
  runtime managers such as Volta, Mise, asdf, nvm, or fnm. If the default shell Node violates the
  declared runtime and a compatible local runtime is available, run preflights and manifest commands
  through that runtime and record the reason in `notes`.
- Preserve the repository's declared package-manager version before judging a command failure.
  Check `package.json` `packageManager`, lockfiles, and workspace metadata. For pnpm and Yarn
  projects, prefer the repository's Corepack/package-manager resolution over a bare package-manager
  binary from the agent runtime. Do not wrap a package-manager command with a runtime manager such
  as `mise x node@22 -- pnpm ...` unless you first verify that command uses the repository's
  declared package-manager version. If it does not, use the Corepack-backed command shape that
  matches `packageManager`, or mark the framework `requires_manual_setup` with the observed version
  mismatch.
- For local fallback and forced local generated-test commands, prefer direct framework runner
  commands over broad package-script wrappers when both are equivalent and safe. For example, if
  `scripts.test` is only `vitest run`, prefer the package manager's direct runner form such as
  `pnpm vitest run <file>` over `pnpm test <file>`. This keeps forced local validation focused on
  the test process and avoids package-script wrappers that can receive `NODE_OPTIONS` without
  propagating Test Optimization initialization to the final runner. Do not apply this preference to
  CI wiring validation when the customer's CI job intentionally uses the package-script wrapper.
- Do not use benchmark or performance commands as representative test commands. For Vitest,
  `vitest bench`, benchmark package scripts, and `*.bench.*` files that use `bench` are not normal
  test runs and may emit session/module/suite events without per-test events. If no normal
  `vitest run` or `vitest test` command exists, mark that Vitest entry non-runnable and explain
  that only benchmark mode was found.
- For Jest, record non-default `runner` configuration from `jest.config.*` or `package.json`
  `jest.runner` in the manifest evidence. Custom Jest runners such as `jest-light-runner` can run
  tests while bypassing the lifecycle hooks dd-trace uses to report individual suites and tests. If
  forced local Basic Reporting fails with only session/module events, explain this as a custom
  runner compatibility issue before discussing CI wiring.
- Avoid snapshot-update, golden-output, export-matrix, or very broad generated-list tests as the
  representative command when smaller stable tests exist. These files often fail for repository
  state unrelated to test-runner compatibility and can make discovery slow. If such a file is the
  first attempt and fails or runs many tests, use the one allowed fallback on a smaller test file.
- Treat dependency setup as part of test-command discovery. Before reporting that a runner is
  missing, check whether the command's package or workspace has had its declared dependencies and
  documented setup installed.
- Record required setup commands in `setup.commands` when a selected test command only works after
  a documented install, build, code generation, browser-binary install, or fixture preparation
  step. These commands must be deterministic, idempotent when possible, and safe to replay before
  validation.
- Do not invent setup commands. Use package-manager install commands, package scripts, or
  repository documentation. If the required setup is unclear, mark the framework
  `requires_manual_setup` and explain the missing step in `notes`.
- Do not include secrets. Record required environment variable names only.
- For CI wiring commands, preserve `NODE_OPTIONS` and Datadog-specific environment variables exactly
  when they are configured by the CI workflow. If a secret value is needed for local fake-intake
  replay, use an explicit safe dummy value, not a shell placeholder like `${SECRET_NAME}`, and
  record the original secret variable name in CI metadata. For forced local or locally invented
  commands, do not add `dd-trace/ci/init`, `dd-trace/register.js`, `NODE_OPTIONS`, or
  Datadog-specific env vars manually; the validator owns forced injection and the forced-local
  side-channel suppressions listed above.
- All paths must be absolute.
- A generated test strategy is `verified` only if you created the temporary file or files, ran at
  least the stable passing generated scenario without Datadog instrumentation, and deleted the files
  afterward.
- Before choosing generated test syntax and file extension, inspect the nearest `package.json` that
  will own the generated file and mirror the module format used by nearby tests. If that package
  treats `.js` as CommonJS, use CommonJS syntax in `.js` or ESM syntax in `.mjs`. If it treats `.js`
  as ESM, use ESM syntax in `.js` or CommonJS syntax in `.cjs`. Do not discover this by handing an
  obviously mismatched generated file to the validator; fix the syntax/extension during the
  dd-trace-less generated-test preflight.
- If you cannot verify generated tests, mark the strategy as `proposed` or `not_possible`.
- Write only valid JSON to `./dd-test-optimization-validation-manifest.json`.

## Discovery Steps

1. Detect repository root, package manager, workspace manager, Node version, and git metadata.
2. Inspect CI workflow definitions and identify test-running jobs or stages.
3. For each replayable CI test job, derive a `ciWiringCommand` with setup commands, environment,
   working directory, shell, and selected matrix values. If a CI job cannot be replayed, record the
   unresolved blocker immediately.
4. Inspect package scripts, workspace packages, lockfiles, config files, and dependencies.
5. Resolve dependency/setup requirements for each candidate command.
6. For each framework/package/workspace, identify a small existing passing test command, preferring
   a replayable CI-derived command over a local package-script guess.
7. Run that selected command without adding Datadog instrumentation and record the preflight result.
8. Write the manifest immediately with the CI wiring evidence, existing-command, and preflight
   information collected so far.
9. For each runnable framework, create a temporary generated validation test strategy for the forced
   local control.
10. Prove the generated passing test runs without Datadog instrumentation.
11. Delete all temporary files and record cleanup success.
12. Update the existing manifest with generated strategy details.

For each framework, try at most one representative existing command and one smaller fallback command
before recording the failure. Do not keep inventing alternate runner commands after two attempts.
Record the best failure evidence and continue to the next framework.

Cap discovery output. Do not dump full lockfiles, schemas, package-manager internals, or exhaustive
file lists into the agent context. Read only the manifest example/schema fields needed for the
entries being written. Once supported frameworks, non-runnable frameworks, and one command per
runnable framework are known, write the basic manifest before doing any more exploration.

For Jest projects with multiple configured projects or custom root directories, verify that generated
forced-local commands run only the intended file. If `npm test -- <file>` or a package script starts
unrelated suites, stop that forced-local attempt and use a direct runner command with
`--runTestsByPath` and the repository's required config/project flags. Record the broad-run attempt
in `notes`; do not let it continue as the generated-test preflight. For CI wiring validation,
preserve the CI test command even when it is broad, and record the breadth explicitly.

For each framework entry, set `project.root`, `project.packageJson`, and `project.name` to the
smallest package or workspace that owns the selected test command. If the command uses package
manager routing flags such as `pnpm --dir`, `yarn --cwd`, `npm --prefix`, or `pnpm --filter`, resolve
the package directory selected by that flag and use that package's `package.json` when it exists.
The command `cwd` may still be the repository root; keep that exact process cwd in the command
object.

If a CI workflow or package script sets `NODE_OPTIONS=...` inline, first decide which validation
path you are documenting:

- For CI wiring validation, preserve the CI-defined value exactly as configuration evidence, except
  for replacing secret expansions with placeholders and recording the original variable names. Do
  not move the preload to a different process or rewrite the command into a cleaner local shape.
- For forced local validation, do not use a package script with inline `NODE_OPTIONS` unless there
  is no safer command shape. Inline `NODE_OPTIONS` can shadow or interfere with the validator's
  injected Test Optimization preload. Prefer a direct runner command and move only
  project-required, non-Datadog Node options into `command.env.NODE_OPTIONS`; the validator will
  merge that value with its own Test Optimization preloads.

Never add `dd-trace/ci/init`, `dd-trace/register.js`, or Datadog-specific environment variables to
forced-local manifest commands manually. Record any avoided package script and direct equivalent in
`notes`. If the package script is the only runnable forced-local form, record that the inline
`NODE_OPTIONS` may prevent validation and mark the forced-local strategy limited or not possible.

Do not use a test framework's own source-tree runner as customer validation evidence. For example,
inside the Mocha repository, `node ./bin/mocha.js ...` runs Mocha's local source files rather than
an installed `mocha` package from `node_modules`; that is not the same shape as a customer project
using Mocha. If the repository package is the framework itself and the command invokes its local
`bin/` or `src/` runner, prefer another real project framework in the repository. If none exists,
mark that framework `detected_not_runnable` and explain that the available command runs the
framework source tree.

## Manifest Writing Checkpoint

Write the manifest twice if needed: first as a basic draft before creating any temporary generated
tests, then as an enriched manifest after generated tests are verified and cleaned up. Do not wait
for a perfect manifest. The validator can report setup, static, and runtime failures from a
concrete manifest; it cannot run if no manifest is written.

Hard checkpoint: immediately after existing-command preflights and non-runnable classifications,
the next file-writing action must create `./dd-test-optimization-validation-manifest.json`. If any
framework entry is still incomplete, write that framework as `requires_manual_setup`,
`detected_not_runnable`, `unsupported_by_validator`, or `unknown`; then enrich the file in a second
pass. Do not create temporary generated tests while this file is absent.

After generated-test cleanup, update the existing manifest in place. If enriching the manifest with
generated-test strategies becomes slow or uncertain, leave the basic manifest in place, add a
warning explaining that generated strategy enrichment was skipped, and run the validator. Never let
generated-strategy JSON composition prevent the manifest file from existing.

Use this pattern to make the first write mechanical. Replace the `frameworks` array with the
entries discovered in this repository before running it:

```bash
node - <<'NODE'
const fs = require('fs')
const { execSync } = require('child_process')

const root = process.cwd()

function optionalGit (args) {
  try {
    return execSync(`git ${args}`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch (_) {
    return null
  }
}

const manifest = {
  schemaVersion: '1.0',
  generatedAt: new Date().toISOString(),
  repository: {
    root,
    gitRemote: optionalGit('config --get remote.origin.url'),
    gitSha: optionalGit('rev-parse HEAD'),
    packageManager: 'unknown',
    workspaceManager: 'unknown'
  },
  environment: {
    os: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux',
    shell: process.env.SHELL || null,
    nodeVersion: process.version,
    requiredEnvVars: [],
    safeEnv: {}
  },
  frameworks: [
    /*
    {
      id: 'jest:root',
      framework: 'jest',
      frameworkVersion: null,
      language: 'unknown',
      status: 'requires_manual_setup',
      supportLevel: 'validator_supported',
      project: {
        name: null,
        root,
        packageJson: `${root}/package.json`,
        configFiles: [],
        evidence: ['detected jest in package.json']
      },
      setup: { commands: [], services: [] },
      notes: ['Fill in the concrete command result before validation.']
    }
    */
  ],
  omitted: [],
  omittedTestCommands: [],
  warnings: []
}

fs.writeFileSync('dd-test-optimization-validation-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
NODE
```

If you use the draft pattern, immediately replace the empty `frameworks` array with one entry for
each detected framework. Never run the validator with an empty `frameworks` array when frameworks
were detected.

Use the smallest valid shape:

- repository root, environment, and one framework entry per detected framework
- top-level `omitted` and optional `omittedTestCommands` for discovered test commands that are not
  live validation targets, such as unsupported native Bun or Deno test commands
- `status`, `supportLevel`, `project.evidence`, and `notes`
- `setup.commands` for required install/build/setup prerequisites that the validator should replay
- `existingTestCommand` and `preflight` only when a real project test command was selected. When a
  runnable CI test step exists, `existingTestCommand` should be derived from that CI step.
- optional extension fields such as `ciWiringCommand`, `ciWiring`, and `forcedLocalCommand` when
  they help separate CI wiring evidence from forced local control evidence. The schema supports
  these fields, and the validator executes `ciWiringCommand` when present.
- `generatedTestStrategy` only when generated tests were verified or deliberately proposed/skipped

Do not copy the full example. Omit optional fields you cannot fill confidently. For unknown
versions, use `null`. For uncertain setup, set `status` to `requires_manual_setup` or
`detected_not_runnable` and put the concrete reason in `notes`.

Use optional CI metadata like this when it is useful. Keep values concrete and absolute where paths
are involved:

```json
{
  "ciWiring": {
    "status": "fail",
    "provider": "github-actions",
    "configFile": "/absolute/path/to/repo/.github/workflows/test.yml",
    "workflow": "test",
    "job": "unit",
    "step": "Run unit tests",
    "matrix": {
      "node": "20"
    },
    "runner": "ubuntu-latest",
    "shell": "bash",
    "workingDirectory": "/absolute/path/to/repo/packages/app",
    "inheritedEnv": {
      "NODE_OPTIONS": "-r dd-trace/ci/init"
    },
    "requiredSecretEnvVars": [
      "DD_API_KEY"
    ],
    "setupCommandIds": [
      "setup-node",
      "install"
    ],
    "unresolved": [
      "DD_API_KEY value is secret and was replaced with a placeholder"
    ],
    "diagnosis": "CI NODE_OPTIONS is configured, but the test wrapper does not pass it to Jest."
  },
  "ciWiringCommand": {
    "description": "GitHub Actions unit test step, preserving CI working directory and shell",
    "cwd": "/absolute/path/to/repo/packages/app",
    "usesShell": true,
    "shellCommand": "pnpm test",
    "shellReason": "GitHub Actions run step uses shell semantics",
    "env": {
      "CI": "true",
      "NODE_OPTIONS": "-r dd-trace/ci/init",
      "DD_API_KEY": "dd-validation-placeholder"
    },
    "requiredEnvVars": [],
    "timeoutMs": 300000
  },
  "forcedLocalCommand": {
    "description": "Direct Jest command used only for forced local generated-test probing",
    "cwd": "/absolute/path/to/repo/packages/app",
    "argv": [
      "pnpm",
      "jest",
      "--runTestsByPath",
      "/absolute/path/to/repo/packages/app/src/dd-test-optimization-validation.test.js"
    ],
    "timeoutMs": 300000
  }
}
```

This example is not a complete manifest. It shows optional framework-entry fields that are valid
because the manifest schema permits additional properties. Do not put unresolved placeholders such
as `${NODE_OPTIONS}` into fields the validator executes. The validator does not perform shell
substitution for manifest values. If a CI secret is needed only so the command shape matches CI,
use an explicit safe dummy value such as `dd-validation-placeholder`, record the original secret name
in CI metadata such as `requiredSecretEnvVars`, and explain it in `unresolved` or `notes`.

Use omitted-command metadata like this when CI or package discovery finds test commands that should
not become runnable validation entries:

```json
{
  "omitted": [
    "bun test from .github/workflows/ci.yml job bun was not included in live validation because Bun's native test runner is not supported by this validator."
  ],
  "omittedTestCommands": [
    {
      "command": "bun test",
      "reason": "Bun's native test runner is not supported by the current dd-trace Test Optimization validator.",
      "classification": "unsupported-runtime",
      "impact": "Not included in live validation results.",
      "source": {
        "provider": "github-actions",
        "file": ".github/workflows/ci.yml",
        "workflow": "ci",
        "job": "bun",
        "step": "bun test"
      }
    }
  ]
}
```

Do not also create a `custom:bun` or `custom:deno` framework entry for the same command. If another
supported runner such as Vitest, Jest, or Mocha is present in the same repository, validate that
supported runner and report the omitted native runtime command separately.

A framework entry must not be marked `runnable` only because a generated validation file passed.
Basic Reporting uses `forcedLocalCommand` when present and otherwise uses `existingTestCommand`, so
at least one of those commands must be a real project test command or a deliberately safe direct
runner command that can run without the generated files being present.

If an existing test command fails because tests fail or the repository is missing generated source,
compiled artifacts, browser binaries, a dev server, or another project setup step, record the
dd-trace-less `preflight.exitCode`, `stdoutSummary`, and `stderrSummary`. Prefer a smaller passing
command when one exists. If the failing command is still the best representative command, it may
remain `runnable`: the validator will consider Basic Reporting valid when the instrumented run emits
the required event hierarchy and exits the same way as the dd-trace-less preflight run.

If a documented install/build/setup command fixes the failure, add that command to `setup.commands`
and rerun the dd-trace-less preflight after setup. The validator may start the fake intake before
replaying `setup.commands` so restricted localhost sandboxes fail fast before project setup mutates
the workspace. If a required setup command fails during validation, the affected framework fails
before test execution with that setup failure as the primary diagnosis.

If a selected command for Playwright, Cypress, or another browser/app-backed framework fails before
collecting tests because source files are not transformed, compiled assets are missing, a dev server
cannot serve the app, or browser binaries are missing, run one bounded setup search before marking the
framework `requires_manual_setup`:

1. Inspect the selected package's `package.json` for `pretest`, `prepare`, `build`, `build:*`,
   `install`, `postinstall`, `playwright install`, or a script invoked by the test server such as
   `serve-app`.
2. Inspect the repository root package scripts for the canonical build/setup command when the
   selected package imports the root package or links it through a workspace, portal, or local
   dependency.
3. Prefer the smallest obvious setup command that belongs to the selected package or its linked root
   package. Run at most one setup attempt for this framework before continuing.
4. After the setup attempt, rerun the same dd-trace-less preflight command. If it now collects tests,
   record the setup command in `setup.commands` and keep the framework `runnable`.
5. If the setup attempt fails or the preflight still fails before collection, keep the framework
   non-runnable and record the attempted setup command, its exit code, and the post-setup preflight
   failure in `notes`.

For Playwright specifically, transform errors mentioning TypeScript syntax, `declare` fields,
uncompiled source, missing browser binaries, missing build output, or a web server that starts but
serves an app that cannot import the package are setup signals. Do not run Datadog validation until
the same Playwright command has been proven with a dd-trace-less preflight after any required setup.

## Dependency Setup and Runner Availability

The test runner binary must be available from the command `cwd` before a framework is considered
runnable. A missing runner usually means one of these cases:

- repository dependencies have not been installed yet
- the command belongs to a workspace package and must use the workspace/package-manager entry point
- the command belongs to a nested non-workspace fixture with its own `package.json`
- the nested fixture requires a documented build/setup step before install, such as generating a
  local file dependency or package tarball

Use the project's package manager and lockfile. If root dependencies are missing, run or record the
normal root install command, such as `npm ci`, `yarn install --frozen-lockfile`, or
`pnpm install --frozen-lockfile`, unless the environment forbids installs.

When setup is needed for the selected command, include the exact replayable command in
`setup.commands`:

```json
{
  "setup": {
    "commands": [
      {
        "id": "install",
        "description": "Install repository dependencies",
        "cwd": "/absolute/path/to/repo",
        "argv": ["pnpm", "install", "--frozen-lockfile"],
        "required": true,
        "timeoutMs": 600000
      },
      {
        "id": "build-playwright-package",
        "description": "Build package before Playwright tests",
        "cwd": "/absolute/path/to/repo",
        "argv": ["pnpm", "build", "--filter", "package-name"],
        "required": true,
        "timeoutMs": 600000
      }
    ],
    "services": []
  }
}
```

Use the repository's actual commands. The example only shows the expected shape.

Respect the repository's declared runtime before classifying a command as broken. Check
`engines`, `devEngines`, `.nvmrc`, `.node-version`, `.tool-versions`, `volta`, and package-manager
metadata. If the required Node version is available through the local toolchain, use it in the
selected command. If the required runtime is unavailable, mark the framework `requires_manual_setup`
and record the expected runtime and the observed failure.

Respect the repository's declared package-manager version before classifying a command as broken.
If `package.json` declares `packageManager`, verify that the selected command resolves that package
manager to the declared version, especially when using Codex-managed runtimes, Volta, Mise, asdf,
nvm, fnm, or Corepack. A command that passes without Datadog can still fail under validation if
`NODE_OPTIONS` reaches a package-manager wrapper from a different toolchain instead of the final
test runner. When a runtime manager is needed only to select Node, avoid `runtime-manager -- pnpm`
or `runtime-manager -- yarn` shapes unless the package-manager version was verified. Prefer a
Corepack-backed command that preserves the declared package manager, or a direct runner command
using the package manager that the repository normally uses.

If the selected command lives in a workspace package, prefer the repository's workspace-aware test
entry point. Do not install that package independently unless the repository documents that workflow.

If the selected command lives in a nested non-workspace package or fixture, install that nested
package only when all of the following are true:

- it is the selected or only viable supported framework path
- the fixture's local `file:` dependencies already exist, or the repository documents how to create
  them
- running the fixture install is allowed in this environment

If those conditions are not met, mark the framework `requires_manual_setup`. Include the exact
evidence in `notes`, such as the nested `package.json` path, the missing runner, and the missing
local file dependency or setup command. Prefer another runnable supported framework if one exists.

Do not classify a missing runner dependency as a Datadog Test Optimization failure.

Do not leave `notes` empty for `detected_not_runnable`, `requires_external_service`,
`requires_manual_setup`, `unsupported_by_validator`, or `unknown` framework entries. The validator
uses those notes as the customer-facing reason when Basic Reporting cannot run.

## Generated Test Strategy Requirements

The generated strategy must give the deterministic validator enough information to recreate
validation tests without using intelligence.

For each runnable framework, include generated file contents as `contentLines`. The validator can
join those lines with newline characters and write the files exactly.

When `generatedTestStrategy.status` is `verified`, the generated tests must support all of these
scenarios:

- `basic-pass`: a stable passing test used for basic reporting and EFD new-test validation.
- `atr-fail-once`: a test that fails on the first attempt and passes on retry, preferably using a
  temporary state file.
- `test-management-target`: a stable, named test identity suitable for disabled, quarantined, or
  attempt-to-fix checks.

If a framework cannot support one of these scenarios, do not mark the generated strategy as
`verified`; use `proposed` or `not_possible` and include the limitation explicitly.

Each generated scenario's `runCommand` must run only that scenario. If the framework can focus by
test name, use the framework's focused-name option. If it cannot focus reliably by name, use
separate generated files per scenario and make each `runCommand` target only that file.

If `atr-fail-once` uses a state file, list that state file in `generatedTestStrategy.cleanupPaths`
alongside generated test files. The validator needs that path so it can reset the state between the
baseline run and feature-enabled retry run. Do not rely on test code to clean up its own retry state.

## Manifest Contract

Write `./dd-test-optimization-validation-manifest.json` using the published manifest contract:

- schema: `./node_modules/dd-trace/ci/test-optimization-validation-manifest.schema.json`
- example: `./node_modules/dd-trace/ci/test-optimization-validation-manifest.example.json`

If `dd-trace` is installed through Yarn Plug'n'Play, a portal dependency, pnpm, or another package
manager layout where `./node_modules/dd-trace` is absent, locate the installed `dd-trace` package
first and read the same files from that package's `ci/` directory.

Use the example only to understand field names and nesting. Do not copy placeholder paths or
commands into the customer manifest.

Do not duplicate static diagnosis decisions in the manifest. Record detection evidence, preflight
results, and concrete notes. The validator and `dd-trace/ci/diagnose.js` decide whether a detected
framework/version is a hard blocker.

## Phase 2: Run Deterministic Validation

After writing `./dd-test-optimization-validation-manifest.json`, run the Datadog Test Optimization
validator shipped with the installed library.

Do not manually evaluate Datadog payloads. Do not inspect or rewrite validator internals. Do not
decide whether Test Optimization behavior is correct by reading raw intake requests yourself. The
deterministic validator is the source of truth for local CI wiring replay and forced local feature
validation.

The validator separates forced local capability from CI wiring when the manifest includes
`ciWiringCommand`:

- Forced local Basic Reporting: injects Test Optimization initialization into the selected command
  and proves the repository/framework can emit the required event hierarchy when configured
  correctly. It also sets `DD_CIVISIBILITY_GIT_UPLOAD_ENABLED=false` and other forced-local
  suppressions so git metadata upload, impacted-test detection, telemetry, and failed-test replay
  do not distract the fake-intake diagnosis.
- CI wiring: runs `ciWiringCommand` with fake-intake transport overrides only. It does not add
  `dd-trace/ci/init`, `dd-trace/register.js`, `DD_CIVISIBILITY_ENABLED`, or `NODE_OPTIONS`. This is
  only meaningful after forced local Basic Reporting passes.
- Advanced features: EFD, ATR, and Test Management run after Basic Reporting passes.

Therefore:

- A forced local Basic Reporting pass means the repository can report when the required Datadog
  setup reaches the selected test runner directly.
- A CI wiring pass means the CI-shaped command emitted Test Optimization events using the
  CI-provided Datadog setup, without the validator adding `dd-trace` preloads.
- A forced local Basic Reporting failure means the framework/library setup, selected command, or
  local capability may be unsupported or broken even when the required Datadog setup reaches the
  selected command directly.
- A forced local pass must not be reported as “CI wiring passed” unless the separate CI wiring path
  also proved that the CI-provided initialization reaches the final test process.

First, locate the validator module:

```bash
node -e "console.log(require.resolve('dd-trace/ci/validate-test-optimization'))"
```

Then execute the resolved validator with the manifest:

```bash
node /absolute/path/to/validate-test-optimization.js \
  --manifest ./dd-test-optimization-validation-manifest.json \
  --out ./dd-test-optimization-validation-results
```

If a target framework was requested, add `--framework <normalized-target>` to the validator command.

If the repository uses Yarn Plug'n'Play, pnpm, workspaces, or another non-standard module resolution
setup, resolve and execute the validator through the package manager mechanism that works in this
repository. Examples:

```bash
yarn node /absolute/path/to/validate-test-optimization.js \
  --manifest ./dd-test-optimization-validation-manifest.json \
  --out ./dd-test-optimization-validation-results
```

```bash
pnpm exec node /absolute/path/to/validate-test-optimization.js \
  --manifest ./dd-test-optimization-validation-manifest.json \
  --out ./dd-test-optimization-validation-results
```

The validator is responsible for:

1. Validating the manifest schema.
2. Running static diagnosis and stopping live execution for known hard blockers.
3. Replaying required setup commands for each runnable framework.
4. Starting a local mock intake when at least one framework is eligible for live validation.
5. Serving Datadog Test Optimization settings responses.
6. Creating temporary validation tests from the manifest.
7. Running test commands with Datadog instrumentation enabled.
8. Reading and decoding intake payloads.
9. Evaluating Basic Reporting, CI wiring, EFD, ATR, and Test Management behavior in that order.
10. Cleaning up temporary validation files.
11. Writing a validation report, validation UI payloads, and artifacts.

Manifest generation and static diagnosis can run in a restricted agent sandbox. Live validation
cannot: the local mock intake must be allowed to bind to `127.0.0.1`, and the test process must be
allowed to connect back to that localhost socket. Some Codex/agent modes block one or both
directions.

If the validator reports that the fake intake failed with `EPERM` or `EACCES` on `listen` or
`connect` for `127.0.0.1`/localhost, treat that as an execution-environment blocker, not as a
customer Test Optimization misconfiguration. Preserve the manifest and validation artifacts, report
that no Test Optimization conclusion was reached, and ask the user to rerun live validation from CI,
the host shell, or by approving the single validator command to run outside the agent sandbox.

A local-network-only agent mode may still allow outbound network access while blocking local socket
binding. Treat that as still restricted for this validator. Do not try to solve this by starting the
fake intake outside the sandbox while tests still run inside the sandbox; rerun the validator command
itself outside the restricted sandbox so both the intake and test process can use localhost.

This restriction is not specific to subagents. A user running the validator from the repository root
inside the same restricted sandbox can hit the same blocker. Starting the fake intake outside the
sandbox is also not enough if the sandboxed test process still cannot connect to `127.0.0.1`.

Basic Reporting is the prerequisite for CI wiring interpretation, EFD, ATR, and Test Management
validation. If Basic Reporting fails for a framework, the validator skips CI wiring and the
remaining feature checks for that framework, then reports the Basic Reporting failure as the root
cause.

Your job in this phase is only to run the validator and preserve its output.

If the validator succeeds, continue to Phase 3.

If the validator fails because Test Optimization behavior did not match expectations, continue to
Phase 3 and report the validator diagnosis.

If the validator itself cannot run, stop and report:

- the command that failed
- exit code
- stdout summary
- stderr summary
- whether `dd-trace` was installed and resolvable
- whether `dd-trace/ci/validate-test-optimization` was resolvable

## Phase 3: Report Results

When validation finishes, report the result to the user.

Include:

- Path to `./dd-test-optimization-validation-manifest.json`
- Path to `./dd-test-optimization-validation-results`
- Validator exit code
- Pass/fail/skip summary for forced local Basic Reporting by framework.
- Pass/fail/skip summary for CI wiring by framework or CI job. If CI wiring was skipped, report
  whether Basic Reporting failed first, the provider was unsupported, workflow logic was unresolved,
  CI config was missing, or local replay was unsafe.
- Pass/fail/skip summary for advanced feature scenarios.
- Any frameworks that were detected but not runnable
- Any frameworks that were runnable but unsupported by the validator
- Any test commands that were discovered but intentionally omitted from live validation, including
  the source file/job/step, reason, classification, and impact when available
- Any setup or preflight commands that failed
- The validator's diagnosis for each failed scenario
- The exact test command associated with each failed scenario
- The CI provider, workflow/config file, job/stage, step, matrix selection, runner/image/agent label,
  shell, working directory, and inherited environment for each CI-derived command when available
- Any unresolved CI expressions, includes, outputs, secrets, shared libraries, orb expansions,
  dynamic pipeline generation, or matrix values that affected replay confidence
- Relevant stdout/stderr excerpts selected by the validator
- Path to `validation-urls.txt`
- The relative `ci/test/validation#pako:...` UI path or paths emitted by the validator
- Artifact paths for detailed inspection

Use this diagnosis language:

- “CI wiring passed” means the CI-shaped test command appears correctly wired and Test Optimization
  initialization reaches the final test process without the agent or validator inventing preloads.
- “CI wiring failed, Basic Reporting passed” means the validator found a test command and confirmed
  that test data is reported when the required Datadog setup reaches the test runner directly. The
  validator also found the CI job that runs tests and replayed that job's test command using the
  environment configured by CI. The tests ran, but no Test Optimization data reached the mock
  intake. This means the required `dd-trace` setup is likely being lost before it reaches the final
  test runner process.
- For the previous case, prefer this customer-facing summary: “Test Optimization is not reaching
  the test runner in CI. The tests run, and this project can report test data when `dd-trace` is
  initialized correctly, but the CI workflow path does not pass the required Datadog setup all the
  way to the process running Jest, Vitest, or the detected test runner. Check any package manager,
  monorepo runner, or wrapper between the CI step and the test runner, and make sure
  `NODE_OPTIONS=-r dd-trace/ci/init` and the Datadog environment variables are preserved.”
- “CI wiring skipped because Basic Reporting failed” means no CI wiring conclusion was reached.
- “Forced local Basic Reporting failed” means the selected command, framework/library setup, or local
  capability may be unsupported or broken even when the required Datadog setup reaches the selected
  command directly.
- “Skipped” means the path was not safely runnable or not supported; include the concrete blocker.

Do not summarize raw payloads unless the validator explicitly includes them in its report.

Do not claim that Datadog Test Optimization is broken unless the validator reports that diagnosis.

Do not hide manifest-discovery failures behind validator failures. If the manifest was incomplete,
invalid, or based on unverified commands, report that as the primary issue.
