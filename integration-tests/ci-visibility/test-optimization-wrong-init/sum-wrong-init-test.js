'use strict'

const tracer = require('dd-trace')

tracer.trace('sum.test', { resource: 'sum.test.js' }, () => {
  describe('sum', () => {
    it('should return the sum of two numbers', () => {
      return expect(1 + 2).toBe(3)
    })
  })
})
