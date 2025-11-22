'use strict'

const assert = require('node:assert/strict')
describe('attempt to fix tests 2', () => {
  it('can attempt to fix a test', () => {
    // eslint-disable-next-line no-console
    console.log('I am running when attempt to fix 2') // to check if this is being run
    assert.strictEqual(1 + 2, 3)
  })
})
