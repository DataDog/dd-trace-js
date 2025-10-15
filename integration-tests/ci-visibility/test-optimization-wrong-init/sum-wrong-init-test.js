'use strict'

const assert = require('node:assert')
const tracer = require('dd-trace')

tracer.trace('sum.test', { resource: 'sum.test.js' }, () => {
  describe('sum', () => {
    it('should return the sum of two numbers', () => {
      assert.equal(1 + 2, 3)
    })
  })
})
