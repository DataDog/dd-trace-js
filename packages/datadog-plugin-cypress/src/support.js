'use strict'

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

// We need to grab the original window as soon as possible,
// in case the test changes the origin. If the test does change the origin,
// any call to `cy.window()` will result in a cross origin error.
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

function getRetriedTests (test, numRetries, tags) {
  const retriedTests = []
  for (let retryIndex = 0; retryIndex < numRetries; retryIndex++) {
    // TODO: signal in framework logs that this is a retry.
    // TODO: Change it so these tests are allowed to fail.
    const clonedTest = test.clone()
    tags.forEach(tag => {
      if (tag) {
        clonedTest[tag] = true
      }
    })
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
        isKnownTestsEnabled && isNewTest(test) && '_ddIsNew'
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

  cy.task('dd:beforeEach', {
    testName,
    testSuite: Cypress.mocha.getRootSuite().file
  }).then(({ traceId, shouldSkip }) => {
    Cypress.env('traceId', traceId)
    if (shouldSkip) {
      this.skip()
    }
  })
  cy.window().then(win => {
    originalWindow = win
  })
})

before(function () {
  cy.task('dd:testSuiteStart', {
    testSuite: Cypress.mocha.getRootSuite().file,
    testSuiteAbsolutePath: Cypress.spec && Cypress.spec.absolute
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
  const testInfo = {
    testName: currentTest.fullTitle(),
    testSuite: Cypress.mocha.getRootSuite().file,
    testSuiteAbsolutePath: Cypress.spec && Cypress.spec.absolute,
    state: currentTest.state,
    error: currentTest.err,
    isNew: currentTest._ddIsNew,
    isEfdRetry: currentTest._ddIsEfdRetry,
    isAttemptToFix: currentTest._ddIsAttemptToFix,
    isModified: currentTest._ddIsModified
  }
  try {
    testInfo.testSourceLine = Cypress.mocha.getRunner().currentRunnable.invocationDetails.line
  } catch {}

  if (safeGetRum(originalWindow)) {
    testInfo.isRUMActive = true
  }
  let coverage
  try {
    coverage = originalWindow.__coverage__
  } catch {
    // ignore error and continue
  }
  cy.task('dd:afterEach', { test: testInfo, coverage })
})
