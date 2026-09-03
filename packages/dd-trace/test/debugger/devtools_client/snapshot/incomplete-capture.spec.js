'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')

require('../../../setup/mocha')

const { INCOMPLETE_REASON } = require('../../../../src/debugger/guardrail-metrics')
const {
  DEFAULT_CAPTURE_LIMITS,
  enable,
  evaluateCaptureExpressions,
  getLocalStateForCallFrame,
  getTargetCodePath,
  session,
  setAndTriggerBreakpoint,
  teardown,
} = require('./utils')

const target = getTargetCodePath(__filename)

// A deadline that has already passed, so the collector stops at the first opportunity
const EXPIRED_DEADLINE_NS = 0n

describe('debugger -> devtools client -> snapshot incomplete capture reasons', function () {
  beforeEach(enable(__filename))

  afterEach(teardown)

  describe('getLocalStateForCallFrame', function () {
    it('should not record any reason for a complete capture', async function () {
      const { processLocalState, incomplete } = await whilePaused((callFrame) => {
        return getLocalStateForCallFrame(callFrame, DEFAULT_CAPTURE_LIMITS)
      })

      processLocalState()

      assert.strictEqual(incomplete.reasons, 0)
    })

    it('should only populate the reasons once the local state has been processed', async function () {
      const { processLocalState, incomplete } = await whilePaused((callFrame) => {
        return getLocalStateForCallFrame(callFrame, { ...DEFAULT_CAPTURE_LIMITS, maxReferenceDepth: 1 })
      })

      assert.strictEqual(incomplete.reasons, 0)
      processLocalState()
      assert.strictEqual(incomplete.reasons, INCOMPLETE_REASON.DEPTH)
    })

    it('should record a timeout when the capture deadline is reached', async function () {
      const { processLocalState, incomplete } = await whilePaused((callFrame) => {
        return getLocalStateForCallFrame(callFrame, DEFAULT_CAPTURE_LIMITS, EXPIRED_DEADLINE_NS)
      })

      const state = processLocalState()

      assert.deepStrictEqual(state.nested, { type: 'Object', notCapturedReason: 'timeout' })
      assert.strictEqual(incomplete.reasons, INCOMPLETE_REASON.TIMEOUT)
    })
  })

  describe('evaluateCaptureExpressions', function () {
    it('should not record any reason for a complete capture', async function () {
      const { processCaptureExpressions, incomplete } = await whilePaused((callFrame) => {
        return evaluateCaptureExpressions(callFrame, [
          { name: 'nested', expression: 'nested', limits: DEFAULT_CAPTURE_LIMITS },
        ])
      })

      processCaptureExpressions()

      assert.strictEqual(incomplete.reasons, 0)
    })

    it('should record the enforced capture limits', async function () {
      const { processCaptureExpressions, incomplete } = await whilePaused((callFrame) => {
        return evaluateCaptureExpressions(callFrame, [
          { name: 'nested', expression: 'nested', limits: { ...DEFAULT_CAPTURE_LIMITS, maxReferenceDepth: 1 } },
        ])
      })

      const captured = processCaptureExpressions()

      assert.deepStrictEqual(captured.nested, {
        type: 'Object',
        fields: { foo: { type: 'Object', notCapturedReason: 'depth' } },
      })
      assert.strictEqual(incomplete.reasons, INCOMPLETE_REASON.DEPTH)
    })

    it('should record a timeout when the capture deadline is reached', async function () {
      const { processCaptureExpressions, incomplete } = await whilePaused((callFrame) => {
        return evaluateCaptureExpressions(callFrame, [
          { name: 'nested', expression: 'nested', limits: DEFAULT_CAPTURE_LIMITS },
          { name: 'skipped', expression: 'nested', limits: DEFAULT_CAPTURE_LIMITS },
        ], EXPIRED_DEADLINE_NS)
      })

      const captured = processCaptureExpressions()

      assert.deepStrictEqual(captured.skipped, { notCapturedReason: 'timeout' })
      assert.strictEqual(incomplete.reasons, INCOMPLETE_REASON.TIMEOUT)
    })
  })
})

/**
 * Trigger the breakpoint in the target code and run `fn` while the debuggee is paused on it.
 *
 * @template T
 * @param {(callFrame: import('inspector').Debugger.CallFrame) => Promise<T>} fn - Work to do while paused
 * @returns {Promise<T>}
 */
function whilePaused (fn) {
  return new Promise((resolve, reject) => {
    session.once('Debugger.paused', ({ params }) => {
      assert.strictEqual(params.hitBreakpoints.length, 1)
      fn(params.callFrames[0]).then(resolve, reject)
    })
    setAndTriggerBreakpoint(target, 6).catch(reject)
  })
}
