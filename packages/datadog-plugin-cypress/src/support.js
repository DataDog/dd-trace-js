'use strict'

const DD_CIVISIBILITY_TEST_EXECUTION_ID_COOKIE_NAME = 'datadog-ci-visibility-test-execution-id'
let rumFlushWaitMillis = 500

let isEarlyFlakeDetectionEnabled = false
let isKnownTestsEnabled = false
let knownTestsForSuite = []
let earlyFlakeDetectionNumRetries = 0
let isTestManagementEnabled = false
let testManagementAttemptToFixRetries = 0
let testManagementTests = {}
let isImpactedTestsEnabled = false
let isModifiedTest = false
let isTestIsolationEnabled = false
// Array of test names that have been retried and the reason
const retryReasonsByTestName = new Map()
// Track quarantined test errors - we catch them in Cypress.on('fail') but need to report to Datadog
const quarantinedTestErrors = new Map()

// Track the most recently loaded window in the AUT. Updated via the 'window:load'
// event so we always get the real app window (after cy.visit()), not the
// about:blank window that exists when beforeEach runs. If the test later navigates
// to a cross-origin URL, safeGetRum() handles the access error.
let originalWindow

// If the test is using multi domain with cy.origin, trying to access
// window properties will result in a cross origin error.
function safeGetRum (window) {
  try {
    return window.DD_RUM
  } catch {
    return null
  }
}

function isNewTest (test) {
  // If for whatever reason the worker does not receive valid known tests, we don't consider it as new
  if (!Array.isArray(knownTestsForSuite)) {
    return false
  }
  return !knownTestsForSuite.includes(test.fullTitle())
}

function getTestProperties (testName) {
  // TODO: Use optional chaining when we drop support for older Cypress versions, which will happen when dd-trace@5 is
  // EoL. Until then, this files needs to support Node.js 16.
  const properties = testManagementTests[testName] && testManagementTests[testName].properties || {}

  const { attempt_to_fix: isAttemptToFix, disabled: isDisabled, quarantined: isQuarantined } = properties

  return { isAttemptToFix, isDisabled, isQuarantined }
}

// Catch test failures for quarantined tests and suppress them
// By not re-throwing the error, Cypress marks the test as passed
// This allows quarantined tests to run but not affect the exit code
Cypress.on('fail', (err, runnable) => {
  if (!isTestManagementEnabled) {
    throw err
  }

  const testName = runnable.fullTitle()
  const { isQuarantined, isAttemptToFix } = getTestProperties(testName)

  // For pure quarantined tests (not attemptToFix), suppress the failure
  // This makes the test "pass" from Cypress's perspective while we still track the error
  if (isQuarantined && !isAttemptToFix) {
    // Store the error so we can report it to Datadog in afterEach
    quarantinedTestErrors.set(testName, err)
    // Don't re-throw - this prevents Cypress from marking the test as failed
    return
  }

  // For all other tests (including attemptToFix), let the error propagate normally
  throw err
})

function getRetriedTests (test, numRetries, tags) {
  const retriedTests = []
  for (let retryIndex = 0; retryIndex < numRetries; retryIndex++) {
    // TODO: signal in framework logs that this is a retry.
    // TODO: Change it so these tests are allowed to fail.
    const clonedTest = test.clone()
    for (const tag of tags) {
      if (tag) {
        clonedTest[tag] = true
      }
    }
    retriedTests.push(clonedTest)
  }
  return retriedTests
}

