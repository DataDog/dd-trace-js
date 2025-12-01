'use strict'

const assert = require('assert')

const forEach = require('mocha-each')
describe('mocha-parameterized', () => {
  forEach([[1, 2, 3]]).it('can do parameterized', (left, right, expected) => {
    assert.strictEqual(left + right, expected)
  })
})
