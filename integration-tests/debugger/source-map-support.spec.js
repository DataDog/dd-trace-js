'use strict'

const { assert } = require('chai')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  describe('source map support', function () {
    const t = setup({
      testApp: 'target-app/source-map-support/index.js',
      testAppSource: 'target-app/source-map-support/index.ts'
    })

    beforeEach(t.triggerBreakpoint)

    it('should support source maps', function (done) {
      t.agent.on('debugger-input', ({ payload: [{ 'debugger.snapshot': { probe: { location } } }] }) => {
        assert.deepEqual(location, {
          file: 'target-app/source-map-support/index.ts',
          lines: ['9']
        })
        done()
      })

      t.agent.addRemoteConfig(t.rcConfig)
    })
  })
})
