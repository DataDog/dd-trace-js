'use strict'

const assert = require('node:assert/strict')

const sum = require('./unused-dependency')
describe('test-skipped', () => {
  it('can report tests', () => {
    assert.strictEqual(sum(1, 2), 3)
  })
})