const oldRunTests = Cypress.mocha.getRunner().runTests
Cypress.mocha.getRunner().runTests = function (suite, fn) {
  if (!isKnownTestsEnabled && !isTestManagementEnabled && !isImpactedTestsEnabled) {
    return oldRunTests.apply(this, arguments)
  }
  // We copy the tests array and add retries to it, then assign it back to suite.tests
  // to avoid modifying the array while iterating over it
  const testsWithRetries = []

  for (let testIndex = 0; testIndex < suite.tests.length; testIndex++) {
    const test = suite.tests[testIndex]
    const testName = test.fullTitle()
    const { isAttemptToFix } = getTestProperties(testName)
    const isSkipped = test.isPending()

    const isAtemptToFix = isTestManagementEnabled && isAttemptToFix && !isSkipped
    const isModified = isImpactedTestsEnabled && isModifiedTest
    const isNew = isKnownTestsEnabled && !isSkipped && isNewTest(test)

    // We want is_modified and is_new regardless of the retry reason
    if (isModified) {
      test._ddIsModified = true
    }
    if (isNew) {
      test._ddIsNew = true
    }

    // Add the original test first
    testsWithRetries.push(test)

    if (!isTestIsolationEnabled) {
      continue
    }

    // Then add retries right after it
    let retriedTests = []
    let retryMessage = ''
    if (isAtemptToFix) {
      test._ddIsAttemptToFix = true
      retryMessage = 'because it is an attempt to fix'
      retriedTests = getRetriedTests(test, testManagementAttemptToFixRetries, ['_ddIsAttemptToFix'])
    } else if (isModified && isEarlyFlakeDetectionEnabled) {
      retryMessage = 'to detect flakes because it is modified'
      retriedTests = getRetriedTests(test, earlyFlakeDetectionNumRetries, [
        '_ddIsModified',
        '_ddIsEfdRetry',
        isKnownTestsEnabled && isNewTest(test) && '_ddIsNew',
      ])
    } else if (isNew && isEarlyFlakeDetectionEnabled) {
      retryMessage = 'to detect flakes because it is new'
      retriedTests = getRetriedTests(test, earlyFlakeDetectionNumRetries, ['_ddIsNew', '_ddIsEfdRetry'])
    }

    testsWithRetries.push(...retriedTests)

    if (retryMessage) {
      retryReasonsByTestName.set(testName, retryMessage)
    }
  }

  suite.tests = testsWithRetries

  return oldRunTests.apply(this, [suite, fn])
}

beforeEach(function () {
  const testName = Cypress.mocha.getRunner().suite.ctx.currentTest.fullTitle()

  const retryMessage = retryReasonsByTestName.get(testName)
  if (retryMessage) {
    cy.task(
      'dd:log',
      `Retrying "${testName}" ${retryMessage}`
    )
    retryReasonsByTestName.delete(testName)
  }

  cy.on('window:load', (win) => {
    originalWindow = win
  })

  cy.task('dd:beforeEach', {
    testName,
    testSuite: Cypress.mocha.getRootSuite().file,
  }).then(({ traceId, shouldSkip }) => {
    if (traceId) {
      cy.setCookie(DD_CIVISIBILITY_TEST_EXECUTION_ID_COOKIE_NAME, traceId).then(() => {
        // When testIsolation:false, the page is not reset between tests, so the RUM session
        // stopped in afterEach must be explicitly restarted so events in this test are
        // associated with the new testExecutionId.
        //
        // After stopSession(), the RUM SDK creates a new session upon a user interaction
        // (click, scroll, keydown, or touchstart). We dispatch a synthetic click on the window
        // to trigger session renewal, then call startView() to establish a view boundary.
        if (!isTestIsolationEnabled && originalWindow) {
          const rum = safeGetRum(originalWindow)
          if (rum) {
            try {
              const evt = new originalWindow.MouseEvent('click', { bubbles: true, cancelable: true })
              // The browser-sdk addEventListener wrapper filters out untrusted synthetic events
              // unless __ddIsTrusted is set. Set it so the click triggers expandOrRenewSession().
              // See: https://github.com/DataDog/browser-sdk/blob/v6.27.1/packages/core/src/browser/addEventListener.ts#L119
              Object.defineProperty(evt, '__ddIsTrusted', { value: true })
              originalWindow.dispatchEvent(evt)
            } catch {}
            if (rum.startView) {
              rum.startView()
            }
          }
        }
      })
    }
    if (shouldSkip) {
      this.skip()
    }
  })
})

