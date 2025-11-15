'use strict'

const sum = require('../sum')

describe('ci visibility', () => {
  it('can report tests', () => {
    expect(sum(1, 2)).toEqual(3)
  })
})
