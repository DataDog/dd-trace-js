'use strict'

const assert = require('assert')

describe('mocha-flaky', () => {
  it('can retry failed tests', () => {
    assert.strictEqual(1 + 2, 4)
  })
})
