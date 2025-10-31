'use strict'

const assert = require('assert')
let attempt = 0

describe('mocha-done-retries', function () {
  this.retries(4)

  it('will be retried and pass', (done) => {
    assert.equal(attempt++, 2)
    done()
  })
})
