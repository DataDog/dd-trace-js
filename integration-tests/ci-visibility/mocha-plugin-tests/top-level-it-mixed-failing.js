'use strict'

it('top-level failing test', () => {
  throw new Error('intentional failure')
})

describe('a passing describe block', () => {
  it('passing nested test', () => {})
})
