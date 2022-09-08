const { expect } = require('chai')

describe('mocha-test-suite-level-pass', function () {
  it('will pass', () => {
    expect(2).to.equal(2)
  })
})

describe('mocha-test-suite-level-fail', function () {
  afterEach(() => {
    throw new Error()
  })
  it('will pass', () => {
    expect(2).to.equal(2)
  })
})
