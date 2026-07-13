# Test Optimization Validation Payload Format

The validator writes one JSON payload per framework inside the detailed Markdown report:

```text
dd-test-optimization-validation-results/report.md
```

The Markdown report is a local/internal diagnostic artifact, not a public-shareable report. It may
include repository paths, package names, CI workflow/job/step names, commands, runner/tool chains,
and sanitized environment variable structure. Secret-like values are redacted on a best-effort
basis, but callers should review and redact the generated report and artifacts before sharing
outside trusted channels.

## Top-Level Payload

```json
{
  "version": 2,
  "source": "dd-trace-js",
  "type": "test-optimization-validation",
  "status": "ok",
  "checks": [],
  "artifacts": {
    "reportPath": "/absolute/path/to/dd-test-optimization-validation-results/report.md"
  },
  "ciCommandCandidate": {
    "provider": "github-actions",
    "configFile": "/absolute/path/to/repo/.github/workflows/ci.yml",
    "workflow": "ci",
    "job": "unit",
    "step": "Run tests",
    "command": "pnpm test",
    "cwd": "/absolute/path/to/repo",
    "whySelected": "The workflow step runs the unit test package script.",
    "env": {
      "workflow": {},
      "job": {
        "NODE_OPTIONS": "-r dd-trace/ci/init"
      },
      "step": {
        "DD_API_KEY": "<redacted>"
      }
    },
    "packageScriptExpansionChain": ["pnpm test", "nx run-many --target=test"],
    "runnerToolChain": ["pnpm test", "nx", "jest"]
  },
  "ciDiscovery": {
    "searched": [".github/workflows/*.yml", ".github/workflows/*.yaml"],
    "found": [".github/workflows/ci.yml"],
    "staticFound": [".github/workflows/ci.yml"],
    "method": "explicit-known-ci-paths",
    "warnings": [],
    "notes": [],
    "contradictions": []
  },
  "framework": {
    "id": "mocha",
    "name": "Mocha",
    "version": "11.7.6",
    "language": "javascript",
    "packageName": "example-package",
    "workingDirectory": "/absolute/path/to/repo/packages/example-package",
    "commandWorkingDirectory": "/absolute/path/to/repo",
    "projectRoot": "/absolute/path/to/repo/packages/example-package",
    "packageJson": "/absolute/path/to/repo/packages/example-package/package.json"
  }
}
```

`status` is `ok`, `failed`, or `unknown`. The validator's execution results may use `blocked` for
execution-environment blockers, but validation payloads map that to `unknown` for compatibility
with payload consumers.

`framework.language` is currently hardcoded to `javascript`. `workingDirectory`, `projectRoot`,
and `packageJson` come from the manifest framework entry so the UI can show which workspace package
produced the result. `packageName` comes from the manifest project name and falls back to the
referenced `package.json` name when possible. `workingDirectory` is the selected package/workspace
root. `commandWorkingDirectory` is the literal cwd used to spawn the selected test command, which can
be different when the command uses package-manager flags such as `--dir`, `--cwd`, or `--prefix`.

`ciDiscovery` is optional. When present, it records the CI inventory used by the runbook/validator:

- `searched`: known CI locations that were checked. Hidden directories such as `.github` must be
  represented explicitly.
- `found`: CI files recorded by the manifest author, or static diagnosis when the manifest omitted
  this field.
- `staticFound`: CI files independently found by validator static diagnosis.
- `method`: the discovery method, such as `explicit-known-ci-paths` or `validator-static-diagnosis`.
- `warnings` and `notes`: user-facing context about discovery limitations.
- `contradictions`: cases where the manifest claimed no CI while static diagnosis found CI files.

If `contradictions` is non-empty, the UI should treat the CI wiring evidence as incomplete until
the manifest is regenerated with hidden CI paths inspected explicitly.

`ciCommandCandidate` is optional and appears when the manifest identified a CI test command. It is
the normalized UI shape for the selected CI provider/workflow/job/step, exact selected command, why
the command was selected, environment found at workflow/job/step scope, package-script expansion
chain, and runner/tool chain. Sensitive environment values are redacted; `NODE_OPTIONS` and
non-secret Datadog configuration are preserved because they are the wiring being diagnosed.

## Validator Artifacts

`dd-trace/ci/validate-test-optimization.js` writes one detailed Markdown report with one canonical
diagnostic JSON object:

