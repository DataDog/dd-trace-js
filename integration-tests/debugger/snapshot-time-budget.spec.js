'use strict'

const assert = require('node:assert')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  describe('input messages', function () {
    describe('with snapshot under tight time budget', function () {
      context('1ms time budget', function () {
        // Force a very small time budget in ms to trigger partial snapshots
        const budget = 1
        const t = setup({
          dependencies: ['fastify'],
          env: { DD_DYNAMIC_INSTRUMENTATION_CAPTURE_TIMEOUT_MS: String(budget) }
        })

        it(
          'should include partial snapshot marked with notCapturedReason: timeout',
          // A tolerance of 15ms is used to avoid flakiness
          test({ t, maxPausedTime: budget + 15, breakpointIndex: 0, maxReferenceDepth: 5 })
        )
      })

      context('default time budget', function () {
        const budget = 15 // default time budget in ms
        const t = setup({ dependencies: ['fastify'] })

        // TODO: Make this pass
        // eslint-disable-next-line mocha/no-pending-tests
        it.skip(
          'should keep budget when state includes an object with 1 million properties',
          // A tolerance of 5ms is used to avoid flakiness
          test({ t, maxPausedTime: budget + 5, breakpointIndex: 1, maxReferenceDepth: 1 })
        )

        // TODO: Make this pass
        // eslint-disable-next-line mocha/no-pending-tests
        it.skip(
          'should keep budget when state includes an array of 1 million primitives',
          // A tolerance of 5ms is used to avoid flakiness
          test({ t, maxPausedTime: budget + 5, breakpointIndex: 2, maxReferenceDepth: 1 })
        )

        // TODO: Make this pass
        // eslint-disable-next-line mocha/no-pending-tests
        it.skip(
          'should keep budget when state includes an array of 1 million objects',
          // A tolerance of 5ms is used to avoid flakiness
          test({ t, maxPausedTime: budget + 5, breakpointIndex: 3, maxReferenceDepth: 1 })
        )
      })
    })
  })
})

function test ({ t, maxPausedTime, breakpointIndex, maxReferenceDepth }) {
  const breakpoint = t.breakpoints[breakpointIndex]

  return async function () {
    const payloadReceived = new Promise((/** @type {(value?: unknown) => void} */ resolve) => {
      t.agent.on('debugger-input', ({ payload: [{ debugger: { snapshot: { captures } } }] }) => {
        const { locals } = captures.lines[breakpoint.line]
        assert.strictEqual(
          containsTimeBudget(locals),
          true,
          'expected at least one field/element to be marked with notCapturedReason: "timeout"'
        )
        resolve()
      })
    })

    t.agent.addRemoteConfig(breakpoint.generateRemoteConfig({
      captureSnapshot: true,
      capture: { maxReferenceDepth }
    }))

    const { data } = await breakpoint.triggerBreakpoint()

    assert.ok(
      data.paused <= maxPausedTime,
      `expected thread to be paused <=${maxPausedTime}ms, but was paused for ~${data.paused}ms`
    )

    await payloadReceived
  }
}

function containsTimeBudget (node) {
  if (node == null || typeof node !== 'object') return false
  if (node.notCapturedReason === 'timeout') return true
  for (const value of Object.values(node)) {
    if (containsTimeBudget(value)) return true
  }
  return false
}
