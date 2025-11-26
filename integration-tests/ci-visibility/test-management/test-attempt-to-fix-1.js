'use strict'

const assert = require('assert')
let numAttempts = 0

describe('attempt to fix tests', () => {
  it('can attempt to fix a test', () => {
    // eslint-disable-next-line no-console
    console.log('I am running when attempt to fix') // to check if this is being run
    if (process.env.SHOULD_ALWAYS_PASS) {
      assert.strictEqual(1 + 2, 3)
    } else if (process.env.SHOULD_FAIL_SOMETIMES) {
      if (numAttempts++ % 2 === 0) {
        assert.strictEqual(1 + 2, 3)
      } else {
        assert.strictEqual(1 + 2, 4)
      }
    } else {
      assert.strictEqual(1 + 2, 4)
    }
  })
})
