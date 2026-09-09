'use strict'

describe('mocha-test-pass', () => {
  before(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA BEFORE ALL EXECUTED')
  })

  after(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA AFTER ALL EXECUTED')
  })

  it('does not execute after the reporter fails', () => {
    // eslint-disable-next-line no-console
    console.log('MOCHA TEST BODY EXECUTED')
  })
})
