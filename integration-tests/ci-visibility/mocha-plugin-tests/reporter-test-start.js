'use strict'

describe('mocha-reporter-test-start', () => {
  beforeEach(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA BEFORE EACH EXECUTED')
  })

  beforeEach(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA BEFORE SECOND EACH EXECUTED')
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
