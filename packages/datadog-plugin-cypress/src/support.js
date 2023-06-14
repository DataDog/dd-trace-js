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
