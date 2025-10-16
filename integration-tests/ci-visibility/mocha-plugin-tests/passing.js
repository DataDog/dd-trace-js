'use strict'

const { expect } = require('chai')

describe('mocha-test-pass', () => {
  it('can pass', () => {
    expect(true).to.equal(true)
  })

  it('can pass two', () => {
    expect(true).to.equal(true)
  })
})

describe('mocha-test-pass-two', () => {
  it('can pass', () => {
    expect(true).to.equal(true)
  })

  it('can pass two', () => {
    expect(true).to.equal(true)
  })
})
