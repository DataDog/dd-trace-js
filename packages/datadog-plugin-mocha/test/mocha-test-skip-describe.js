const { expect } = require('chai')

describe('mocha-test-skip-describe', () => {
  before(function () {
    this.skip()
  })
  it('will be skipped', () => {
    expect(true).to.equal(true)
  })
})

describe('mocha-test-skip-describe-pass', () => {
  it('will pass', function () {
    expect(true).to.equal(true)
  })
})
