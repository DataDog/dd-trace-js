'use strict'

const assert = require('assert')
let globalCounter = 0

describe('fail', () => {
  it('occasionally fails', () => {
    assert.strictEqual((globalCounter++) % 2, 0)
  })
})
