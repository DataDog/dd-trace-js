---
name: test-optimization-testing
description: >
  Validate v5 compatibility when adding or modifying Test Optimization or test framework
  integration tests in dd-trace-js.
---

# Test Optimization Testing

When adding or modifying Test Optimization or test framework integration tests, validate each changed test with both
the current and v5 framework configurations before declaring the work complete.

- Before writing tests, check which framework versions the suite runs on v5 and reuse existing version-based skip
  conditions when applicable.
- For v5 validation, temporarily set only the root `package.json` version to `"5.0.0"`. Run each affected unit or
  integration test through its normal command with v5 frameworks (e.g. `MOCHA_VERSION=oldest` or `JEST_VERSION=oldest`).
  Where required, use the matching Node/framework combination from `.github/workflows/test-optimization.yml`.
  Confirm affected tests ran or had justified feature skips; incompatible-runtime or empty runs leave v5 unverified.
- Every changed test must pass or be explicitly skipped under v5; new functionality need not support older frameworks.
- For unavailable framework features, document the missing capability and minimum version and use conditional skips.
  Prefer framework-version gates; combine with `DD_MAJOR` from `version.js` when release-line behavior matters.
- Scope skips to unsupported cases. Do not blanket-skip v5, weaken assertions, or convert unexplained failures into
  skips. Verify the test still executes and passes on a supported framework version.
- Ensure unsupported imports, fixtures, or setup cannot fail before the skip takes effect.
- Restore the original `package.json` version even if validation fails, preserve other working changes, and never commit
  the temporary version.
- Report commands, Node/tracer/framework versions, results, and skip reasons. If validation cannot run, report the
  blocker and mark v5 compatibility as unverified.
