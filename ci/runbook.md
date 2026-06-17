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

## Goal

Create a complete, verified manifest that tells a deterministic validator:

1. Which test frameworks are present.
2. How to set up and run a small existing passing test subset for each framework.
3. How to create temporary validation tests for each framework.
4. How to run only those generated validation tests.
5. Which generated test identities the validator should expect in Datadog payloads.

The manifest is discovery only. The deterministic validator will later start the mock intake, inject
Datadog environment variables, run these commands, collect payloads, and validate Test Optimization
behavior.

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
- Treat dependency setup as part of test-command discovery. Before reporting that a runner is
  missing, check whether the command's package or workspace has had its declared dependencies and
  documented setup installed.
- Do not include secrets. Record required environment variable names only.
- Do not include `dd-trace/ci/init`, `NODE_OPTIONS`, or Datadog-specific env vars in discovered
  commands unless they are already unavoidable in the repository; explain if so.
- All paths must be absolute.
- A generated test strategy is `verified` only if you created the temporary file or files, ran at
  least the stable passing generated scenario without Datadog instrumentation, and deleted the files
  afterward.
- If you cannot verify generated tests, mark the strategy as `proposed` or `not_possible`.
- Write only valid JSON to `./dd-test-optimization-validation-manifest.json`.

## Discovery Steps

1. Detect repository root, package manager, workspace manager, Node version, and git metadata.
2. Inspect package scripts, workspace packages, lockfiles, config files, and dependencies.
3. Resolve dependency/setup requirements for each candidate command.
4. For each framework/package/workspace, identify a small existing passing test command.
5. Run that command without Datadog instrumentation and record the preflight result.
6. For each runnable framework, create a temporary generated validation test strategy.
7. Prove the generated passing test runs without Datadog instrumentation.
8. Delete all temporary files and record cleanup success.
9. Write only valid JSON matching the manifest shape below.

If an existing test command fails because tests fail or the repository is missing generated source,
compiled artifacts, browser binaries, a dev server, or another project setup step, record the
dd-trace-less `preflight.exitCode`, `stdoutSummary`, and `stderrSummary`. Prefer a smaller passing
command when one exists. If the failing command is still the best representative command, it may
remain `runnable`: the validator will consider Basic Reporting valid when the instrumented run emits
the required event hierarchy and exits the same way as the dd-trace-less preflight run.

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

The generated tests should support these scenarios when possible:

- `basic-pass`: a stable passing test used for basic reporting and EFD new-test validation.
- `atr-fail-once`: a test that fails on the first attempt and passes on retry, preferably using a
  temporary state file.
- `test-management-target`: a stable, named test identity suitable for disabled, quarantined, or
  attempt-to-fix checks.

If a framework cannot support one of these scenarios, include the limitation explicitly.

## Manifest Shape

