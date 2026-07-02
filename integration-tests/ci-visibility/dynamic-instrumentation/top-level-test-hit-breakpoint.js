'use strict'

const assert = require('assert')

const sum = require('./dependency')

let count = 0

afterEach(function () {})

it('top-level retries with DI', () => {
  if (process.env.TEST_SHOULD_PASS_AFTER_RETRY && count++ === 1) {
    assert.throws(() => sum(11, 3), /a is too big/)
    assert.strictEqual(sum(1, 3), 4)
  } else {
    assert.strictEqual(sum(11, 3), 14)
  }
})
