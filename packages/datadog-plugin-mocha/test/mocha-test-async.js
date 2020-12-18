const { expect } = require('chai')

describe('mocha-test-async', () => {
  it('can do async tests', (done) => {
    setTimeout(() => {
      expect(true).to.equal(true)
      done()
    }, 100)
  })
})
