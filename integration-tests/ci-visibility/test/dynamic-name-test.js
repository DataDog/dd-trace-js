'use strict'

const assert = require('assert')

const sum = require('./sum')
describe('dynamic name suite', () => {
  it(`can do stuff at ${Date.now()}`, () => {
    assert.strictEqual(sum(1, 2), 3)
  })
})
