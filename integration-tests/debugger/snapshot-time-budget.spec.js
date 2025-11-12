'use strict'

const assert = require('node:assert')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  // Force a very small time budget in ms to trigger partial snapshots
  const t = setup({
    dependencies: ['fastify'],
    env: { DD_DYNAMIC_INSTRUMENTATION_CAPTURE_TIMEOUT_MS: '1' }
  })

  describe('input messages', function () {
    describe('with snapshot under tight time budget', function () {
      beforeEach(t.triggerBreakpoint)

      it('should include partial snapshot marked with notCapturedReason: timeout', function (done) {
        t.agent.on('debugger-input', ({ payload: [{ debugger: { snapshot: { captures } } }] }) => {
          const { locals } = captures.lines[t.breakpoint.line]
          assert.strictEqual(
            containsTimeBudget(locals),
            true,
            'expected at least one field/element to be marked with notCapturedReason: "timeout"'
          )
          done()
        })

        t.agent.addRemoteConfig(t.generateRemoteConfig({
          captureSnapshot: true,
          capture: { maxReferenceDepth: 5 }
        }))
      })
    })
  })
})

function containsTimeBudget (node) {
  if (node == null || typeof node !== 'object') return false
  if (node.notCapturedReason === 'timeout') return true
  for (const value of Object.values(node)) {
    if (containsTimeBudget(value)) return true
  }
  return false
}
