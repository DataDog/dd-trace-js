'use strict'

const assert = require('node:assert/strict')

const sum = require('./src/skipped-dependency')

describe('test-skipped', () => {
  it('covers the skipped dependency', () => {
    assert.strictEqual(sum(1, 2), 3)
  })
})
