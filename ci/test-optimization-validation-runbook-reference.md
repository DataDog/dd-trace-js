# Test Optimization Validation Runbook Reference

This file supports `ci/runbook.md`. Do not read it front-to-back unless needed. Use it when CI
discovery, manifest authoring, dependency setup, or generated-test strategy needs more detail.

## CI Workflow Discovery

Search CI definitions before broad package-script exploration. Read only files needed to identify
test-running jobs and their setup. Hidden CI directories such as `.github`, `.circleci`, and
`.buildkite` are part of the primary search space.

Record CI inventory evidence in top-level `ciDiscovery`:

```json
{
  "ciDiscovery": {
    "searched": [
      ".github/workflows/*.yml",
      ".github/workflows/*.yaml",
      ".gitlab-ci.yml",
      ".circleci/config.yml",
      ".buildkite/pipeline.yml"
    ],
    "found": [
      ".github/workflows/ci.yml"
    ],
    "method": "explicit-known-ci-paths",
    "warnings": [],
    "notes": [
      "GitHub Actions workflow files were inspected before package scripts."
    ]
  }
}
```

If the manifest says `ciWiring.provider` is `none`, records "no CI workflow found", or has an empty
`ciDiscovery.found`, but validator static diagnosis later finds CI workflow files, treat that as a
manifest discovery contradiction. Stop live interpretation of CI wiring, preserve artifacts, inspect
the hidden CI paths explicitly, and update the manifest before rerunning validation.

### GitHub Actions

Inspect `.github/workflows/*.yml` and `.github/workflows/*.yaml`.

For candidate test jobs, record:

- workflow file and workflow name when present
- job id and job name
- `runs-on`
- workflow, job, and step `env`, preserving inheritance order
- `defaults.run.working-directory` at workflow and job levels
- `strategy.matrix` values selected for local replay
- `actions/setup-node` inputs, including `node-version`, `node-version-file`, and `cache`
- dependency install steps
- test-running `run` steps, their shell, working directory, and step name/id
- unresolved expressions, contexts, outputs, secrets, reusable workflows, or generated values

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
- unresolved shared libraries, dynamic Groovy, credentials bindings, or generated commands

### Best-Effort CI Providers

Recognize these CI systems and extract test-command evidence when practical:

- Azure Pipelines: `azure-pipelines.yml`, `.azure-pipelines/*.yml`, `variables`, `jobs`, `steps`,
  `strategy.matrix`, `NodeTool`, `UseNode`, npm/yarn/pnpm tasks, and script/bash/pwsh test steps.
- Bitbucket Pipelines: `bitbucket-pipelines.yml`, `pipelines`, `definitions`, `steps`, `script`,
  `caches`, and `services`.
- Buildkite: `.buildkite/pipeline.yml`, `steps`, `command`, `env`, `agents`, and plugins. Mark
  dynamic pipeline uploads unresolved unless the generated pipeline is locally inspectable.

## Detailed Rules

- Do not create runnable `custom` framework entries for unsupported native runtime test runners,
  such as `bun test` or `deno test`, unless the validator has a real adapter for that runner.
  Record those commands as omitted evidence instead of failed validation targets.
- Use top-level `omitted` for concise human-readable summaries. Add structured
  `omittedTestCommands` when useful, with command, source, reason, classification, and impact.
- Prefer direct framework runner commands over broad package-script wrappers for local fallback and
  generated-test commands when both are equivalent and safe. Do not apply this preference to CI
  wiring validation when the customer's CI job intentionally uses the wrapper.
- If a package script appears to accept a file argument, verify that it really narrows execution.
  Some scripts ignore extra arguments and can run thousands of tests when one file was passed.
- For large monorepos, group packages and CI jobs by command shape before running them. A command
  shape includes framework, package manager, wrapper or monorepo tool, working directory layout,
  required setup, and CI environment. Live-replay one small representative per shape; record the
  other packages or matrix entries as duplicate candidates or omitted commands with source metadata.
- If a framework is validator-supported but only available through commands that need heavy setup
  such as a full monorepo build, Docker, databases, browser downloads, generated clients, or
  external services, mark it `requires_external_service` or `requires_manual_setup` unless that
  setup is already available and documented. This is diagnostic-only and should not make the live
  validation look like a Test Optimization failure.
- Avoid snapshot-update, golden-output, export-matrix, generated-list, benchmark, or very broad
  tests as representative commands when smaller stable tests exist.
