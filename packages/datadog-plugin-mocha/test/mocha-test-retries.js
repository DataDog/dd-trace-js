const { expect } = require('chai')

let attempt = 0
describe('mocha-test-retries', function () {
  this.retries(4)
  it('will be retried and pass', () => {
    expect(attempt++).to.equal(2)
  })
  it('will be retried and fail', () => {
    expect(attempt++).to.equal(8)
  })
})
