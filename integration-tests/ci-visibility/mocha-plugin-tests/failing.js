'use strict'

const { expect } = require('chai')

describe('mocha-test-fail', () => {
  it('can fail', () => {
    expect(true).to.equal(false)
  })
})
