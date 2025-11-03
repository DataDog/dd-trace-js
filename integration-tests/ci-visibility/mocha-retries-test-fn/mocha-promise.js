'use strict'

const assert = require('assert')
let attempt = 0

describe('mocha-promise-retries', function () {
  this.retries(4)

  it('will be retried and pass', () => {
    assert.equal(attempt++, 2)
    return Promise.resolve()
  })
})
