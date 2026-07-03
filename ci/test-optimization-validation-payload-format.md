# Test Optimization Validation Payload Format

The validation UI receives a compact JSON payload encoded into a relative path:

```text
ci/test/validation#pako:<base64url(deflate(JSON.stringify(payload)))>
```

To decode it:

1. Read the value after `#pako:`.
2. Base64url-decode it.
3. Inflate it with pako.
4. Parse the inflated string as JSON.

The validation UI decodes the payload with:

```js
const compressed = Buffer.from(encoded, 'base64url')
const payload = JSON.parse(pako.inflate(compressed, { to: 'string' }))
```

## Top-Level Payload

```json
{
  "version": 2,
  "source": "dd-trace-js",
  "type": "test-optimization-validation",
  "status": "ok",
  "checks": [],
  "artifacts": {
    "htmlFileUrl": "file:///...",
    "htmlPath": "/..."
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

`status` is `ok`, `failed`, or `unknown`. The validator's local JSON report may use `blocked` for
execution-environment blockers, but the pako/UI payload maps that to `unknown` for compatibility
with the current validation UI.

`framework.language` is currently hardcoded to `javascript`. `workingDirectory`, `projectRoot`,
and `packageJson` come from the manifest framework entry so the UI can show which workspace package
produced the result. `packageName` comes from the manifest project name and falls back to the
referenced `package.json` name when possible. `workingDirectory` is the selected package/workspace
root. `commandWorkingDirectory` is the literal cwd used to spawn the selected test command, which can
be different when the command uses package-manager flags such as `--dir`, `--cwd`, or `--prefix`.

## Validator Artifacts

`dd-trace/ci/validate-test-optimization.js` writes one payload per framework entry that produced a
validator result:

- `validation-payloads.json`: array of `{ frameworkId, payload, url }`
- `validation-urls.txt`: one `frameworkId: ci/test/validation#pako:...` line per framework
- `validation-url.txt`: first emitted URL for simple single-framework consumers

Multi-framework repositories should present each URL separately. A failed static-only payload is
emitted when live validation is skipped because static diagnosis found a hard blocker, such as an
unsupported framework or unsupported framework version.

If a framework is detected but no runnable validation command is available, the payload is also
failed. Basic reporting was not proven, so the UI should not present that framework as OK.
Because no live validation was attempted, the failed check has no steps. The failure cause is in
the check-level `reason`.

The same shape is used when a required project setup command, such as install, build, code
generation, or browser-binary installation, fails before live validation starts. The failed check has
`steps: []`; the setup command, exit code, and output excerpts are available in the JSON report
evidence and artifact files.

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
    "In Codex, approve running that single validator command outside the sandbox",
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
    "rerunCommand": "node /absolute/path/to/validate-test-optimization.js --manifest ./dd-test-optimization-validation-manifest.json --out ./dd-test-optimization-validation-results"
  },
  "steps": []
}
```

This means no Test Optimization conclusion was reached. The UI should tell the user to preserve the
manifest/artifacts and rerun live validation from a host shell, by approving the single validator command to run outside the agent sandbox, or from CI.

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
