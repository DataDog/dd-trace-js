'use strict'

const assert = require('node:assert/strict')

describe('global setup', () => {
  it('runs after setup', () => {
    assert.strictEqual(global.mochaSetupFinished, true)
    assert.strictEqual(global.mochaTestExecuted, undefined)
    global.mochaTestExecuted = true
  })
})
