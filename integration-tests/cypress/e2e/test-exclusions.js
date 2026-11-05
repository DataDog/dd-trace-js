'use strict'

/* global cy */
/* eslint-disable mocha/no-identical-title -- Each mode runs in a separate Cypress process. */

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/ci/test-annotations')

const { getTestEnvironment } = require('../support/test-environment')

const mode = getTestEnvironment('EXCLUSIONS_MODE')
const executions = {}
const attempt = (name, passAt = Infinity) => {
  executions[name] = (executions[name] || 0) + 1
  return cy.writeFile('exclusion-executions.json', executions, { log: false }).then(() => {
    if (executions[name] < passAt) throw new Error('excluded failure')
  })
}
function fail () { throw new Error('excluded failure') }

if (mode === 'policy') {
  it('protected disabled', preventFailureSuppression(() => attempt('protected disabled')))
  it('protected quarantine', preventFailureSuppression(() => attempt('protected quarantine')))
  for (const value of [1, 2]) {
    it(`protected both ${value}`, preventFailureSuppression(noAutoRetry(() => attempt(`protected both ${value}`))))
  }
  it('ordinary disabled', noAutoRetry(() => attempt('ordinary disabled')))
  it('ordinary quarantine', () => attempt('ordinary quarantine'))
  it('excluded quarantine', noAutoRetry(() => attempt('excluded quarantine')))
  it('protected passing', preventFailureSuppression(() => attempt('protected passing', 1)))
  it('ordinary passing', () => attempt('ordinary passing', 1))
  // Explicit developer skips still apply despite both annotations.
  it.skip('developer skipped', preventFailureSuppression(noAutoRetry(() => attempt('developer skipped'))))
} else if (mode === 'all-skipped') {
  // An entirely pending run must still report each declaration and its assignments.
  it.skip('annotated skip', preventFailureSuppression(noAutoRetry(fail)))
  // Recovery retains protection without executing the skipped callback.
  it.skip('protected skipped atf', preventFailureSuppression(fail))
  // Keep an unprotected ATF control in the same pending run.
  it.skip('ordinary skipped atf', fail)
} else if (mode === 'sole') {
  it('sole', preventFailureSuppression(noAutoRetry(fail)))
} else if (mode === 'native') {
  it('global native', noAutoRetry(() => attempt('global native', 3)))
  describe('suite native', { retries: 1 }, () => {
    it('suite retry', noAutoRetry(() => attempt('suite native', 2)))
  })
  it('test native', { retries: 1 }, noAutoRetry(() => attempt('test native', 2)))
  it('native zero', { retries: 0 }, noAutoRetry(fail))
} else if (mode === 'experimental') {
  it('native experimental excluded', noAutoRetry(fail))
  it('native experimental control', fail)
  it('native experimental zero', { retries: 0 }, noAutoRetry(fail))
  it('native experimental recovery', noAutoRetry(() => attempt('native experimental recovery', 2)))
} else if (mode === 'atr') {
  it('excluded', noAutoRetry(fail))
  it('control', fail)
  it('protected retry', preventFailureSuppression(() => attempt('protected retry', 2)))
} else {
  it('excluded', noAutoRetry(() => {}))
  it('control', () => {})
}
