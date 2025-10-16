'use strict'

const { expect } = require('chai')

describe('mocha-fail-hook-sync', () => {
  beforeEach(() => {
    const value = ''
    value.unsafe.error = ''
  })

  it('will not run but be reported as failed', () => {
    expect(true).to.equal(true)
  })
})
