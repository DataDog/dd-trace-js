'use strict'

const { expect } = require('chai')

describe('mocha-test-promise-pass', () => {
  it('can do passed promise tests', () => {
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(true).to.equal(true)
        resolve()
      }, 100)
    })
  })
})
