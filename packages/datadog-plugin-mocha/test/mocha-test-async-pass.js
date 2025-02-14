'use strict'

const { expect } = require('chai')

describe('mocha-test-async-pass', () => {
  it('can do passed async tests', async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    expect(true).to.equal(true)
  })
})
