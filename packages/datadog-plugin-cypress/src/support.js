/* eslint-disable */
beforeEach(() => {
  cy.task('dd:beforeEach', {
    testName: Cypress.mocha.getRunner().suite.ctx.currentTest.fullTitle(),
    testSuite: Cypress.mocha.getRootSuite().file
  })
})

afterEach(() => {
  const currentTest = Cypress.mocha.getRunner().suite.ctx.currentTest
  cy.task('dd:afterEach', {
    state: currentTest.state,
    error: currentTest.err
  })
})