- Treat dependency setup as part of test-command discovery. Before reporting that a runner is
  missing, check whether declared dependencies and documented setup have been installed.
- Record required setup commands in `setup.commands` when a selected test command only works after
  documented install, build, code generation, browser-binary install, or fixture preparation.
- Do not invent setup commands. Use package-manager install commands, package scripts, or repository
  documentation. If the required setup is unclear, mark the framework `requires_manual_setup`.
- `existingTestCommand`, `preflight`, and `forcedLocalCommand` must be Datadog-clean.
- For CI wiring commands, record `NODE_OPTIONS` and Datadog-specific environment variables exactly
  as CI configured them, except secret values must be replaced with explicit safe dummy values.
  Record original secret variable names in CI metadata.
- The validator may add fake-intake transport and noise-suppression variables when it executes
  commands. Do not copy those validator-added values back into CI evidence.
- A generated test strategy is `verified` only if temporary files were created, at least the stable
  passing generated scenario ran without Datadog instrumentation, and the files were deleted.

## Inline NODE_OPTIONS

If a CI workflow or package script sets `NODE_OPTIONS=...` inline, first decide which validation path
you are documenting:

- For CI wiring validation, preserve the CI-defined value exactly in `displayCommand` and CI
  configuration evidence, except for replacing secret expansions with placeholders and recording
  original variable names. The executable command must still use the safe structured form below.
- If a simple leading shell assignment such as `NODE_OPTIONS="-r dd-trace/ci/init" pnpm test` can be
  represented as `ciWiringCommand.env.NODE_OPTIONS` without changing process semantics, prefer that
  structured representation. It lets the validator's `NODE_OPTIONS` probe check whether a preload
  reaches the final test runner.
- The validator refuses inline assignments or removals for `NODE_OPTIONS` and fake-intake transport
  variables because shell-local values can override diagnostic containment. If the CI command cannot
  be represented with equivalent structured `command.env` values, record the exact command as
  evidence and mark local CI wiring replay as requiring manual setup instead of executing it.
- For direct-initialization validation, do not use a package script with inline Datadog
  `NODE_OPTIONS` unless there is no safer command shape. Prefer a direct runner command and move
  only project-required, non-Datadog Node options into `command.env.NODE_OPTIONS`.

Never add `dd-trace/ci/init`, `dd-trace/register.js`, or Datadog-specific environment variables to
direct-initialization manifest commands manually.

Do not skip a replayable CI test command merely because CI configures no Datadog initialization.
Represent the executable command and its non-secret CI environment exactly in `ciWiringCommand`.
Running that command and observing no Test Optimization events is how the validator proves that the
CI job is not wired. Use `skip` only when the CI-shaped command cannot be replayed safely or required
setup is unavailable. `unknown` records incomplete discovery and causes an unsuccessful validation
unless a replay command supplies the missing evidence.

## Framework Source Trees

Do not use a test framework's own source-tree runner as customer validation evidence. For example,
inside the Mocha repository, `node ./bin/mocha.js ...` runs Mocha's local source files rather than
an installed `mocha` package from `node_modules`; that is not the same shape as a customer project
using Mocha. If the repository package is the framework itself and the command invokes local `bin/`
or `src/` runner code, prefer another real project framework in the repository. If none exists, mark
that framework `detected_not_runnable` and explain that the available command runs the framework
source tree.

## Manifest Authoring Details

Use the smallest valid shape. Omit optional fields you cannot fill confidently. For unknown
versions, use `null`. For uncertain setup, set `status` to `requires_manual_setup` or
`detected_not_runnable` and put the concrete reason in `notes`.

