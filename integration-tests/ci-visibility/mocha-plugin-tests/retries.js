'use strict'

const assert = require('assert')
let attempt = 0

describe('mocha-test-retries', function () {
  this.retries(4)

  afterEach(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA AFTER EACH EXECUTED')
  })

  it('will be retried and pass', () => {
    assert.strictEqual(attempt++, 2)
  })

  it('will be retried and fail', () => {
    assert.strictEqual(attempt++, 8)
  })
})
