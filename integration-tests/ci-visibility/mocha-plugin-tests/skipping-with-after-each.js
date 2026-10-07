'use strict'

describe('mocha-reporter-pending-after-each', () => {
  afterEach(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA AFTER EACH EXECUTED')
  })

  // This skip is fixture input for reporter hook-order coverage.
  it.skip('can skip', () => {})
})
