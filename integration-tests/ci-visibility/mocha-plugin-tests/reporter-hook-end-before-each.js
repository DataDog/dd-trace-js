'use strict'

describe('mocha-reporter-hook-end-before-each', () => {
  beforeEach(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA BEFORE EACH EXECUTED')
  })

  afterEach(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA AFTER EACH EXECUTED')
  })

  it('does not execute after the reporter fails', () => {
    // eslint-disable-next-line no-console
    console.log('MOCHA TEST BODY EXECUTED')
  })
})
