'use strict'

const assert = require('node:assert/strict')
describe('parameterized', () => {
  test.each(['parameter 1', 'parameter 2'])('test %s', (value) => {
    assert.deepStrictEqual(value.startsWith('parameter'), true)
  })
})
