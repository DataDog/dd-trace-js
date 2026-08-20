'use strict'

describe('mocha-reporter-pending-after-each', () => {
  afterEach(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA AFTER EACH EXECUTED')
  })

  it.skip('can skip', () => {})
})
