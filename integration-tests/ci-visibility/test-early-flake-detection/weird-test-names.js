'use strict'

const assert = require('node:assert/strict')
it('no describe can do stuff', () => {
  assert.strictEqual(1, 1)
})

describe('describe ', () => {
  it('trailing space ', () => {
    assert.strictEqual(1, 1)
  })
})
