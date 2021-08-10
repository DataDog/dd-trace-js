/* eslint-disable */
const {startFetchProxy, resetFetchProxy} = require('@datadog/browser-core')

Cypress.on('window:before:load', win => {
    const httpRequests = {}
    const fetchProxy = startFetchProxy(win)
    fetchProxy.onRequestComplete((request) => {
        httpRequests[request.startClocks.timeStamp] = request
        Cypress.mocha.getRunner().test.httpRequests = Object.values(httpRequests)
    })
})
Cypress.on('window:before:unload', () => {
    resetFetchProxy()
})

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
    error: currentTest.err,
    httpRequests: currentTest.httpRequests
  })
})