Useful optional CI metadata:

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
    "whySelected": "The GitHub Actions unit job runs this step after dependency installation.",
    "packageScriptExpansionChain": [
      "pnpm test",
      "jest"
    ],
    "runnerToolChain": [
      "pnpm test",
      "jest"
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
    "description": "Direct Jest command for an existing stable project test",
    "cwd": "/absolute/path/to/repo/packages/app",
    "argv": [
      "pnpm",
      "jest",
      "--runTestsByPath",
      "/absolute/path/to/repo/packages/app/src/sum.test.js"
    ],
    "timeoutMs": 300000
  }
}
```

This example is not a complete manifest. Do not put unresolved placeholders such as
`${NODE_OPTIONS}` into executable fields. If a CI secret is needed only so the command shape matches
CI, use an explicit safe dummy value such as `dd-validation-placeholder`, record the original secret
name in CI metadata such as `requiredSecretEnvVars`, and explain it in `unresolved` or `notes`.

Use omitted-command metadata like this when CI or package discovery finds test commands that should
not become runnable validation entries:

```json
{
  "omitted": [
    "bun test from .github/workflows/ci.yml job bun was omitted because Bun is unsupported."
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
supported runner such as Vitest, Jest, or Mocha is present, validate that supported runner and report
the omitted native runtime command separately.

## Dependency Setup and Runner Availability

The test runner binary must be available from the command `cwd` before a framework is considered
runnable. A missing runner usually means:

- repository dependencies have not been installed
- the command belongs to a workspace package and must use a workspace/package-manager entry point
- the command belongs to a nested non-workspace fixture with its own `package.json`
- the nested fixture requires documented setup before install

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
      }
    ],
    "services": []
  }
}
```

Respect declared runtime and package-manager versions before classifying a command as broken. Check
`engines`, `devEngines`, `.nvmrc`, `.node-version`, `.tool-versions`, `volta`, `packageManager`,
lockfiles, and workspace metadata.

Do not classify a missing runner dependency as a Datadog Test Optimization failure.

Do not leave `notes` empty for `detected_not_runnable`, `requires_external_service`,
`requires_manual_setup`, `unsupported_by_validator`, or `unknown` framework entries. The validator
uses those notes as the customer-facing reason when Basic Reporting cannot run.

## Generated Test Strategy

The generated strategy must give the deterministic validator enough information to recreate
validation tests without using intelligence.

Generated files are available only for advanced scenarios. Do not reference generated validation
files from `existingTestCommand`, `preflight`, `forcedLocalCommand`, or `ciWiringCommand`.

Never copy a real secret into a command environment. Use the literal value
`dd-validation-placeholder` for secret-like variables such as `DD_API_KEY`; runtime manifest
validation rejects other values before project code can run.

When generated files live in a nested package, prefer setting the command `cwd` to that package
directory over relying on `npm --prefix ... exec` or similar package-manager routing. Some
package-manager `exec` forms preserve the original process cwd for test-runner config resolution,
which can make a generated file look missing even though it exists in the nested package.

For each runnable framework, include generated file contents as `contentLines`. The validator can
join those lines with newline characters and write the files exactly.

Use only small synthetic source with printable characters, no invisible Unicode or control characters,
and no secret-like values. Each
`contentLines` entry must be one source line. The validator limits each framework to eight generated
files, each file to 256 lines and 32 KiB, and each line to 4096 bytes. The exact source is displayed
in the approval plan before it can execute.

When `generatedTestStrategy.status` is `planned` or `verified`, the generated tests must support:

- `basic-pass`: a stable passing test used for basic reporting and EFD new-test validation
- `atr-fail-once`: a test that fails on the first attempt and passes on retry, preferably using a
  temporary state file
- `test-management-target`: a stable, named test identity suitable for Test Management checks

Each generated scenario's `runCommand` must run only that scenario. If the framework can focus by
test name, use the framework's focused-name option. If it cannot focus reliably by name, use
separate generated files per scenario and make each `runCommand` target only that file.

Declare each focused command's Datadog-clean expected outcome. The validator verifies exactly one
observed test before it runs advanced scenarios. The required `expectedWithoutDatadog` outcomes are:

- `basic-pass`: exit code `0`, observed test count `1`
- `atr-fail-once`: exit code `1`, observed test count `1`
- `test-management-target`: exit code `0`, observed test count `1`

If command output does not prove that exactly one test ran, validator-owned verification fails and
advanced validation remains incomplete. Do not ask the user to approve or run a separate manual
verification command.

Do not assume a JavaScript `describe()` name becomes `test.suite`. Jest and Vitest commonly report
the test-file path as the suite and include `describe()` text in the test name. Use `suite: null`
unless an observed instrumented event proves the exact suite value. A stable test name plus absolute
file path is sufficient for the validator's baseline identity discovery.

If `atr-fail-once` uses a state file, list that state file in
`generatedTestStrategy.cleanupPaths`. Use an exact file path, not a directory. The validator records
that the file is absent before the strategy starts, then removes it between verification and
advanced scenarios. It refuses to remove a pre-existing file and does not scan directories for
similarly named files. Do not rely on test code to clean up its own retry state.

Before choosing generated test syntax and file extension, inspect the nearest `package.json` and
mirror the module format used by nearby tests. If generated tests cannot be planned concretely, use
`proposed` or `not_possible` and include the limitation explicitly.
