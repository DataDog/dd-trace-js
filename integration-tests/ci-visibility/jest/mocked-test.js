'use strict'

const assert = require('node:assert/strict')

jest.mock('../test/sum.js')

test('adds 1 + 2 to equal 3', () => {
  assert.strictEqual(1 + 2, 3)
})
