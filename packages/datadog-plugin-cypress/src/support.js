/* eslint-disable */
beforeEach(() => {
  cy.task('dd:beforeEach', {
    testName: Cypress.mocha.getRunner().suite.ctx.currentTest.fullTitle(),
    testSuite: Cypress.mocha.getRootSuite().file
  }).then(traceId => {
    Cypress.env('traceId', traceId)
  })
})

before(() => {
  cy.task('dd:testSuiteStart', Cypress.mocha.getRootSuite().file)
})

after(() => {
  cy.window().then(win => {
    cy.task('dd:testSuiteFinish', { stats: Cypress.mocha.getRunner().stats, coverage: win.__coverage__ })
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
    cy.task('dd:afterEach', testInfo)
  })
})
