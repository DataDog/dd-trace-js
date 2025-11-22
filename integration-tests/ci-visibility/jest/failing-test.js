'use strict'

const assert = require('node:assert/strict')
describe('failing', () => {
  it.failing('can report failed tests', () => {
    assert.strictEqual(1 + 2, 4)
  })

  it.failing('can report failing tests as failures', () => {
    assert.strictEqual(1 + 2, 3) // this passes but it should fail! So the test.status should be fail
  })
})
