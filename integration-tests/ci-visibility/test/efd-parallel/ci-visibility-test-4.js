'use strict'

const sum = require('../sum')

describe('ci visibility 4', () => {
  it('can report tests 4', () => {
    expect(sum(1, 2)).toEqual(3)
  })
})
