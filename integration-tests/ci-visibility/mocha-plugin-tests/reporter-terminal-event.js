'use strict'

describe('mocha-test-pass-two', () => {
  afterEach(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA AFTER EACH EXECUTED')
  })

  afterEach(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA AFTER SECOND EACH EXECUTED')
  })

  after(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA AFTER ALL EXECUTED')
  })

  it('can pass', () => {})
})
