'use strict'

const { expect } = require('chai')

describe('mocha-test-async-fail', () => {
  it('can do failed async tests', async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    expect(true).to.equal(false)
  })
})
