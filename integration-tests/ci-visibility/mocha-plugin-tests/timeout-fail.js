'use strict'

describe('mocha-test-timeout-fail', () => {
  it('times out', function (done) {
    this.timeout(100)
    setTimeout(() => {
      done()
    }, 200)
  })
})
