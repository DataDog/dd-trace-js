'use strict'

const { expect } = require('chai')
const sum = require('../sum')

describe('ci visibility 3', () => {
  it('can report tests 3', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
