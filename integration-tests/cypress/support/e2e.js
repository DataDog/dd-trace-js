'use strict'

/* global Cypress, cy */
if (Cypress.env('ENABLE_INCOMPATIBLE_PLUGIN')) {
  require('cypress-fail-fast')
}
if (Cypress.env('RUM_COOKIE_FAILURE') || Cypress.env('RUM_COOKIE_STALE_TEST')) {
  const automation = Cypress.automation.bind(Cypress)
  /**
   * @param {string} event
   * @param {{ name?: string, value?: string }} options
   */
  Cypress.automation = function (event, options) {
    if (event === 'set:cookie' &&
        options.name === 'datadog-ci-visibility-test-execution-id' &&
        options.value &&
        Cypress.env('RUM_COOKIE_FAILURE')) {
      Cypress.env('DD_RUM_COOKIE_ATTEMPTED', true)
      if (Cypress.env('RUM_COOKIE_FAILURE') === 'throw') {
        throw new Error('RUM correlation cookie threw')
      }
      return Cypress.Promise.reject(new Error('RUM correlation cookie rejected'))
    }
    return automation(event, options)
  }
}
if (Cypress.env('MISSING_CY_NOW')) {
  cy.now = undefined
  Cypress.env('DD_RUM_COOKIE_NOW_MISSING', true)
}
require('dd-trace/ci/cypress/support')
