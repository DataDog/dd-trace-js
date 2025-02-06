'use strict'

const { expect } = require('chai')

describe('mocha-test-done-fail', () => {
  it('can do failed tests with done', (done) => {
    setTimeout(() => {
      try {
        expect(true).to.equal(false)
        done()
      } catch (e) {
        done(e)
      }
    }, 100)
  })
})
