'use strict'

const { assert } = require('chai')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({ dependencies: ['fastify'] })

  describe('input messages', function () {
    describe('with snapshot', function () {
      beforeEach(t.triggerBreakpoint)

      it('should prune snapshot if payload is too large', function (done) {
        t.agent.on('debugger-input', ({ payload: [payload] }) => {
          assert.isBelow(Buffer.byteLength(JSON.stringify(payload)), 1024 * 1024) // 1MB
          assert.notProperty(payload.debugger.snapshot, 'captures')
          assert.strictEqual(
            payload.debugger.snapshot.captureError,
            'Snapshot was too large (max allowed size is 1 MiB). ' +
            'Consider reducing the capture depth or turn off "Capture Variables" completely, ' +
            'and instead include the variables of interest directly in the message template.'
          )
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
