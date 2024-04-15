/* eslint-disable */
let isEarlyFlakeDetectionEnabled = false
let knownTestsForSuite = []
let suiteTests = []
let earlyFlakeDetectionNumRetries = 0

// If the test is using multi domain with cy.origin, trying to access
// window properties will result in a cross origin error.
function safeGetRum (window) {
  try {
    return window.DD_RUM
  } catch (e) {
    return null
  }
}

function isNewTest (test) {
  return !knownTestsForSuite.includes(test.fullTitle())
}

function retryTest (test, suiteTests) {
  for (let retryIndex = 0; retryIndex < earlyFlakeDetectionNumRetries; retryIndex++) {
    const clonedTest = test.clone()
    // TODO: signal in framework logs that this is a retry.
    // TODO: Change it so these tests are allowed to fail.
    // TODO: figure out if reported duration is skewed.
    suiteTests.unshift(clonedTest)
    clonedTest._ddIsNew = true
    clonedTest._ddIsEfdRetry = true
  }
}


const oldRunTests = Cypress.mocha.getRunner().runTests
Cypress.mocha.getRunner().runTests = function (suite, fn) {
  if (!isEarlyFlakeDetectionEnabled) {
    return oldRunTests.apply(this, arguments)
  }
  // We copy the new tests at the beginning of the suite run (runTests), so that they're run
  // multiple times.
  suite.tests.forEach(test => {
    if (!test._ddIsNew && !test.isPending() && isNewTest(test)) {
      test._ddIsNew = true
      retryTest(test, suite.tests)
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
})

before(function () {
  cy.task('dd:testSuiteStart', Cypress.mocha.getRootSuite().file).then((suiteConfig) => {
    if (suiteConfig) {
      isEarlyFlakeDetectionEnabled = suiteConfig.isEarlyFlakeDetectionEnabled
      knownTestsForSuite = suiteConfig.knownTestsForSuite
      earlyFlakeDetectionNumRetries = suiteConfig.earlyFlakeDetectionNumRetries
    }
  })
})

after(() => {
  cy.window().then(win => {
    if (safeGetRum(win)) {
      win.dispatchEvent(new Event('beforeunload'))
    }
  })
})


afterEach(function () {
  cy.window().then(win => {
    const currentTest = Cypress.mocha.getRunner().suite.ctx.currentTest
    const testInfo = {
      testName: currentTest.fullTitle(),
      testSuite: Cypress.mocha.getRootSuite().file,
      state: currentTest.state,
      error: currentTest.err,
      isNew: currentTest._ddIsNew,
      isEfdRetry: currentTest._ddIsEfdRetry
    }
    try {
      testInfo.testSourceLine = Cypress.mocha.getRunner().currentRunnable.invocationDetails.line
    } catch (e) {}

    if (safeGetRum(win)) {
      testInfo.isRUMActive = true
    }
    let coverage
    try {
      coverage = win.__coverage__
    } catch (e) {
      // ignore error and continue
    }
    cy.task('dd:afterEach', { test: testInfo, coverage })
  })
})
