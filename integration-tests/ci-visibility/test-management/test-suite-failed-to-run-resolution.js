'use strict'

// Intentionally cause "Test suite failed to run" - module resolution error so no tests run.
// Used to verify we do NOT flip exit code to 0 when quarantine/EFD would otherwise
// ignore failures, because suite-level failures cannot be ignored.
require('./this-module-does-not-exist-xyz')

describe('suite failed to run', () => {
  it('will not run', () => {})
})
