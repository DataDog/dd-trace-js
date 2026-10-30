'use strict'

/* global Cypress, cy */

const { noAutoRetry } = require('dd-trace/test-optimization')
const { getTestEnvironment } = require('../support/test-environment')
const mode = getTestEnvironment('EXCLUSIONS_MODE')
const modes = [
  'descriptor-root', 'raw-after', 'raw-before', 'raw-saved', 'raw-detached',
  'locked-root', 'locked-root-reset', 'locked-root-unchanged',
]
if (!modes.includes(mode)) throw new Error(`unknown raw retry mode: ${mode}`)
const executions = {}

if (mode === 'descriptor-root') {
  Object.getOwnPropertyDescriptor(Cypress.config(), 'retries').value.runMode = 3
} else if (mode.startsWith('locked-root')) {
  Object.defineProperty(Cypress.config(), 'retries', { writable: false, configurable: false })
  if (mode !== 'locked-root-unchanged') Cypress.config().retries.runMode = 3
  if (mode === 'locked-root-reset') {
    try { Cypress.config('retries', 0) } catch (error) {
      if (!(error instanceof TypeError)) throw error
    }
    if (Cypress.config().retries.runMode !== 3) throw new Error('native locked root was replaced')
  }
} else {
  const raw = { runMode: mode === 'raw-detached' ? 3 : 1, openMode: 0 }
  Cypress.config('retries', raw)
  const observed = Cypress.config('retries')
  if (mode === 'raw-before') raw.runMode = 3
  observed.openMode = 1
  if (['raw-saved', 'raw-detached'].includes(mode)) Cypress.config('retries', 0)
  if (mode === 'raw-detached') observed.runMode = 1
  if (mode !== 'raw-before') raw.runMode = 3
  if (['raw-saved', 'raw-detached'].includes(mode)) Cypress.config('retries', observed)
}

/**
 * @param {string} name
 * @param {number} passAt
 */
function attempt (name, passAt) {
  executions[name] = (executions[name] || 0) + 1
  return cy.writeFile('browser-raw-retry-executions.json', executions, { log: false }).then(() => {
    if (executions[name] < passAt) throw new Error(`raw retry boundary: ${name}`)
  })
}

describe('raw retry boundaries', () => {
  it('excluded recovery', noAutoRetry(() => attempt('excluded recovery', 3)))
  it('excluded persistent', noAutoRetry(() => attempt('excluded persistent', Infinity)))
  it('ordinary control', () => attempt('ordinary control', 3))
})
