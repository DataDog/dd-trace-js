'use strict'

const { assert } = require('chai')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup()

  describe('input messages', function () {
    describe('with snapshot', function () {
      beforeEach(t.triggerBreakpoint)

      it('should prune snapshot if payload is too large', function (done) {
        t.agent.on('debugger-input', ({ payload }) => {
          assert.isBelow(Buffer.byteLength(JSON.stringify(payload)), 1024 * 1024) // 1MB
          done()
        })

        t.agent.addRemoteConfig(t.generateRemoteConfig({ captureSnapshot: true }))
      })
    })
  })
})
