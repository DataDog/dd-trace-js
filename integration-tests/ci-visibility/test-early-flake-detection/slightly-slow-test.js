'use strict'

const assert = require('assert')

describe('efd slow retries', () => {
  it('slightly slow test', async () => {
    await new Promise(resolve => setTimeout(resolve, 5100))
    assert.strictEqual(1 + 1, 2)
  })
})
