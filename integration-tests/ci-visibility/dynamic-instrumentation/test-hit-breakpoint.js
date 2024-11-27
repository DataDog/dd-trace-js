/* eslint-disable */
const sum = require('./dependency')
const { expect } = require('chai')

// TODO: instead of retrying through jest, this should be retried with auto test retries
if (global.jest) {
  jest.retryTimes(1)
}

describe('dynamic-instrumentation', () => {
  it('retries with DI', function () {
    if (this.retries) {
      this.retries(1)
    }
    expect(sum(11, 3)).to.equal(14)
  })

  it('is not retried', () => {
    expect(1 + 2).to.equal(3)
  })
})
