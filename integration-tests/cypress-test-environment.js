'use strict'

const { version } = require('cypress/package.json')

const exposedEnvironmentVariables = [
  'BASE_URL_SECOND',
  'ENABLE_INCOMPATIBLE_PLUGIN',
  'EXPECTED_ATTEMPT',
  'FLAKY_PASS_ATTEMPT',
  'MISSING_CY_NOW',
  'RUM_COOKIE_FAILURE',
  'RUM_COOKIE_STALE_TEST',
  'RUM_LOG_FAILURE',
  'SHOULD_ALWAYS_PASS',
  'SHOULD_FAIL_SOMETIMES',
]

const useExpose = Number(version.split('.')[0]) >= 16

/**
 * @param {Record<string, unknown>} [additionalValues] Additional public test values
 * @returns {{ env: Record<string, unknown> }|{ expose: Record<string, unknown> }} Cypress configuration
 */
module.exports = function getCypressTestEnvironment (additionalValues = {}) {
  const values = { ...additionalValues }

  for (const name of exposedEnvironmentVariables) {
    const value = process.env[`CYPRESS_${name}`]
    if (value !== undefined) {
      values[name] = value
    }
  }

  return useExpose ? { expose: values } : { env: values }
}