```json
{
  "schemaVersion": "1.0",
  "generatedAt": "2026-06-17T00:00:00.000Z",
  "repository": {
    "root": "/absolute/path/to/repo",
    "gitRemote": "string-or-null",
    "gitSha": "string-or-null",
    "packageManager": "npm|yarn|pnpm|bun|mixed|unknown",
    "workspaceManager": "npm|yarn|pnpm|lerna|nx|turbo|rush|none|unknown"
  },
  "environment": {
    "os": "darwin|linux|windows|unknown",
    "shell": "string-or-null",
    "nodeVersion": "string-or-null",
    "requiredEnvVars": ["ENV_VAR_NAME_ONLY"],
    "safeEnv": {}
  },
  "frameworks": [
    {
      "id": "jest:packages/ui",
      "framework": "jest|vitest|mocha|cucumber|cypress|playwright|node:test|ava|tap|jasmine|karma|uvu|testcafe|custom|unknown",
      "frameworkVersion": "string-or-null",
      "language": "javascript|typescript|mixed|unknown",
      "status": "runnable|detected_not_runnable|requires_external_service|requires_manual_setup|unsupported_by_validator|unknown",
      "supportLevel": "validator_supported|dd_trace_supported_but_validator_missing_adapter|detected_only|unknown",
      "project": {
        "name": "string-or-null",
        "root": "/absolute/path/to/project",
        "packageJson": "/absolute/path/to/package.json-or-null",
        "configFiles": ["/absolute/path/to/config-file"],
        "evidence": ["why this framework was detected"]
      },
      "setup": {
        "commands": [
          {
            "id": "install",
            "description": "Install dependencies if missing",
            "cwd": "/absolute/path/to/repo",
            "argv": ["npm", "ci"],
            "env": {},
            "requiredEnvVars": [],
            "timeoutMs": 600000,
            "usesShell": false,
            "shellCommand": null,
            "shellReason": null,
            "required": false
          }
        ],
        "services": [
          {
            "name": "postgres",
            "required": false,
            "description": "Only required for broad integration tests; selected validation command avoids it"
          }
        ]
      },
      "existingTestCommand": {
        "description": "Small passing existing test subset",
        "cwd": "/absolute/path/to/project",
        "argv": ["npm", "test", "--", "path/to/existing.test.js"],
        "env": {},
        "requiredEnvVars": [],
        "timeoutMs": 300000,
        "usesShell": false,
        "shellCommand": null,
        "shellReason": null
      },
      "preflight": {
        "ran": true,
        "command": "existingTestCommand",
        "exitCode": 0,
        "durationMs": 12345,
        "observedTestCount": 1,
        "stdoutSummary": "short non-secret summary",
        "stderrSummary": "short non-secret summary"
      },
      "generatedTestStrategy": {
        "status": "verified|proposed|not_possible",
        "reason": "string-or-null",
        "adapter": "jest|vitest|mocha|cucumber|cypress|playwright|node:test|generic-js|custom|unknown",
        "testDirectory": "/absolute/path/to/generated/test/directory-or-null",
        "moduleSystem": "commonjs|esm|typescript|unknown",
        "fileExtension": ".test.js",
        "supportsFocusedSingleFileRun": true,
        "usesMultipleFiles": false,
        "files": [
          {
            "path": "/absolute/path/to/dd-test-optimization-validation.test.js",
            "role": "test|feature|steps|support|state|config",
            "contentLines": [
              "describe('dd-test-optimization-validation', () => {",
              "  it('basic-pass', () => {",
              "    expect(true).toBe(true)",
              "  })",
              "})"
            ]
          }
        ],
        "scenarios": [
          {
            "id": "basic-pass",
            "purpose": "basic_reporting|efd_candidate",
            "runCommand": {
              "cwd": "/absolute/path/to/project",
              "argv": ["npm", "test", "--", "path/to/dd-test-optimization-validation.test.js"],
              "env": {},
              "requiredEnvVars": [],
              "timeoutMs": 300000,
              "usesShell": false,
              "shellCommand": null,
              "shellReason": null
            },
            "expectedWithoutDatadog": {
              "exitCode": 0,
              "observedTestCount": 1
            },
            "testIdentities": [
              {
                "suite": "dd-test-optimization-validation",
                "name": "basic-pass",
                "file": "/absolute/path/to/dd-test-optimization-validation.test.js",
                "parameters": null
              }
            ]
          }
        ],
        "verification": {
          "createdTemporaryFiles": true,
          "ranScenarioIds": ["basic-pass"],
          "exitCode": 0,
          "durationMs": 12345,
          "observedTestCount": 1,
          "cleanupCompleted": true,
          "stdoutSummary": "short non-secret summary",
          "stderrSummary": "short non-secret summary"
        },
        "cleanupPaths": [
          "/absolute/path/to/dd-test-optimization-validation.test.js",
          "/absolute/path/to/.dd-test-optimization-validation-state.json"
        ],
        "limitations": []
      },
      "notes": []
    }
  ],
  "omitted": [],
  "warnings": []
}
```

# Phase 2 Runbook Addition

## Phase 2: Run Deterministic Validation

After writing `./dd-test-optimization-validation-manifest.json`, run the Datadog Test Optimization validator shipped with the installed library.

Do not manually evaluate Datadog payloads. Do not inspect or rewrite validator internals. Do not decide whether Test Optimization behavior is correct by reading raw intake requests yourself. The deterministic validator is the source of truth for feature validation.

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

If the repository uses Yarn Plug'n'Play, pnpm, workspaces, or another non-standard module resolution setup, resolve and execute the validator through the package manager mechanism that works in this repository. Examples:

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
3. Starting a local mock intake when at least one framework is eligible for live validation.
4. Serving Datadog Test Optimization settings responses.
5. Creating temporary validation tests from the manifest.
6. Running test commands with Datadog instrumentation enabled.
7. Reading and decoding intake payloads.
8. Evaluating Basic Reporting, EFD, ATR, and Test Management behavior.
9. Cleaning up temporary validation files.
10. Writing a validation report, validation UI payloads, and artifacts.

Basic Reporting is the prerequisite for EFD, ATR, and Test Management validation. If Basic Reporting
fails for a framework, the validator skips the remaining feature checks for that framework and
reports the Basic Reporting failure as the root cause.

Your job in this phase is only to run the validator and preserve its output.

If the validator succeeds, continue to Phase 3.

If the validator fails because Test Optimization behavior did not match expectations, continue to Phase 3 and report the validator diagnosis.

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
- Pass/fail summary by framework
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

Do not hide manifest-discovery failures behind validator failures. If the manifest was incomplete, invalid, or based on unverified commands, report that as the primary issue.