- `report.md`: readable execution details plus a `Diagnostic JSON` section containing
  `validationPayloads`, `normalizedManifest`, `staticDiagnosis`, and `runSummary`. Each validation
  payload entry is `{ frameworkId, payload }`; overlapping raw execution-result JSON is not serialized
  a second time. `runSummary.runCompleted` and `runSummary.validatorExitCode` distinguish a completed
  validation with findings from an interrupted run.

Multi-framework repositories should present each payload separately. A failed static-only payload is
emitted when live validation is skipped because static diagnosis found a hard blocker, such as an
unsupported framework or unsupported framework version.

If a framework is detected but no runnable validation command is available, the payload is
`unknown` with a skipped Basic Reporting check. Basic reporting was not proven, so the UI should not
present that framework as OK or as a Test Optimization failure. Because no live validation was
attempted, the skipped check has no steps. The skip cause is in the check-level `reason`.

Required project setup command failures are still failed validation results. If install, build, code
generation, or browser-binary installation fails before live validation starts, the failed check has
`steps: []`; the setup command, exit code, and output excerpts are available in the Markdown report
and artifact files.

## Checks

Each check has this shape:

```json
{
  "id": "basic-reporting",
  "name": "Basic reporting",
  "status": "ok",
  "reason": "optional failure cause when status is failed",
  "steps": []
}
```

Known check IDs:

- `ci-wiring`
- `execution-environment`
- `basic-reporting`
- `efd-new-test-detection-and-retry`
- `auto-test-retries`
- `test-management`

Check and step statuses can be:

- `ok`
- `failed`
- `unknown`
- `skipped`

## Steps

Each step has this general shape:

```json
{
  "id": "run-tests",
  "name": "Run tests",
  "status": "ok",
  "command": "npm test -- test/sum.spec.js",
  "exitCode": "0",
  "result": "3 passing",
  "snippet": "optional source snippet",
  "evidence": {
    "samples": []
  }
}
```

Fields such as `command`, `exitCode`, `result`, `snippet`, and `evidence` are present only when
they apply to that step.

`command` is a display command, not necessarily the exact spawned argv. The validator keeps the
exact command, cwd, exit code, and timing in the local `runs/*/*/command.json` artifacts. If the
selected command required runtime plumbing such as a `/usr/bin/env PATH=...` prefix plus a
`node .../corepack.js pnpm ...` wrapper, the payload collapses that to the user-facing
package-manager command and records the collapse in `evidence.commandDetails`:

```json
{
  "id": "run-tests",
  "command": "pnpm vitest run packages/zod/src/index.test.ts",
  "evidence": {
    "commandDetails": {
      "exactCommandCollapsed": true,
      "pathAdjusted": true,
      "runtimeWrapper": "node/corepack",
      "packageManager": "pnpm"
    }
  }
}
```

## Basic Reporting Evidence

Basic reporting includes request counts, event counts, missing event levels, decode errors, and up
to four compact samples: one per event level.

```json
{
  "requestCount": 4,
  "citestcyclePayloads": 1,
  "events": {
    "sessions": 1,
    "modules": 1,
    "suites": 1,
    "tests": 2
  },
  "missingLevels": [],
  "decodeErrors": 0,
  "reason": "optional failure cause when basic reporting failed",
  "eventLevelFailure": {
    "kind": "missing-test-events",
    "missingLevels": ["test"],
    "summary": "Test Optimization initialized and emitted higher-level events, but per-test events were missing.",
    "recommendation": "Choose a smaller standard test command, then inspect the debug rerun output.",
    "customTestRunner": {
      "name": "jest-light-runner",
      "source": "/absolute/path/to/jest.config.ts",
      "sourceType": "config",
      "signals": [
        "Jest config /absolute/path/to/jest.config.ts sets runner: jest-light-runner"
      ]
    },
    "signals": []
  },
  "debugRerun": {
    "ran": true,
    "commandExitCode": 0,
    "debugLines": []
  },
  "debugExcerpt": [
    "dd-trace is not initialized in a package manager.",
    "1 passing (1ms)"
  ],
  "localDiagnosis": {
    "kind": "tests-ran-tracer-not-initialized",
    "summary": "The selected command ran tests, but no Test Optimization events reached the fake intake.",
    "recommendation": "Try a direct test-runner command, or verify NODE_OPTIONS reaches the final test process."
  },
  "samples": [
    { "level": "test session", "test.command": "npm test -- test/sum.spec.js" },
    { "level": "test module", "test.command": "npm test -- test/sum.spec.js" },
    { "level": "test suite", "test.suite": "test/sum.spec.js" },
    { "level": "test", "test.name": "sum adds positive numbers" }
  ]
}
```

