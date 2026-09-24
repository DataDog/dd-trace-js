'use strict'

const assert = require('assert')
describe('mocha-test-fail', () => {
  afterEach(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA AFTER EACH EXECUTED')
  })

  afterEach(() => {
    // eslint-disable-next-line no-console
    console.log('MOCHA AFTER SECOND EACH EXECUTED')
  })

  it('can fail', () => {
    assert.strictEqual(true, false)
  })
})
