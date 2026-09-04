'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')

require('../../../setup/mocha')

const { INCOMPLETE_REASON } = require('../../../../src/debugger/guardrail-metrics')
const { LARGE_OBJECT_SKIP_THRESHOLD } = require('../../../../src/debugger/devtools_client/snapshot/constants')
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
const { runWithHugeObject } = require(target)

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

    it('should not record a runtime error when the large object safety threshold disables the capture',
      async function () {
        const { processLocalState, fatalErrors, incomplete } = await whilePaused((callFrame) => {
          return getLocalStateForCallFrame(callFrame, DEFAULT_CAPTURE_LIMITS)
        }, { line: 12, trigger: () => runWithHugeObject(LARGE_OBJECT_SKIP_THRESHOLD + 1) })

        const state = processLocalState()

        assert.strictEqual(fatalErrors.length, 1, 'should still disable future captures for the probe')
        assert.match(fatalErrors[0].message, /exceeds the maximum number of allowed properties/)
        assert.strictEqual(state.huge.notCapturedReason, 'fieldCount')
        assert.strictEqual(incomplete.reasons, INCOMPLETE_REASON.FIELD_COUNT)
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
 * Trigger a breakpoint in the target code and run `fn` while the debuggee is paused on it.
 *
 * @template T
 * @param {(callFrame: import('inspector').Debugger.CallFrame) => Promise<T>} fn - Work to do while paused
 * @param {object} [options]
 * @param {number} [options.line] - The line to break on. Defaults to the line in `run`.
 * @param {() => void} [options.trigger] - The function hitting the breakpoint. Defaults to `run`.
 * @returns {Promise<T>}
 */
function whilePaused (fn, { line = 6, trigger } = {}) {
  return new Promise((resolve, reject) => {
    session.once('Debugger.paused', ({ params }) => {
      assert.strictEqual(params.hitBreakpoints.length, 1)
      fn(params.callFrames[0]).then(resolve, reject)
    })
    if (trigger === undefined) {
      setAndTriggerBreakpoint(target, line).catch(reject)
    } else {
      setBreakpoint(line).then(trigger).catch(reject)
    }
  })
}

/**
 * @param {number} line - The line to break on
 */
async function setBreakpoint (line) {
  await session.post('Debugger.setBreakpoint', {
    location: {
      scriptId: await require(target).scriptId,
      lineNumber: line - 1, // Beware! lineNumber is zero-indexed
    },
  })
}
