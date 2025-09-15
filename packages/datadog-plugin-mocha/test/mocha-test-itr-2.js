'use strict'

const assert = require('node:assert')
const { describe, it } = require('mocha')

describe('mocha-itr-2', () => {
  it('can sum', () => {
    assert.strictEqual(1 + 2, 3)
  })
})
