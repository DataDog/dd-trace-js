'use strict'

const { expect } = require('chai')

describe('impacted tests 2', () => {
  it('can pass normally', () => {
    expect(1 + 2).to.equal(3)
  })

  it('can fail', () => {
    expect(1 + 2).to.equal(4)
  })
})
