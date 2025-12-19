'use strict'

const assert = require('assert')
describe('disable tests', () => {
  it('can disable a test', () => {
    // eslint-disable-next-line no-console
    console.log('I am running') // to check if this is being run
    assert.strictEqual(1 + 2, 4)
  })
})
