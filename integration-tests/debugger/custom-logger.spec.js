'use strict'

const assert = require('node:assert')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const stdio = []
  const stderr = []
  const t = setup({
    env: {
      DD_TRACE_DEBUG: 'true'
    },
    silent: true,
    stdioHandler (data) {
      stdio.push(data.toString())
    },
    stderrHandler (data) {
      stderr.push(data.toString())
    },
  })

  it('should log to the custom logger from the worker thread', function (done) {
    t.agent.on('debugger-input', () => {
      assert(stdio.some((line) => line.startsWith('[CUSTOM LOGGER][DEBUG]: [debugger]')))
      assert(stdio.some((line) => line.startsWith('[CUSTOM LOGGER][DEBUG]: [debugger:devtools_client]')))
      assert.strictEqual(stderr.length, 0)
      done()
    })

    t.agent.addRemoteConfig(t.rcConfig)
    t.triggerBreakpoint()
  })
})
