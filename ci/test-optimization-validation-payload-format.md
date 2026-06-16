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
    "version": "11.7.6"
  }
}
```

`status` is `ok` or `failed`.

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
  "samples": [
    { "level": "test session", "test.command": "npm test -- test/sum.spec.js" },
    { "level": "test module", "test.command": "npm test -- test/sum.spec.js" },
    { "level": "test suite", "test.suite": "test/sum.spec.js" },
    { "level": "test", "test.name": "sum adds positive numbers" }
  ]
}
```

When basic reporting fails, the `basic-reporting` check and its `check-events` step evidence include
a concise local diagnosis in `reason`. Examples:

- `Selected command appears to use unsupported test framework(s): Node.js test runner. Choose a supported framework before running the live validation.`
- `Static diagnosis found unsupported framework version(s): Jest 27.5.1 is not supported. Upgrade Jest to >=28.0.0, or use dd-trace v5 for older Jest versions.`
- `Test Optimization initialized and emitted higher-level events, but per-test hooks did not fire. This usually points to an unsupported runner, unsupported framework version, or unsupported framework configuration for the selected command.`

## Static-Only Payloads

When the runbook stops before starting the fake intake because no eligible supported framework or
test command exists, the payload still contains a failed `basic-reporting` check. The intake and
test-run steps are marked `skipped`, and the `check-events` step carries the local diagnosis:

```json
{
  "id": "basic-reporting",
  "status": "failed",
  "reason": "Static diagnosis found unsupported framework version(s): Jest 27.5.1 is not supported.",
  "steps": [
    {
      "id": "setup-intake",
      "status": "skipped",
      "evidence": {
        "reason": "live fake intake was not started"
      }
    },
    {
      "id": "run-tests",
      "status": "skipped",
      "command": "not run",
      "result": "skipped",
      "evidence": {
        "reason": "live validation was skipped before running tests"
      }
    },
    {
      "id": "check-events",
      "status": "failed",
      "evidence": {
        "requestCount": 0,
        "citestcyclePayloads": 0,
        "events": {
          "sessions": 0,
          "modules": 0,
          "suites": 0,
          "tests": 0
        },
        "missingLevels": ["test_session_end", "test_module_end", "test_suite_end", "test"],
        "decodeErrors": 0,
        "reason": "Static diagnosis found unsupported framework version(s): Jest 27.5.1 is not supported."
      }
    }
  ]
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
