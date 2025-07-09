'use strict'

const sum = require('./dependency')
const { expect } = require('chai')

let count = 0
describe('dynamic-instrumentation', () => {
  it('retries with DI', function () {
    if (process.env.TEST_SHOULD_PASS_AFTER_RETRY && count++ === 1) {
      // Passes after a retry if TEST_SHOULD_PASS_AFTER_RETRY is passed
      expect(sum(1, 3)).to.equal(4)
    } else {
      expect(sum(11, 3)).to.equal(14)
    }
  })

  it('is not retried', () => {
    expect(1 + 2).to.equal(3)
  })
})
