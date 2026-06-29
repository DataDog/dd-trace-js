# Datadog Test Optimization Validation Manifest Runbook

You are running inside the repository that needs Datadog Test Optimization validation.

Your task is to discover how tests are run here and write a validation manifest for a deterministic
Datadog validator.

Do not debug Datadog behavior. Do not run tests with Datadog instrumentation. Do not add new
dependencies to the project. You may run the project's normal dependency install or documented setup
commands when they are required to make an already-declared test runner available. Do not
permanently modify source files. You may create temporary validation test files only to prove that
generated tests can run, and you must delete them before finishing.

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
- a concise console report with the validation status
- any `ci/test/validation#pako:...` UI path or paths emitted by the validator

## Happy Path

1. Discover every test framework present in the repository.
2. Install declared project dependencies or run documented setup only when needed for runner availability.
3. Pick one small representative command per framework.
4. Run each selected command without Datadog instrumentation and record the preflight result.
5. Immediately write `./dd-test-optimization-validation-manifest.json` with framework detection,
   existing commands, preflight results, and non-runnable reasons.
6. Create and verify temporary generated validation tests for each runnable framework.
7. Delete temporary files.
8. Update `./dd-test-optimization-validation-manifest.json` with generated test strategies.
9. Run `dd-trace/ci/validate-test-optimization` with the manifest.
10. Report the validator's result and UI path.

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

Create a complete, verified manifest that tells a deterministic validator:

1. Which test frameworks are present.
2. How to set up and run a small existing passing test subset for each framework.
3. How to create temporary validation tests for each framework.
4. How to run only those generated validation tests.
5. Which generated test identities the validator should expect in Datadog payloads.

The manifest is discovery only. The deterministic validator will later replay any declared setup
commands, start the mock intake, inject Datadog environment variables, run the test commands,
collect payloads, and validate Test Optimization behavior.

For Vitest, the validator injects both the Test Optimization init preload and
`dd-trace/register.js` through `NODE_OPTIONS`. Do not add these preloads to the manifest commands.

Before live validation, the deterministic validator also runs `dd-trace/ci/diagnose.js`. Static
diagnosis can stop live execution for known hard blockers such as unsupported frameworks
(`node:test`, AVA, tap, Jasmine, Karma, uvu, TestCafe) or unsupported supported-framework versions.
Advisory findings such as missing static `NODE_OPTIONS` do not block this validator because the
validator injects Test Optimization initialization itself.

## Rules

- Include every detected test framework, even if it cannot be run.
- For every framework that is not `runnable`, include a concrete `notes` entry explaining why:
  no package script, no config file, no safe passing test, missing setup step, missing external
  service, unsupported framework, or unsupported version.
- Prefer the smallest reliable passing test command.
- Prefer existing package scripts over invented commands.
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
- Prefer direct framework runner commands over broad package-script wrappers when both are
  equivalent and safe. For example, if `scripts.test` is only `vitest run`, prefer the package
  manager's direct runner form such as `pnpm vitest run <file>` over `pnpm test <file>`. This keeps
  validation focused on the test process and avoids package-script wrappers that can receive
  `NODE_OPTIONS` without propagating Test Optimization initialization to the final runner.
- Do not use benchmark or performance commands as representative test commands. For Vitest,
  `vitest bench`, benchmark package scripts, and `*.bench.*` files that use `bench` are not normal
  test runs and may emit session/module/suite events without per-test events. If no normal
  `vitest run` or `vitest test` command exists, mark that Vitest entry non-runnable and explain
  that only benchmark mode was found.
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
- Do not include `dd-trace/ci/init`, `NODE_OPTIONS`, or Datadog-specific env vars in discovered
  commands unless they are already unavoidable in the repository; explain if so.
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
2. Inspect package scripts, workspace packages, lockfiles, config files, and dependencies.
3. Resolve dependency/setup requirements for each candidate command.
4. For each framework/package/workspace, identify a small existing passing test command.
5. Run that command without Datadog instrumentation and record the preflight result.
6. Write the manifest immediately with the existing-command and preflight information collected so far.
7. For each runnable framework, create a temporary generated validation test strategy.
8. Prove the generated passing test runs without Datadog instrumentation.
9. Delete all temporary files and record cleanup success.
10. Update the existing manifest with generated strategy details.

For each framework, try at most one representative existing command and one smaller fallback command
before recording the failure. Do not keep inventing alternate runner commands after two attempts.
Record the best failure evidence and continue to the next framework.

