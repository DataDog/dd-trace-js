'use strict'

const assert = require('assert')

describe('attempt to fix tests', () => {
  afterEach(() => {
  })

  it('can attempt to fix a test that always passes', () => {
    // eslint-disable-next-line no-console
    console.log('I am running when attempt to fix and I always pass') // to check if this is being run
    assert.strictEqual(1 + 2, 3)
  })
  it('can attempt to fix a test that always fails', () => {
    // eslint-disable-next-line no-console
    console.log('I am running when attempt to fix and I always fail') // to check if this is being run
    assert.strictEqual(1 + 2, 4)
  })
})
