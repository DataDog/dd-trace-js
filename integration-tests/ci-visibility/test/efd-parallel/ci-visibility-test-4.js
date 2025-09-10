'use strict'

const { expect } = require('chai')
const sum = require('../sum')

describe('ci visibility 4', () => {
  it('can report tests 4', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
