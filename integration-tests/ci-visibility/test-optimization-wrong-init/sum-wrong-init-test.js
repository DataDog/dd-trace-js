'use strict'

const tracer = require('dd-trace')
const assert = require('node:assert')

tracer.trace('sum.test', { resource: 'sum.test.js' }, () => {
  describe('sum', () => {
    it('should return the sum of two numbers', () => {
      assert.equal(1 + 2, 3)
    })
  })
})
