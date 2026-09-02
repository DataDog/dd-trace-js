'use strict'

const assert = require('node:assert/strict')

let firstCounter = 0
let secondCounter = 0

describe('fail', () => {
  it('first occasionally fails', () => {
    assert.strictEqual((firstCounter++) % 2, 0)
  })

  it('second occasionally fails', () => {
    assert.strictEqual((secondCounter++) % 2, 0)
  })
})
