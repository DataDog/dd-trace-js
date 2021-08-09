/* eslint-disable */
beforeEach(() => {
  cy.task('beforeEach', {
    testName: Cypress.mocha.getRunner().suite.ctx.currentTest.fullTitle(),
    testSuite: Cypress.mocha.getRootSuite().file
  })
})

afterEach(() => {
  const currentTest = Cypress.mocha.getRunner().suite.ctx.currentTest
  cy.task('afterEach', {
    testName: currentTest.fullTitle(),
    testSuite: Cypress.mocha.getRootSuite().file,
    state: currentTest.state,
    error: currentTest.err
  })
})
