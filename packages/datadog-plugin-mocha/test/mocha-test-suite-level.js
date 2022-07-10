const { expect } = require('chai')

describe('mocha-test-suite-level-1', function () {
  it('will pass', () => {
    expect(2).to.equal(2)
  })
  it('will fail', () => {
    expect(2).to.equal(8)
  })
})

describe('mocha-test-suite-level-2', function () {
  it('will pass', () => {
    expect(2).to.equal(2)
  })
  it('will fail', () => {
    expect(2).to.equal(8)
  })
})
