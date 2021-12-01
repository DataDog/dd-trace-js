/* eslint-disable */
beforeEach(() => {
  const testName = Cypress.mocha.getRunner().suite.ctx.currentTest.fullTitle()
  const testSuite = Cypress.mocha.getRootSuite().file
  cy.task('dd:beforeEach', {
    testName,
    testSuite
  }).then(traceId => {
    Cypress.env('traceId', traceId)
  })
})

after(() => {
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
    if (win.DD_RUM) {
      testInfo.isRUMActive = true
      // TODO: if (win.DD_RUM.isBrownSessionActive()) testInfo.isSessionReplayActive = true
    }
    cy.task('dd:afterEach', testInfo)
  })
})
