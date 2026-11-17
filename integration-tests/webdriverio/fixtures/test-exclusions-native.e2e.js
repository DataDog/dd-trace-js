'use strict'

/* global jasmine */
const assert = require('node:assert/strict')
const { noAutoRetry } = require('dd-trace/ci/test-annotations')
const recordExecution = require('./exclusions-execution-ledger')
let attempts = 0

const isJasmine = process.env.WEBDRIVERIO_FRAMEWORK === 'jasmine'

describe('WebdriverIO native exclusion', () => {
  it('recovers', noAutoRetry(function () {
    // eslint-disable-next-line sonarjs/stable-tests -- Verify explicitly configured native Mocha retries.
    if (!isJasmine) this.retries(1)
    recordExecution()
    assert.strictEqual(++attempts, 2)
  }), ...(isJasmine ? [jasmine.DEFAULT_TIMEOUT_INTERVAL, 1] : []))
})
