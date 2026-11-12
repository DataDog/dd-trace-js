'use strict'

it('top-level passing test', () => {})

// eslint-disable-next-line mocha/no-exclusive-tests
describe.only('an exclusive describe block', () => {
  // eslint-disable-next-line mocha/no-exclusive-tests
  it.only('nested passing test', () => {})
  it('nested non-exclusive test', () => {})
})
