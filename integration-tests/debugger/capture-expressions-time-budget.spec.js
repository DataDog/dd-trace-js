'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')

const { assertObjectContains } = require('../helpers')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  describe('captureExpressions', function () {
    describe('deadline behavior', function () {
      const t = setup({
        testApp: 'target-app/time-budget.js',
        dependencies: ['fastify'],
        env: { DD_DYNAMIC_INSTRUMENTATION_CAPTURE_TIMEOUT_MS: '15' },
      })

      beforeEach(() => { t.triggerBreakpoint() })

      async function captureExpressionsSnapshot (captureExpressions, additionalConfig = {}) {
        t.agent.addRemoteConfig(t.generateRemoteConfig({
          captureExpressions,
          ...additionalConfig,
        }))

        const [{ payload: [{ debugger: { snapshot } }] }] = await once(t.agent, 'debugger-input')

        return snapshot
      }

      it('adds notCapturedReason for expressions after deadline is reached', async function () {
        const snapshot = await captureExpressionsSnapshot([
          // First expression: simple primitive variable (should succeed quickly before deadline)
          { name: 'capturedStart', expr: { dsl: 'start', json: { ref: 'start' } } },
          // Second expression: deeply nested large object (should trigger deadline during property collection)
          { name: 'capturedObj', expr: { dsl: 'obj', json: { ref: 'obj' } }, capture: { maxReferenceDepth: 5 } },
          // Remaining expressions: simple variables that won't be evaluated due to deadline
          { name: 'timedOutObj1', expr: { dsl: 'obj', json: { ref: 'obj' } } },
          { name: 'timedOutStart', expr: { dsl: 'start', json: { ref: 'start' } } },
          { name: 'timedOutObj2', expr: { dsl: 'obj', json: { ref: 'obj' } } },
        ])

        const { captureExpressions } = snapshot.captures.lines[t.breakpoint.line]

        assert.deepStrictEqual(
          Object.keys(captureExpressions),
          ['capturedStart', 'capturedObj', 'timedOutObj1', 'timedOutStart', 'timedOutObj2']
        )

        // First expression should always be captured (simple primitive evaluated before deadline)
        assert.deepStrictEqual(captureExpressions.capturedStart, {
          type: 'bigint',
          value: String(captureExpressions.capturedStart.value),
        })

        // Second expression (capturedObj) should be present but may have incomplete properties due to deadline
        // Verify it captured at least some properties before timing out
        assertObjectContains(captureExpressions.capturedObj, {
          type: 'Object',
          fields: {
            p0: { type: 'Object' },
            p1: { type: 'Array' },
            p2: { type: 'Map' },
          },
        })

        // Verify that the deadline was reached during capturedObj's property collection
        // by checking if any nested property has notCapturedReason: 'timeout'
        assert.ok(
          JSON.stringify(captureExpressions.capturedObj).includes('"notCapturedReason":"timeout"'),
          'Expected capturedObj to contain notCapturedReason: "timeout" in nested properties due to deadline'
        )

        // Remaining expressions should all have notCapturedReason: 'timeout'
        const { capturedStart, capturedObj, ...timedOutExpressions } = captureExpressions
        assert.deepStrictEqual(timedOutExpressions, {
          timedOutObj1: { notCapturedReason: 'timeout' },
          timedOutStart: { notCapturedReason: 'timeout' },
          timedOutObj2: { notCapturedReason: 'timeout' },
        })
      })
    })
  })
})
