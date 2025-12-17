'use strict'

const assert = require('node:assert/strict')

const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({ dependencies: ['fastify'] })

  describe('input messages', function () {
    describe('with snapshot', function () {
      beforeEach(() => { t.triggerBreakpoint() })

      it('should prune snapshot if payload is too large', function (done) {
        t.agent.on('debugger-input', ({ payload: [payload] }) => {
          const payloadSize = Buffer.byteLength(JSON.stringify(payload))
          assert.ok(payloadSize < 1024 * 1024) // 1MB

          const capturesJson = JSON.stringify(payload.debugger.snapshot.captures)
          assert.ok(capturesJson.includes('"pruned":true'))

          done()
        })

        t.agent.addRemoteConfig(t.generateRemoteConfig({
          captureSnapshot: true,
          capture: {
            // ensure we get a large snapshot
            maxCollectionSize: Number.MAX_SAFE_INTEGER,
            maxFieldCount: Number.MAX_SAFE_INTEGER,
            maxLength: Number.MAX_SAFE_INTEGER
          }
        }))
      })
    })
  })
})
