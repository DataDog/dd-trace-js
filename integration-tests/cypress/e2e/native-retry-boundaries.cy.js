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
let savedLocalRetries
if (['browser-numeric-open', 'browser-all-numeric-open'].includes(mode)) {
  const state = mode === 'browser-all-numeric-open' ? Cypress.config() : null
  let retries = state ? state.retries : Cypress.config('retries')
  if (typeof retries === 'number') {
    retries = { runMode: retries, openMode: retries }
    if (state) state.retries = retries
    else Cypress.config('retries', retries)
  }
  retries.openMode = 1
}
if (mode === 'browser-descriptor') {
  Object.defineProperty(Cypress.config('retries'), 'runMode', { value: 3 })
}
if (mode === 'browser-all-descriptor-root') {
  Object.defineProperty(Cypress.config(), 'retries', { value: { runMode: 3, openMode: 0 } })
}
if (mode === 'browser-all-descriptor-same') {
  const state = Cypress.config()
  const retries = state.retries
  Object.defineProperty(state, 'retries', { value: retries })
  retries.openMode = 1
}
if (['experimental-native-same-options', 'experimental-native-locked-options',
  'experimental-native-assigned-options'].includes(mode)) {
  const retries = Cypress.config('retries')
  const saved = retries.experimentalOptions
  if (mode === 'experimental-native-assigned-options') retries.experimentalOptions = saved
  else {
    const locked = mode === 'experimental-native-locked-options'
    Object.defineProperty(retries, 'experimentalOptions', { value: saved, writable: !locked, configurable: !locked })
  }
}
if (mode === 'experimental-native-checkpoint') {
  const retries = Cypress.config('retries')
  const proxied = retries.experimentalOptions
  const raw = Object.getOwnPropertyDescriptor(retries, 'experimentalOptions').value
  raw.maxRetries = 3
  retries.experimentalOptions = proxied
  raw.maxRetries = 4
}
if (mode === 'experimental-native-locked-detached') {
  const retries = Cypress.config('retries')
  Object.defineProperty(retries, 'experimentalOptions', { writable: false, configurable: false })
  retries.experimentalOptions.maxRetries = 3
}
if (mode.startsWith('experimental-native-detached')) {
  const retries = Cypress.config('retries')
  const saved = retries.experimentalOptions
  retries.experimentalOptions = { maxRetries: 3, stopIfAnyPassed: false }
  if (mode.endsWith('-delete')) delete saved.maxRetries
  else saved.maxRetries = 8
}
if (mode === 'browser-all-equal') {
  const state = Cypress.config()
  const retries = state.retries
  state.retries = retries
  retries.runMode = 2
}
if (mode === 'browser-all-root') Cypress.config().retries = { runMode: 2, openMode: 0 }
if (mode === 'browser-all-inactive') Cypress.config().retries.openMode = 1
if (mode === 'browser-saved-reference') {
  const saved = Cypress.config('retries')
  Cypress.config('retries', 1)
  Cypress.config('retries', saved)
}
if (mode === 'browser-same-reference') {
  const retries = Cypress.config('retries')
  retries.openMode = 1
  Cypress.config({ retries })
}
if (mode.startsWith('browser-all-')) {
  const state = Cypress.config()
  if (state !== Cypress.config()) throw new Error('native config state identity changed')
}
if (mode === 'browser-delete-mode') delete Cypress.config('retries').runMode
if (mode === 'browser-partial-root') Cypress.config('retries', { openMode: 1 })
if (mode === 'browser-inactive-mode') Cypress.config('retries').openMode = 1
if (['browser-retries', 'browser-same-budget', 'browser-runtime-global'].includes(mode)) Cypress.config('retries', 2)

const suiteConfig = ['inherited-mode', 'browser-runtime-suite'].includes(mode) ? { retries: { runMode: 2 } } : {}
describe('native retry boundaries', suiteConfig, () => {
  if (['browser-saved-local', 'browser-all-saved-local'].includes(mode)) {
    it('initial local control', { retries: 0 }, () => attempt('initial local control', 1))
    it('captures local retries', { retries: { runMode: 2, openMode: 0 } }, () => {
      savedLocalRetries = mode === 'browser-all-saved-local' ? Cypress.config().retries : Cypress.config('retries')
      return attempt('captures local retries', 1)
    })
    it('restores local retries', () => {
      Cypress.config('retries', savedLocalRetries)
      return attempt('restores local retries', 1)
    })
  }
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
