'use strict'

describe('mocha-reporter-reusable-run', () => {
  beforeEach(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA REUSABLE FIRST HOOK EXECUTED')
  })

  beforeEach(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA REUSABLE SECOND HOOK EXECUTED')
  })

  it('runs again after reporter recovery', () => {
    // eslint-disable-next-line no-console
    console.log('MOCHA REUSABLE TEST EXECUTED')
  })
})
