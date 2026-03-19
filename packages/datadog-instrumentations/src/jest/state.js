'use strict'

// Primitives accessed via state.xxx (CommonJS `let` rebinding doesn't propagate across modules)
const state = {
  skippableSuites: [],
  knownTests: {},
  isCodeCoverageEnabled: false,
  isCodeCoverageEnabledBecauseOfUs: false,
  isSuitesSkippingEnabled: false,
  isKeepingCoverageConfiguration: false,
  isUserCodeCoverageEnabled: false,
  isSuitesSkipped: false,
  numSkippedSuites: 0,
  hasUnskippableSuites: false,
  hasForcedToRunSuites: false,
  isEarlyFlakeDetectionEnabled: false,
  earlyFlakeDetectionNumRetries: 0,
  earlyFlakeDetectionSlowTestRetries: {},
  earlyFlakeDetectionFaultyThreshold: 30,
  isEarlyFlakeDetectionFaulty: false,
  hasFilteredSkippableSuites: false,
  isKnownTestsEnabled: false,
  isTestManagementTestsEnabled: false,
  testManagementTests: {},
  testManagementAttemptToFixRetries: 0,
  isImpactedTestsEnabled: false,
  modifiedFiles: {},
}

// Collections (mutated in place, safe to export directly)
const testContexts = new WeakMap()
const originalTestFns = new WeakMap()
const originalHookFns = new WeakMap()
const retriedTestsToNumAttempts = new Map()
const newTestsTestStatuses = new Map()
const attemptToFixRetriedTestsStatuses = new Map()
const wrappedWorkers = new WeakSet()
const testSuiteMockedFiles = new Map()
const testsToBeRetried = new Set()
// Per-test: how many EFD retries were determined after the first execution.
const efdDeterminedRetries = new Map()
// Tests whose first run exceeded the 5-min threshold — tagged "slow".
const efdSlowAbortedTests = new Set()
// Tests added as EFD new-test candidates (not ATF, not impacted).
const efdNewTestCandidates = new Set()
const testSuiteAbsolutePathsWithFastCheck = new Set()
const testSuiteJestObjects = new Map()
const atrSuppressedErrors = new Map()

module.exports = {
  state,
  testContexts,
  originalTestFns,
  originalHookFns,
  retriedTestsToNumAttempts,
  newTestsTestStatuses,
  attemptToFixRetriedTestsStatuses,
  wrappedWorkers,
  testSuiteMockedFiles,
  testsToBeRetried,
  efdDeterminedRetries,
  efdSlowAbortedTests,
  efdNewTestCandidates,
  testSuiteAbsolutePathsWithFastCheck,
  testSuiteJestObjects,
  atrSuppressedErrors,
}
