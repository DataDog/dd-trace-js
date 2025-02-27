'use strict'

const { expect } = require('chai')

describe('fail', () => {
  it('can report failed tests', () => {
    expect(1 + 2).to.equal(4)
  })
})
