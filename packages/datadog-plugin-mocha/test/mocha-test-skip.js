const { expect } = require('chai')

describe('mocha-test-skip', () => {
  it.skip('can skip', () => {
    expect(true).to.equal(false)
  })
})
