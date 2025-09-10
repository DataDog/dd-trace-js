'use strict'

const { expect } = require('chai')
const sum = require('../sum')

describe('ci visibility 2', () => {
  it('can report tests 2', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
