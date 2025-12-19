'use strict'

const assert = require('assert')
it('no describe can do stuff', () => {
  assert.strictEqual(1, 1)
})

describe('describe ', () => {
  it('trailing space ', () => {
    assert.strictEqual(1, 1)
  })
})
