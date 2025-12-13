'use strict'

const assert = require('assert')

afterAll(() => {
  process.nextTick(() => {
    require('./off-timing-import.js')
  })
})
it('will fail', () => {
  assert.strictEqual(true, true)
})
