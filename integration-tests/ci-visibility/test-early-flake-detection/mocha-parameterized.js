'use strict'

const assert = require('node:assert/strict')

const forEach = require('mocha-each')
describe('parameterized', () => {
  forEach(['parameter 1', 'parameter 2']).it('test %s', (value) => {
    assert.strictEqual(value.startsWith('parameter'), true)
  })
})
