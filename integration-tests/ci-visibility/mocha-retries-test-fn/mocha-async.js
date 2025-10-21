'use strict'

const assert = require('assert')
let attempt = 0

describe('mocha-async-retries', function () {
  this.retries(4)

  it('will be retried and pass', async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 0)
    })
    assert.equal(attempt++, 2)
  })
})
