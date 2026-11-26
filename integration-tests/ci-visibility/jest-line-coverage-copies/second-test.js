'use strict'

const getBranch = require('./branches')

describe('module copies', () => {
  it('runs the second branch', () => {
    expect(getBranch()).toBe('second')
  })
})
