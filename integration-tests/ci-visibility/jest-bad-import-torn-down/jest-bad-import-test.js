'use strict'

const assert = require('node:assert/strict')

afterAll(() => {
  process.nextTick(() => {
    require('./off-timing-import.js')
  })
})
it('will fail', () => {
  assert.strictEqual(true, true)
})
