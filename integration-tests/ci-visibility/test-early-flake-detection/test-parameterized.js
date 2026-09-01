'use strict'

const assert = require('assert')
describe('parameterized', () => {
  const parameterizedTest = test.each(['parameter 1', 'parameter 2'])
  parameterizedTest('test %s', (value) => {
    assert.deepStrictEqual(value.startsWith('parameter'), true)
  })
})
