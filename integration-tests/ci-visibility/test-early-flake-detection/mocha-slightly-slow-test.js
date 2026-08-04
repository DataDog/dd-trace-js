'use strict'

const assert = require('node:assert/strict')

describe('efd slow retries', function () {
  this.timeout(7000)

  it('slightly slow test', async () => {
    await new Promise(resolve => setTimeout(resolve, 5100))
    assert.strictEqual(1 + 1, 2)
  })
})
