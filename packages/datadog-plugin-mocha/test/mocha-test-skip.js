const { expect } = require('chai')

describe('mocha-test-skip', () => {
  it.skip('can skip', () => {
    expect(true).to.equal(false)
  })
})

describe('mocha-test-skip-different', () => {
  it.skip('can skip too', () => {
    expect(true).to.equal(false)
  })
  it.skip('can skip twice', () => {
    expect(true).to.equal(false)
  })
})

describe('mocha-test-programmatic-skip', () => {
  it('can skip too', function () {
    this.skip()
  })
})
