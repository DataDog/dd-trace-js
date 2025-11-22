'use strict'

const assert = require('node:assert/strict')

it('will fail', () => {
  setTimeout(() => {
    const sum = require('./off-timing-import.js')

    assert.strictEqual(sum(1, 2), 3)
  }, 0)
})
