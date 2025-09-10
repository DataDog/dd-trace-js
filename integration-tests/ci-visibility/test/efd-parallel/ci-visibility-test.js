'use strict'

const { expect } = require('chai')
const sum = require('../sum')

describe('ci visibility', () => {
  it('can report tests', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
