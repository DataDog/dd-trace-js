function getTestsInFile (mochaSuite) {
  const tests = []

  function getTestsInSuite (suite) {
    suite.tests.forEach(test => {
      tests.push(test)
    })
    suite.suites.forEach(suite => {
      getTestsInSuite(suite)
    })
  }
  getTestsInSuite(mochaSuite)

  return tests
}

/* eslint-disable */
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

before(() => {
  cy.task('dd:testSuiteStart', Cypress.mocha.getRootSuite().file)
})

after(() => {
  const tests = getTestsInFile(Cypress.mocha._mocha.suite).map(test => ({
    name: test.fullTitle(),
    err: test.err,
    state: test.state,
    suite: test.invocationDetails.relativeFile
  }))
  debugger
  cy.task('dd:testSuiteFinish', { stats: Cypress.mocha.getRunner().stats, tests })
  cy.window().then(win => {
    win.dispatchEvent(new Event('beforeunload'))
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