before(function () {
  cy.task('dd:testSuiteStart', {
    testSuite: Cypress.mocha.getRootSuite().file,
    testSuiteAbsolutePath: Cypress.spec && Cypress.spec.absolute,
  }).then((suiteConfig) => {
    if (suiteConfig) {
      isEarlyFlakeDetectionEnabled = suiteConfig.isEarlyFlakeDetectionEnabled
      isKnownTestsEnabled = suiteConfig.isKnownTestsEnabled
      knownTestsForSuite = suiteConfig.knownTestsForSuite
      earlyFlakeDetectionNumRetries = suiteConfig.earlyFlakeDetectionNumRetries
      isTestManagementEnabled = suiteConfig.isTestManagementEnabled
      testManagementAttemptToFixRetries = suiteConfig.testManagementAttemptToFixRetries
      testManagementTests = suiteConfig.testManagementTests
      isImpactedTestsEnabled = suiteConfig.isImpactedTestsEnabled
      isModifiedTest = suiteConfig.isModifiedTest
      isTestIsolationEnabled = suiteConfig.isTestIsolationEnabled
      if (Number.isFinite(suiteConfig.rumFlushWaitMillis)) {
        rumFlushWaitMillis = suiteConfig.rumFlushWaitMillis
      }
    }
  })
})

after(() => {
  try {
    if (safeGetRum(originalWindow)) {
      originalWindow.dispatchEvent(new Event('beforeunload'))
    }
  } catch {
    // ignore error. It's usually a multi origin issue.
  }
})

afterEach(function () {
  const currentTest = Cypress.mocha.getRunner().suite.ctx.currentTest
  const testName = currentTest.fullTitle()

  // Check if this was a quarantined test that we suppressed the failure for
  const quarantinedError = quarantinedTestErrors.get(testName)
  const isQuarantinedTestThatFailed = !!quarantinedError

  // For quarantined tests, convert Error to a serializable format for cy.task
  const errorToReport = isQuarantinedTestThatFailed
    ? { message: quarantinedError.message, stack: quarantinedError.stack }
    : currentTest.err

  const testInfo = {
    testName,
    testSuite: Cypress.mocha.getRootSuite().file,
    testSuiteAbsolutePath: Cypress.spec && Cypress.spec.absolute,
    // For quarantined tests, report the actual state (failed) to Datadog, not what Cypress thinks (passed)
    state: isQuarantinedTestThatFailed ? 'failed' : currentTest.state,
    // For quarantined tests, include the actual error that was suppressed
    error: errorToReport,
    isNew: currentTest._ddIsNew,
    isEfdRetry: currentTest._ddIsEfdRetry,
    isAttemptToFix: currentTest._ddIsAttemptToFix,
    isModified: currentTest._ddIsModified,
    // Mark quarantined tests that failed so the plugin knows to tag them appropriately
    isQuarantined: isQuarantinedTestThatFailed,
  }
  try {
    testInfo.testSourceLine = Cypress.mocha.getRunner().currentRunnable.invocationDetails.line
  } catch {}

  const rum = safeGetRum(originalWindow)
  if (rum) {
    testInfo.isRUMActive = true
    if (rum.stopSession) {
      rum.stopSession()
      // eslint-disable-next-line cypress/no-unnecessary-waiting
      cy.wait(rumFlushWaitMillis)
    }
  }
  let coverage
  try {
    coverage = originalWindow.__coverage__
  } catch {
    // ignore error and continue
  }

  // Clean up the quarantined error tracking
  if (isQuarantinedTestThatFailed) {
    quarantinedTestErrors.delete(testName)
  }

  cy.task('dd:afterEach', { test: testInfo, coverage })
})
