'use strict'

const assert = require('node:assert/strict')
const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')
const recordExecution = require('./exclusions-execution-ledger')
const both = fn => preventFailureSuppression(noAutoRetry(fn))
const failure = () => {
  recordExecution()
  assert.fail('intentional failure')
}

describe('WebdriverIO exclusions', () => {
  it('protected failure', both(failure))
  it('excluded failure', noAutoRetry(failure))
  it('retry control', failure)
  it('disabled control', noAutoRetry(failure))
  it('quarantined control', noAutoRetry(failure))
  // Explicit skips must remain skipped and still report known annotations.
  xit('developer skipped', both(failure))
  for (const value of [1, 2]) {
    it(`parameter case ${value}`, both(failure))
  }
})