Cap discovery output. Do not dump full lockfiles, schemas, package-manager internals, or exhaustive
file lists into the agent context. Read only the manifest example/schema fields needed for the
entries being written. Once supported frameworks, non-runnable frameworks, and one command per
runnable framework are known, write the basic manifest before doing any more exploration.

For Jest projects with multiple configured projects or custom root directories, verify that the
selected command really runs only the intended file. If `npm test -- <file>` or a package script
starts unrelated suites, stop that attempt and use a direct runner command with `--runTestsByPath`
and the repository's required config/project flags. Record the broad-run attempt in `notes`; do not
let it continue as the representative preflight.

For each framework entry, set `project.root`, `project.packageJson`, and `project.name` to the
smallest package or workspace that owns the selected test command. If the command uses package
manager routing flags such as `pnpm --dir`, `yarn --cwd`, `npm --prefix`, or `pnpm --filter`, resolve
the package directory selected by that flag and use that package's `package.json` when it exists.
The command `cwd` may still be the repository root; keep that exact process cwd in the command
object.

If a package script sets `NODE_OPTIONS=...` inline, do not use that package script as the validation
command unless there is no safer command shape. Inline `NODE_OPTIONS` in a package script can shadow
the validator's injected Test Optimization preload. Prefer a direct runner command and move only
the project-required Node options into `command.env.NODE_OPTIONS`; the validator will merge that
value with its own Test Optimization preloads. Never put `dd-trace/ci/init`, `dd-trace/register.js`,
or Datadog-specific environment variables in the manifest's `NODE_OPTIONS`. Record the avoided
package script and the direct equivalent in `notes`. If the package script is the only runnable
form, record that the inline `NODE_OPTIONS` may prevent validation and mark the framework
`requires_manual_setup`.

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
- `status`, `supportLevel`, `project.evidence`, and `notes`
- `setup.commands` for required install/build/setup prerequisites that the validator should replay
- `existingTestCommand` and `preflight` only when a real project test command was selected
- `generatedTestStrategy` only when generated tests were verified or deliberately proposed/skipped

Do not copy the full example. Omit optional fields you cannot fill confidently. For unknown
versions, use `null`. For uncertain setup, set `status` to `requires_manual_setup` or
`detected_not_runnable` and put the concrete reason in `notes`.

A framework entry must not be marked `runnable` only because a generated validation file passed.
Basic Reporting uses `existingTestCommand`, so `existingTestCommand` must be a real project test
command or a deliberately safe direct runner command that can run without the generated files being
present.

If an existing test command fails because tests fail or the repository is missing generated source,
compiled artifacts, browser binaries, a dev server, or another project setup step, record the
dd-trace-less `preflight.exitCode`, `stdoutSummary`, and `stderrSummary`. Prefer a smaller passing
command when one exists. If the failing command is still the best representative command, it may
remain `runnable`: the validator will consider Basic Reporting valid when the instrumented run emits
the required event hierarchy and exits the same way as the dd-trace-less preflight run.

If a documented install/build/setup command fixes the failure, add that command to `setup.commands`
and rerun the dd-trace-less preflight after setup. The validator will replay `setup.commands` before
starting the fake intake. If a required setup command fails during validation, the affected framework
fails before live validation with that setup failure as the primary diagnosis.

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
deterministic validator is the source of truth for feature validation.

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
9. Evaluating Basic Reporting, EFD, ATR, and Test Management behavior.
10. Cleaning up temporary validation files.
11. Writing a validation report, validation UI payloads, and artifacts.

Basic Reporting is the prerequisite for EFD, ATR, and Test Management validation. If Basic Reporting
fails for a framework, the validator skips the remaining feature checks for that framework and
reports the Basic Reporting failure as the root cause.

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
- Pass/fail summary by framework, separating supported live validation from diagnostic-only or
  unsupported framework entries. If a supported framework passed all checks but an unsupported
  framework made the overall validator exit non-zero, state both facts explicitly.
- Pass/fail summary by scenario
- Any frameworks that were detected but not runnable
- Any frameworks that were runnable but unsupported by the validator
- Any setup or preflight commands that failed
- The validator's diagnosis for each failed scenario
- The exact test command associated with each failed scenario
- Relevant stdout/stderr excerpts selected by the validator
- Path to `validation-urls.txt`
- The relative `ci/test/validation#pako:...` UI path or paths emitted by the validator
- Artifact paths for detailed inspection

Do not summarize raw payloads unless the validator explicitly includes them in its report.

Do not claim that Datadog Test Optimization is broken unless the validator reports that diagnosis.

Do not hide manifest-discovery failures behind validator failures. If the manifest was incomplete,
invalid, or based on unverified commands, report that as the primary issue.
