'use strict'

const assert = require('assert')

describe('efd slow retries', () => {
  // Runs past the 5s bucket, so the timeout has to exceed Jest's 5s default.
  it('slightly slow test', async () => {
    await new Promise(resolve => setTimeout(resolve, 5100))
    assert.strictEqual(1 + 1, 2)
  }, 20_000)
})