The payload only includes user-facing validation steps. It does not include fake-intake setup as a
step; that setup is validator plumbing. If the fake intake cannot bind or connect to localhost
because the execution environment blocks local sockets, the affected framework is reported as an
execution-environment blocker instead of an ordinary Basic Reporting failure:

```json
{
  "id": "execution-environment",
  "name": "Local fake intake",
  "status": "unknown",
  "reason": "The current agent sandbox blocks localhost sockets, so the validator could not start the fake Datadog intake.",
  "remediation": [
    "Rerun the validator command shown below from the host shell",
    "Rerun in an agent mode that allows localhost sockets while retaining credential, outbound-network, and filesystem restrictions",
    "Rerun in CI"
  ],
  "evidence": {
    "blockedByExecutionEnvironment": true,
    "localNetworkingBlocked": true,
    "manifestMayBeReused": true,
    "intakeStarted": false,
    "errorCode": "EPERM",
    "errorSyscall": "listen",
    "errorAddress": "127.0.0.1",
    "rerunCommand": "node /absolute/path/to/validate-test-optimization.js --manifest ./dd-test-optimization-validation-manifest.json --out ./dd-test-optimization-validation-results --approved-plan-sha256 <digest-from-approved-plan>"
  },
  "steps": []
}
```

This means no Test Optimization conclusion was reached. The UI should tell the user to preserve the
manifest/artifacts and rerun live validation from a host shell, CI, or an agent mode that allows
localhost sockets for the validator command.

When live basic reporting runs and fails, the `basic-reporting` check and its `check-events` step
evidence include a concise local diagnosis in `reason`. Examples:

- `Selected command appears to use unsupported test framework(s): Node.js test runner. Choose a supported framework before running the live validation.`
- `Static diagnosis found unsupported framework version(s): Jest 27.5.1 is not supported. Upgrade Jest to >=28.0.0, or use dd-trace v5 for older Jest versions.`
- `Test Optimization initialized and emitted higher-level events, but per-test hooks did not fire. This usually points to an unsupported runner, unsupported framework version, or unsupported framework configuration for the selected command.`

When the command exits successfully but required event levels are missing, `eventLevelFailure`
contains a structured local cause:

- `kind: "vitest-benchmark"` means the selected command appears to be `vitest bench` or a
  benchmark-only `*.bench.*` run. This is not a normal test command; choose `vitest run <test-file>`
  or another standard Vitest test command.
- `kind: "missing-test-events"` means Test Optimization emitted higher-level events but no per-test
  events. This usually points to an unsupported runner mode, unsupported framework configuration, or
  per-test hooks not firing for the selected command.
- `kind: "custom-jest-runner"` means the selected Jest command uses a non-default Jest `runner`,
  such as `jest-light-runner` or `jest-runner-eslint`, and Test Optimization initialized but did not
  receive per-test events. The runner name and source file are present in
  `eventLevelFailure.customTestRunner`. This should be shown as a runner-compatibility diagnosis, not
  as a CI wiring failure.
- `kind: "no-test-optimization-events"` means no Test Optimization event levels reached the local
  fake intake.
- `kind: "framework-source-tree-runner"` means the selected command ran the test framework's own
  source-tree runner, such as `node ./bin/mocha.js` inside the Mocha repository, rather than an
  installed framework package in a customer project.
- `localDiagnosis.kind: "tests-ran-tracer-not-initialized"` means the selected command output proves
  tests ran, but the debug rerun still produced no Test Optimization events and showed tracer
  initialization evidence such as `dd-trace is not initialized in a package manager.`

For ambiguous successful-command failures, the validator reruns the same command once with
`DD_TRACE_DEBUG=1` and `DD_TRACE_LOG_LEVEL=debug`. Compact excerpts appear in `debugRerun`.
The most useful user-facing lines are duplicated into `debugExcerpt`, and the `run-tests` step
`result` contains a compact test-output summary such as `1 passing (2ms)` when one can be inferred.
Recognized non-test command shapes such as `vitest-benchmark` do not trigger the debug rerun because
the local cause is already known and benchmark reruns can be slow.

