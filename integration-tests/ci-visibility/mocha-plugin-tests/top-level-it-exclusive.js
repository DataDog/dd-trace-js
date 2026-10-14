'use strict'

// eslint-disable-next-line mocha/no-exclusive-tests
it.only('exclusive root-level test', () => {
  throw new Error('This test must be skipped by Test Impact Analysis')
})

it('non-exclusive root-level test', () => {
  throw new Error('This test must be excluded by Mocha')
})
