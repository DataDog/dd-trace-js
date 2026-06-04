'use strict'

const assert = require('assert')
let numAttempts = 0

describe('fail first then pass', () => {
  it('fails first then passes', () => {
    assert.strictEqual(numAttempts++ > 0, true)
  })
})
