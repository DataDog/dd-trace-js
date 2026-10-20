'use strict'

/* eslint-disable mocha/no-identical-title -- Each mode runs in a separate Cypress process. */

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')

const { getTestEnvironment } = require('../support/test-environment')

function fail () { throw new Error('excluded failure') }

if (getTestEnvironment('EXCLUSIONS_MODE') === 'mode-selection') {
  it('mode selected', noAutoRetry(() => {}))
} else if (getTestEnvironment('EXCLUSIONS_MODE') === 'policy') {
  it('protected disabled', preventFailureSuppression(fail))
  it('protected quarantine', preventFailureSuppression(fail))
  for (const value of [1, 2]) {
    it(`protected both ${value}`, preventFailureSuppression(noAutoRetry(fail)))
  }
  it('ordinary disabled', noAutoRetry(fail))
  it('ordinary quarantine', noAutoRetry(fail))
  it('protected passing', preventFailureSuppression(() => {}))
  // Verify annotations do not reverse an explicit developer skip.
  it.skip('developer skipped', preventFailureSuppression(noAutoRetry(fail)))
} else if (getTestEnvironment('EXCLUSIONS_MODE') === 'all-skipped') {
  // Verify annotation reporting when every declaration is skipped.
  it.skip('annotated skip', preventFailureSuppression(noAutoRetry(fail)))
} else if (getTestEnvironment('EXCLUSIONS_MODE') === 'duplicate-skipped') {
  // Keep protection attached to the first skipped declaration with this title.
  it.skip('duplicate declaration', preventFailureSuppression(fail))
  // Retry exclusion belongs only to this skipped declaration.
  it.skip('duplicate declaration', noAutoRetry(fail))
  // An unannotated skip must not inherit its sibling's metadata.
  it.skip('duplicate declaration', fail)
} else if (getTestEnvironment('EXCLUSIONS_MODE') === 'duplicate-mixed') {
  it('duplicate declaration', preventFailureSuppression(() => {}))
  // Retry exclusion belongs only to this skipped declaration.
  it.skip('duplicate declaration', noAutoRetry(fail))
  // An unannotated skip must not inherit its sibling's metadata.
  it.skip('duplicate declaration', fail)
} else if (getTestEnvironment('EXCLUSIONS_MODE') === 'removed') {
  it('sole', fail)
} else if (getTestEnvironment('EXCLUSIONS_MODE') === 'sole') {
  it('sole', preventFailureSuppression(noAutoRetry(fail)))
} else if (getTestEnvironment('EXCLUSIONS_MODE') === 'override-zero') {
  it('native retries zero', { retries: 0 }, noAutoRetry(fail))
} else if (getTestEnvironment('EXCLUSIONS_MODE') === 'suite') {
  describe('suite retries', { retries: 2 }, () => {
    let executions = 0
    it('native retries', noAutoRetry(() => { if (++executions === 1) fail() }))
  })
} else if (getTestEnvironment('EXCLUSIONS_MODE') === 'global') {
  let executions = 0
  it('native retries', noAutoRetry(() => { if (++executions === 1) fail() }))
} else if (getTestEnvironment('EXCLUSIONS_MODE') === 'explicit') {
  let executions = 0
  it('native retries', { retries: 2 }, noAutoRetry(() => {
    if (++executions === 1) fail()
  }))
} else if (getTestEnvironment('EXCLUSIONS_MODE') === 'atr') {
  it('excluded', noAutoRetry(fail))
  it('control', fail)
  let executions = 0
  it('protected retry', preventFailureSuppression(() => {
    if (++executions === 1) fail()
  }))
} else {
  it('excluded', noAutoRetry(() => {}))
  it('control', () => {})
}
