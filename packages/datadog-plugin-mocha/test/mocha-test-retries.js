const { expect } = require('chai')

let attempt = 0
describe('mocha-test-retries', function () {
  this.retries(4)
  it('will be retried', () => {
    expect(attempt++).to.equal(2)
  })
})
