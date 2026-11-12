'use strict'

const assert = require('assert')
describe('ci visibility', () => {
  it('can report tests', () => {
    assert.strictEqual(1 + 2, 3)
  })
  // only run for jest tests
  if (typeof jest !== 'undefined') {
    it.todo('todo will not be retried')
  }

  // This skip verifies that Early Flake Detection does not retry skipped tests.
  it.skip('skip will not be retried', () => {
    assert.strictEqual(1 + 2, 4)
  })
})
