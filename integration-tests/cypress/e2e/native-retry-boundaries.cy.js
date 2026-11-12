'use strict'

/* global Cypress, cy */

const { noAutoRetry } = require('dd-trace/ci/test-annotations')
const { getTestEnvironment } = require('../support/test-environment')

const mode = getTestEnvironment('EXCLUSIONS_MODE')
const fieldAccessor = mode !== 'browser-saved-local'
const executions = {}
let retryAccessorReads = 0
let excludedAccessorReads = 0
let savedLocalRetries

/**
 * @param {string} name
 * @param {number} passAt
 */
function attempt (name, passAt) {
  executions[name] = (executions[name] || 0) + 1
  if (fieldAccessor) {
    if (name.startsWith('excluded')) excludedAccessorReads = retryAccessorReads
    cy.writeFile('native-retry-accessor-reads.json', {
      reads: retryAccessorReads, excludedReads: excludedAccessorReads,
    })
  }
  return cy.writeFile('native-retry-executions.json', executions, { log: false }).then(() => {
    if (executions[name] < passAt) throw new Error(`native retry boundary: ${name}`)
  })
}

// Match the SDK's two test hooks when comparing native accessor read counts.
if (getTestEnvironment('MATCHED_NATIVE_HOOKS')) {
  beforeEach(() => {})
  afterEach(() => {})
}
if (fieldAccessor) {
  let ready = false
  const retries = Cypress.config('retries')
  const options = mode === 'experimental-native-field-accessor'
  const raw = Object.getOwnPropertyDescriptor(Cypress.config(), 'retries').value
  const receiver = options ? Object.getOwnPropertyDescriptor(raw, 'experimentalOptions').value : raw
  Object.defineProperty(options ? retries.experimentalOptions : retries, options ? 'maxRetries' : 'runMode', {
    configurable: true,
    enumerable: true,
    get () {
      if (!ready) throw new Error('retry accessor evaluated during declaration')
      if (this !== receiver) throw new Error('retry accessor received a different settings object')
      retryAccessorReads++
      return 3
    },
  })
  ready = true
}

describe('native retry boundaries', () => {
  if (!fieldAccessor) {
    it('initial local control', { retries: 0 }, () => attempt('initial local control', 1))
    it('captures local retries', { retries: { runMode: 2, openMode: 0 } }, () => {
      savedLocalRetries = Cypress.config('retries')
      return attempt('captures local retries', 1)
    })
    it('restores local retries', () => {
      Cypress.config('retries', savedLocalRetries)
      return attempt('restores local retries', 1)
    })
  }
  it('excluded recovery', noAutoRetry(() => attempt('excluded recovery', 3)))
  it('excluded persistent', noAutoRetry(() => attempt('excluded persistent', Infinity)))
  it('excluded explicit zero', { retries: 0 }, noAutoRetry(() => attempt('excluded explicit zero', Infinity)))
  it('ordinary control', () => attempt('ordinary control', 3))
})
