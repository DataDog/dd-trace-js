'use strict'

const assert = require('node:assert/strict')

const sum = require('./used-dependency')
describe('test-run', () => {
  it('can report tests', () => {
    assert.strictEqual(sum(1, 2), 3)
  })
})
