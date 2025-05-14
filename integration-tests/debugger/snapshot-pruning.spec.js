'use strict'

const { assert } = require('chai')
const { join } = require('path')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({
    env: {
      PATH_TO_UTILS: join(
        __dirname, '..', '..', 'packages', 'dd-trace', 'test', 'debugger', 'devtools_client', 'utils.js'
      )
    }
  })

  describe('input messages', function () {
    describe('with snapshot', function () {
      beforeEach(t.triggerBreakpoint)

      it('should prune snapshot if payload is too large', function (done) {
        t.agent.on('debugger-input', ({ payload: [payload] }) => {
          assert.isBelow(Buffer.byteLength(JSON.stringify(payload)), 1024 * 1024) // 1MB
          assert.deepEqual(payload.debugger.snapshot.captures, {
            lines: {
              [t.breakpoint.line]: {
                locals: {
                  notCapturedReason: 'Snapshot was too large',
                  size: 5
                }
              }
            }
          })
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
