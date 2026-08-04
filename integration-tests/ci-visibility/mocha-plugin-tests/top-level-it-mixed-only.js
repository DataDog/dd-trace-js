'use strict'

it('top-level passing test', () => {})

// eslint-disable-next-line mocha/no-exclusive-tests
describe.only('an exclusive describe block', () => {
  it('nested passing test', () => {})
})
