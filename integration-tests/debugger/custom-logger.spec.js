'use strict'

const assert = require('node:assert')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup()

  it('should not abort if a custom logger is used', function (done) {
    t.agent.on('debugger-input', ({ payload: [payload] }) => {
      assert.strictEqual(payload.message, 'Hello World!')
      done()
    })

    t.agent.addRemoteConfig(t.rcConfig)
    t.triggerBreakpoint()
  })
})
