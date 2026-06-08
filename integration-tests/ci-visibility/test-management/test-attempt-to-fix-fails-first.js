'use strict'

const assert = require('assert')
let numAttempts = 0

describe('attempt to fix tests that fail first', () => {
  it('can attempt to fix a test that fails first then passes', function () {
    if (process.env.SET_RETRIES_INSIDE_TEST) {
      // eslint-disable-next-line sonarjs/stable-tests -- verifies Datadog-managed retries disable Mocha retries
      this.retries(2)
    }
    assert.strictEqual(numAttempts++ > 0, true)
  })
})
