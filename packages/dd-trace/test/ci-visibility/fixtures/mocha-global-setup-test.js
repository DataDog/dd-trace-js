'use strict'

const assert = require('node:assert/strict')

const { context } = require('./mocha-global-setup')

describe('global setup', () => {
  it('runs after setup in the configuration context', () => {
    assert.strictEqual(global.mochaSetupFinished, true)
    assert.strictEqual(global.mochaTestExecuted, undefined)
    assert.strictEqual(context.getStore(), 'configuration context')
    global.mochaTestExecuted = true
  })
})
