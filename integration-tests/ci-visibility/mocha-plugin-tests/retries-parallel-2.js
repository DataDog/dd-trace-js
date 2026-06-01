'use strict'

const assert = require('assert')
let attempt = 0

describe('mocha-test-retries-parallel-2', function () {
  this.retries(2)

  it('will fail twice then pass', () => {
    assert.strictEqual(attempt++, 2)
  })
})
