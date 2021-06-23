const { expect } = require('chai')

describe('mocha-fail-hook-async', function () {
  this.timeout(100)
  afterEach((done) => {
    setTimeout(() => {
      done()
    }, 200)
  })
  it('will not run but be reported as failed', () => {
    expect(true).to.equal(true)
  })
})
