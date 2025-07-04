'use strict'

const { expect } = require('chai')

describe('mocha-test-done-fail', () => {
  it('can do badly setup failed tests with done', (done) => {
    setTimeout(() => {
      expect(true).to.equal(false)
      done()
    }, 100)
  })
})
