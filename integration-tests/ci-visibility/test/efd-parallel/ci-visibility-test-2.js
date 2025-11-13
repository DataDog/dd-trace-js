'use strict'

const sum = require('../sum')

describe('ci visibility 2', () => {
  it('can report tests 2', () => {
    expect(sum(1, 2)).toEqual(3)
  })
})
