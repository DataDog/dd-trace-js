'use strict'

const { expect } = require('chai')

describe('mocha-test-done-pass', () => {
  it('can do passed tests with done', (done) => {
    setTimeout(() => {
      try {
        expect(true).to.equal(true)
        done()
      } catch (e) {
        done(e)
      }
    }, 100)
  })
})
