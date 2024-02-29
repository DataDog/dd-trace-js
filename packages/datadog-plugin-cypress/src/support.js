/* eslint-disable */
const EFD_STRING = "Retried by Datadog's Early Flake Detection"

let isEarlyFlakeDetectionEnabled = false
let knownTestsForSuite = []

debugger
function addEfdStringToTestName (testName, numAttempt) {
  return `${EFD_STRING} (#${numAttempt}): ${testName}`
}

function retryTest (test, earlyFlakeDetectionNumRetries = 3) {
  const originalTestName = test.title
  const suite = test.parent
  for (let retryIndex = 0; retryIndex < earlyFlakeDetectionNumRetries; retryIndex++) {
    const clonedTest = test.clone()
    clonedTest.title = addEfdStringToTestName(originalTestName, retryIndex + 1)
    suite.addTest(clonedTest)
    clonedTest._ddIsNew = true
    clonedTest._ddIsEfdRetry = true
  }
}

function isNewTest (test) {
  return !knownTestsForSuite.includes(test.fullTitle())
}
// const oldIt = window.it

debugger
const oldRunTests = Cypress.mocha.getRunner().runTests

Cypress.mocha.getRunner().runTests = function (suite) {
  if (!isEarlyFlakeDetectionEnabled) {
    return oldRunTests.apply(this, arguments)
  }
  suite.tests.forEach(test => {
    debugger
    if (!test._ddIsNew && !test.isPending() && isNewTest(test)) {
      test._ddIsNew = true
      retryTest(test)
    }
  })
  return oldRunTests.apply(this, arguments)
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
    debugger
    isEarlyFlakeDetectionEnabled = suiteConfig.isEarlyFlakeDetectionEnabled
    knownTestsForSuite = suiteConfig.knownTestsForSuite
  })
})

after(() => {
  cy.window().then(win => {
    if (win.DD_RUM) {
      win.dispatchEvent(new Event('beforeunload'))
    }
  })
})


afterEach(() => {
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
