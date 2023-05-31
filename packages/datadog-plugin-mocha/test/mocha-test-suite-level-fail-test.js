const { expect } = require('chai')

describe('mocha-test-suite-level-fail', function () {
  it('will pass', () => {
    expect(2).to.equal(2)
  })
  it('will fail', () => {
    expect(2).to.equal(8)
  })
})

describe('mocha-test-suite-level-pass', function () {
  it('will pass', () => {
    expect(2).to.equal(2)
  })
  it.skip('will skip', () => {
    expect(2).to.equal(2)
  })
})
