'use strict'

/* global Cypress */
if (Cypress.env('ENABLE_INCOMPATIBLE_PLUGIN')) {
  require('cypress-fail-fast')
}
if (Cypress.env('REJECT_DD_RUM_COOKIE')) {
  const automation = Cypress.automation.bind(Cypress)
  /**
   * @param {string} event
   * @param {{ name?: string }} options
   */
  Cypress.automation = function (event, options) {
    if (event === 'set:cookie' && options.name === 'datadog-ci-visibility-test-execution-id') {
      Cypress.env('DD_RUM_COOKIE_ATTEMPTED', true)
      return Cypress.Promise.reject(new Error('RUM correlation cookie rejected'))
    }
    return automation(event, options)
  }
}
require('dd-trace/ci/cypress/support')
