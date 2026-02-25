'use strict'

const assert = require('assert')

const sum = require('./unused-dependency')
describe('test-skipped', () => {
  it('can report tests', () => {
    assert.strictEqual(sum(1, 2), 3)
  })
})
