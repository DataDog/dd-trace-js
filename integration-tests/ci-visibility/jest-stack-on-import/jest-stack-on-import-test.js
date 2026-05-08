'use strict'

const stack = require('./read-stack')

describe('stack during module import', () => {
  it('can read a default error stack while loading the test module', () => {
    expect(stack).toContain('Error: stack from module import')
  })
})
