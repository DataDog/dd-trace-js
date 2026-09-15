'use strict'

const assert = require('node:assert/strict')

const { setup } = require('./utils')

// Mirrors the limit in packages/dd-trace/src/debugger/devtools_client/send.js
const MAX_LOG_PAYLOAD_SIZE_BYTES = 1024 * 1024 - 4 * 1024

describe('Dynamic Instrumentation', function () {
  const t = setup({ dependencies: ['fastify'] })

  describe('input messages', function () {
    describe('with snapshot', function () {
      beforeEach(() => { t.triggerBreakpoint() })

      it('should prune snapshot if payload is too large', function (done) {
        t.agent.on('debugger-input', ({ payload: [payload] }) => {
          const payloadSize = Buffer.byteLength(JSON.stringify(payload))
          assert.ok(
            payloadSize <= MAX_LOG_PAYLOAD_SIZE_BYTES,
            `Expected ${payloadSize} <= ${MAX_LOG_PAYLOAD_SIZE_BYTES}`
          )

          const capturesJson = JSON.stringify(payload.debugger.snapshot.captures)
          assert.match(capturesJson, /"pruned":true/)

          done()
        })

        t.agent.addRemoteConfig(t.generateRemoteConfig({
          captureSnapshot: true,
          capture: {
            // ensure we get a large snapshot
            maxCollectionSize: Number.MAX_SAFE_INTEGER,
            maxFieldCount: Number.MAX_SAFE_INTEGER,
            maxLength: Number.MAX_SAFE_INTEGER,
          },
        }))
      })
    })
  })
})
