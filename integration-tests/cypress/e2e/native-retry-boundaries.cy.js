'use strict'

/* global Cypress, cy */

const { noAutoRetry } = require('dd-trace/test-optimization')
const { getTestEnvironment } = require('../support/test-environment')

const executions = {}

/**
 * @param {string} name
 * @param {number} passAt
 */
function attempt (name, passAt) {
  executions[name] = (executions[name] || 0) + 1
  return cy.writeFile('native-retry-executions.json', executions, { log: false }).then(() => {
    if (executions[name] < passAt) throw new Error(`native retry boundary: ${name}`)
  })
}

const mode = getTestEnvironment('EXCLUSIONS_MODE')
if (['browser-retries', 'browser-same-budget', 'browser-runtime-global'].includes(mode)) Cypress.config('retries', 2)

const suiteConfig = ['inherited-mode', 'browser-runtime-suite'].includes(mode) ? { retries: { runMode: 2 } } : {}
describe('native retry boundaries', suiteConfig, () => {
  if (mode.startsWith('browser-runtime')) {
    const localConfig = ['browser-runtime-persistent', 'browser-runtime-suite'].includes(mode) ? {} : { retries: 1 }
    it('changes runtime retries', localConfig, () => {
      Cypress.config('retries', ['browser-runtime-global', 'browser-runtime-suite'].includes(mode) ? 3 : 2)
      return attempt('changes runtime retries', 1)
    })
  }
  const partial = mode === 'inherited-mode' ? { retries: { openMode: 1 } } : {}
  it('excluded recovery', partial, noAutoRetry(() => attempt('excluded recovery', 3)))
  it('excluded persistent', partial, noAutoRetry(() => attempt('excluded persistent', Infinity)))
  it('excluded explicit zero', { retries: 0 }, noAutoRetry(() => attempt('excluded explicit zero', Infinity)))
  if (['browser-runtime-global', 'browser-runtime-persistent', 'browser-runtime-suite'].includes(mode)) {
    it('excluded after zero', noAutoRetry(() => attempt('excluded after zero', 3)))
  }
  it('ordinary control', () => attempt('ordinary control', 3))
})