EFD, Auto Test Retries, and Test Management depend on Basic Reporting. When Basic Reporting fails
for a framework, the validator skips those feature checks and includes the Basic Reporting diagnosis
as the reason.

CI wiring failures can include an independent initialization probe. In user-facing text, describe
this as a `NODE_OPTIONS` probe: a temporary preload that records which Node.js processes received
the preload and whether known test-runner modules were observed. It is used only as wiring evidence;
it is not a Datadog payload.

```json
{
  "initializationProbe": {
    "ran": true,
    "commandExitCode": 0,
    "commandTimedOut": false,
    "processCount": 1,
    "moduleLoadCount": 0,
    "reachedAnyNodeProcess": true,
    "reachedTestRunnerProcess": false,
    "wrapperSignals": [
      {
        "name": "nx",
        "kind": "wrapper",
        "pid": 12345,
        "source": "process-start",
        "argv": ["node", "/absolute/path/to/tools/nx.js"]
      }
    ],
    "testRunnerSignals": [],
    "recordsPath": "/absolute/path/to/results/runs/jest-root/ci-wiring/initialization-probe/records.ndjson"
  },
  "monorepoFindings": [
    {
      "id": "node-options-not-observed-in-test-runner",
      "tool": "node",
      "reason": "The NODE_OPTIONS probe reached an intermediate Node.js process but not the detected test runner.",
      "recommendation": "Trace the command chain from the CI step to the test runner and find where NODE_OPTIONS is removed or replaced."
    }
  ]
}
```

If `initializationProbe.reachedTestRunnerProcess` is `false` while wrapper or package-manager
signals are present, the UI should explain that initialization reached an intermediate process but
does not appear to reach Jest, Vitest, Mocha, or the detected final test runner.

Skipped advanced feature checks can include `featureEligibility`:

```json
{
  "featureEligibility": {
    "eligible": false,
    "blockedBy": "basic-reporting",
    "reasonCode": "basic-reporting-failed",
    "scenario": "efd"
  }
}
```

Known `reasonCode` values include `basic-reporting-failed`,
`generated-test-strategy-missing`, `generated-test-strategy-proposed-only`,
`generated-test-strategy-not-possible`, `generated-test-strategy-not-verified`, and
`generated-scenario-missing`.

When the selected Basic Reporting command exits non-zero, `check-events.evidence.commandFailure`
contains compact stdout/stderr excerpts plus classified build/module-resolution/assertion lines.
If the command also emitted all required event levels and the exit code matches the dd-trace-less
preflight exit code recorded in the manifest, Basic Reporting remains `ok`; the `run-tests` step
includes a result such as `exited 1, matching dd-trace-less preflight`.

## Static-Only Payloads

When the runbook stops before starting the fake intake because no eligible supported framework or
test command exists, the payload still contains a failed `basic-reporting` check. Since no intake
or test command was executed, `steps` is empty and the local diagnosis is carried by `reason`:

```json
{
  "id": "basic-reporting",
  "status": "failed",
  "reason": "Static diagnosis found unsupported framework version(s): Jest 27.5.1 is not supported.",
  "steps": []
}
```

## Early Flake Detection Samples

Early Flake Detection samples prove that a new test was marked as new and retried. Feature sample
lists are capped at three entries.

```json
{
  "test.name": "dd trace EFD debug temporary test",
  "test.is_new": true,
  "test.is_retry": true,
  "test.retry_reason": "early_flake_detection"
}
```

## Auto Test Retries Samples

Auto Test Retries samples prove that a known flaky test produced failing and retry executions.
Feature sample lists are capped at three entries.

```json
{
  "test.name": "sum adds positive numbers",
  "test.status": "pass",
  "test.is_retry": true,
  "test.retry_reason": "auto_test_retry"
}
```

## Test Management Samples

Test Management samples prove that managed test tags reached emitted test events. Feature sample
lists are capped at three entries.

```json
{
  "test.name": "managed test",
  "test.status": "skip",
  "test.test_management.is_test_disabled": true
}
```

Other Test Management sample fields can include:

- `test.final_status`
- `test.retry_reason`
- `test.is_retry`
- `test.test_management.is_quarantined`
- `test.test_management.is_attempt_to_fix`
- `test.test_management.attempt_to_fix_passed`
