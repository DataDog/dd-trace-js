'use strict'

const sum = require('./dependency')
const { expect } = require('chai')

let count = 0
describe('dynamic-instrumentation', () => {
  it('retries with DI', function () {
    const willFail = count++ === 0
    if (willFail) {
      expect(sum(11, 3)).to.equal(14) // only throws the first time
    } else {
      expect(sum(1, 2)).to.equal(3)
    }
  })
})
