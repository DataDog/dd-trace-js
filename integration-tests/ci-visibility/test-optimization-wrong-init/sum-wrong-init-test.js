'use strict'

const { expect } = require('chai')
const tracer = require('dd-trace')

tracer.trace('sum.test', { resource: 'sum.test.js' }, () => {
  describe('sum', () => {
    it('should return the sum of two numbers', () => {
      expect(1 + 2).to.equal(3)
    })
  })
})
