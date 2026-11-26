'use strict'

globalThis.lineCoverageBranch = 'first'
const getBranch = require('./branches')

describe('module copies', () => {
  it('runs the first branch', () => {
    expect(getBranch()).toBe('first')
  })
})
