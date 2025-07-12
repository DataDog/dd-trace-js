'use strict'

describe('mocha-test-timeout-pass', () => {
  it('does not timeout', function (done) {
    this.timeout(300)
    setTimeout(() => {
      done()
    }, 200)
  })
})
