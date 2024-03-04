/* eslint-disable */
let isEarlyFlakeDetectionEnabled = false
let knownTestsForSuite = []
let suiteTests = []
const NUM_RETRIES = 3 // TODO: get value from backend

function isNewTest (test) {
  return !knownTestsForSuite.includes(test.fullTitle())
}

function retryTest (test, earlyFlakeDetectionNumRetries = 3, suiteTests) {
  for (let retryIndex = 0; retryIndex < earlyFlakeDetectionNumRetries; retryIndex++) {
    const clonedTest = test.clone()
    // TODO: signal in framework logs that this is a retry
    suiteTests.unshift(clonedTest)
    clonedTest._ddIsNew = true
    clonedTest._ddIsEfdRetry = true
    // TODO: Change it so these tests are allowed to fail.
  }
}


const oldRunTests = Cypress.mocha.getRunner().runTests
Cypress.mocha.getRunner().runTests = function (suite, fn) {
  if (!isEarlyFlakeDetectionEnabled) {
    return oldRunTests.apply(this, arguments)
  }
  suite.tests.forEach(test => {
    if (!test._ddIsNew && !test.isPending() && isNewTest(test)) {
      test._ddIsNew = true
      retryTest(test, NUM_RETRIES, suite.tests)
    }
  })

  return oldRunTests.apply(this, [suite, fn])
}

beforeEach(function () {
  cy.task('dd:beforeEach', {
    testName: Cypress.mocha.getRunner().suite.ctx.currentTest.fullTitle(),
    testSuite: Cypress.mocha.getRootSuite().file
  }).then(({ traceId, shouldSkip }) => {
    debugger
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
    }
  })
})

after(() => {
  cy.window().then(win => {
    if (win.DD_RUM) {
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

    if (win.DD_RUM) {
      testInfo.isRUMActive = true
    }
    cy.task('dd:afterEach', { test: testInfo, coverage: win.__coverage__ })
  })
})
