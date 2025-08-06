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
  return !knownTestsForSuite.includes(test.fullTitle())
}

function getTestProperties (testName) {
  // TODO: Use optional chaining when we drop support for older Cypress versions, which will happen when dd-trace@5 is
  // EoL. Until then, this files needs to support Node.js 16.
  const properties = testManagementTests[testName] && testManagementTests[testName].properties || {}

  const { attempt_to_fix: isAttemptToFix, disabled: isDisabled, quarantined: isQuarantined } = properties

  return { isAttemptToFix, isDisabled, isQuarantined }
}

function retryTest (test, suiteTests, numRetries, tags) {
  for (let retryIndex = 0; retryIndex < numRetries; retryIndex++) {
    const clonedTest = test.clone()
    // TODO: signal in framework logs that this is a retry.
    // TODO: Change it so these tests are allowed to fail.
    // TODO: figure out if reported duration is skewed.
    suiteTests.unshift(clonedTest)
    tags.forEach(tag => {
      clonedTest[tag] = true
    })
  }
}

const oldRunTests = Cypress.mocha.getRunner().runTests
Cypress.mocha.getRunner().runTests = function (suite, fn) {
  if (!isKnownTestsEnabled && !isTestManagementEnabled && !isImpactedTestsEnabled) {
    return oldRunTests.apply(this, arguments)
  }
  // We copy the new tests at the beginning of the suite run (runTests), so that they're run
  // multiple times.
  suite.tests.forEach(test => {
    const testName = test.fullTitle()

    const { isAttemptToFix } = getTestProperties(testName)

    if (isTestManagementEnabled && isAttemptToFix && !test.isPending()) {
      test._ddIsAttemptToFix = true
      retryTest(test, suite.tests, testManagementAttemptToFixRetries, ['_ddIsAttemptToFix'])
    }
    if (isImpactedTestsEnabled && isModifiedTest) {
      test._ddIsModified = true
      if (isEarlyFlakeDetectionEnabled && !isAttemptToFix) {
        retryTest(
          test,
          suite.tests,
          earlyFlakeDetectionNumRetries,
          ['_ddIsModified', '_ddIsEfdRetry', isKnownTestsEnabled && isNewTest(test) && '_ddIsNew']
        )
      }
    }
    if (isKnownTestsEnabled && !test._ddIsNew && !test.isPending() && isNewTest(test)) {
      test._ddIsNew = true
      if (isImpactedTestsEnabled && isModifiedTest) {
        test._ddIsModified = true
      }
      if (isEarlyFlakeDetectionEnabled && !isAttemptToFix && !isModifiedTest) {
        retryTest(test, suite.tests, earlyFlakeDetectionNumRetries, ['_ddIsNew', '_ddIsEfdRetry'])
      }
    }
  })

  return oldRunTests.apply(this, [suite, fn])
}

beforeEach(function () {
  cy.task('dd:beforeEach', {
    testName: Cypress.mocha.getRunner().suite.ctx.currentTest.fullTitle(),
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
