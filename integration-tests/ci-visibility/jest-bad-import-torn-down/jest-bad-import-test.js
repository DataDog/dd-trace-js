'use strict'

const assert = require('assert')

afterAll(() => {
  process.nextTick(() => {
    require(process.env.TEST_LOGGER || './off-timing-import.js')
  })
})
it('will fail', () => {
  assert.strictEqual(true, true)
})
