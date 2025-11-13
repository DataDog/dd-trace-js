'use strict'

const sum = require('../sum')

describe('ci visibility 3', () => {
  it('can report tests 3', () => {
    expect(sum(1, 2)).toEqual(3)
  })
})
