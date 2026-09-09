'use strict'

/* global Cypress, cy */
const useExpose = Number(Cypress.version.split('.')[0]) >= 16

/**
 * @param {string} name Environment variable name
 * @returns {unknown} Environment variable value
 */
function getTestEnvironment (name) {
  return useExpose ? Cypress.expose(name) : Cypress.env(name)
}

/**
 * @param {string} name Environment variable name
 * @param {unknown} value Environment variable value
 */
function setTestEnvironment (name, value) {
  if (useExpose) {
    Cypress.expose(name, value)
  } else {
    Cypress.env(name, value)
  }
}

if (getTestEnvironment('ENABLE_INCOMPATIBLE_PLUGIN')) {
  require('cypress-fail-fast')
}
if (getTestEnvironment('RUM_COOKIE_FAILURE') || getTestEnvironment('RUM_COOKIE_STALE_TEST')) {
  const automation = Cypress.automation.bind(Cypress)
  /**
   * @param {string} event
   * @param {{ name?: string, value?: string }} options
   */
  Cypress.automation = function (event, options) {
    if (event === 'set:cookie' &&
        options.name === 'datadog-ci-visibility-test-execution-id' &&
        options.value &&
        getTestEnvironment('RUM_COOKIE_FAILURE')) {
      setTestEnvironment('DD_RUM_COOKIE_ATTEMPTED', true)
      if (getTestEnvironment('RUM_COOKIE_FAILURE') === 'throw') {
        throw new Error('RUM correlation cookie threw')
      }
      return Cypress.Promise.reject(new Error('RUM correlation cookie rejected'))
    }
    return automation(event, options)
  }
}
if (getTestEnvironment('MISSING_CY_NOW')) {
  cy.now = undefined
  setTestEnvironment('DD_RUM_COOKIE_NOW_MISSING', true)
}
if (getTestEnvironment('RUM_LOG_FAILURE')) {
  const log = Cypress.log.bind(Cypress)
  /**
   * @param {{ name?: string }} options
   */
  Cypress.log = (options) => {
    if (options.name === 'dd-trace') {
      throw new Error('RUM correlation error logging threw')
    }
    return log(options)
  }
}
require('dd-trace/ci/cypress/support')
