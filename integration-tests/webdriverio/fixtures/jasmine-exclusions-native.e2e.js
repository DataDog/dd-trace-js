'use strict'

const assert = require('node:assert/strict')
const { noAutoRetry } = require('dd-trace/test-optimization')
const recordExecution = require('./exclusions-execution-ledger')
let attempts = 0

describe('WebdriverIO native exclusion', () => {
  it('recovers', noAutoRetry(() => {
    recordExecution()
    assert.strictEqual(++attempts, 2)
  // eslint-disable-next-line no-undef -- Jasmine exposes its timeout through WebdriverIO.
  }), jasmine.DEFAULT_TIMEOUT_INTERVAL, 1)
})
