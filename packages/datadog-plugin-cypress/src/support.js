/* eslint-disable */
beforeEach(() => {
  cy.wrap(new Promise(resolve => {
    cy.task('dd:beforeEach', {
      testName: Cypress.mocha.getRunner().suite.ctx.currentTest.fullTitle(),
      testSuite: Cypress.mocha.getRootSuite().file
    }).then(traceId => {
      Cypress.env('traceId', traceId)
      resolve()
    })
  }))
})

after(() => {
  cy.window().then(win => {
    win.dispatchEvent(new Event('beforeunload'))
  })
})


afterEach(() => {
  cy.wrap(new Promise(resolve => {
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
      }
      cy.task('dd:afterEach', testInfo).then(() => {
        resolve()
      })
    })
  }))
})
