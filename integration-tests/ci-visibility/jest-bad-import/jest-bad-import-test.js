'use strict'

it('will fail', () => {
  setTimeout(() => {
    const sum = require('./off-timing-import.js')

    expect(sum(1, 2)).toBe(3)
  }, 0)
})
