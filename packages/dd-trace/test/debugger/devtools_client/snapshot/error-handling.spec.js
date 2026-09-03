'use strict'

require('../../../setup/mocha')

const assert = require('node:assert')
const { inspect } = require('node:util')
const sinon = require('sinon')

const { INCOMPLETE_REASON } = require('../../../../src/debugger/guardrail-metrics')
const { getLocalStateForCallFrame, evaluateCaptureExpressions, DEFAULT_CAPTURE_LIMITS, session } = require('./utils')

describe('debugger -> devtools client -> snapshot', function () {
  let sessionPostStub

  afterEach(function () {
    if (sessionPostStub) {
      sessionPostStub.restore()
      sessionPostStub = null
    }
  })

  describe('getLocalStateForCallFrame', function () {
    describe('error handling', function () {
      it('should generate a notCapturedReason if getRuntimeObject rejects', async function () {
        const mockCallFrame = {
          scopeChain: [{ type: 'local', object: { objectId: 'test-object-id' } }],
        }

        // Mock session.post to throw an error for Runtime.getProperties
        sessionPostStub = sinon.stub(session, 'post')
        sessionPostStub.withArgs('Runtime.getProperties').rejects(new Error('Protocol error'))

        const { fatalErrors, incomplete, processLocalState } = await getLocalStateForCallFrame(
          mockCallFrame,
          DEFAULT_CAPTURE_LIMITS
        )

        assert.strictEqual(fatalErrors.length, 1)
        assert.strictEqual(incomplete.reasons, INCOMPLETE_REASON.RUNTIME_ERROR)

        for (const error of fatalErrors) {
          assert.ok(error instanceof Error)
          assert.strictEqual(
            error.message,
            'Error getting local state for closure scope (type: local). ' +
            'Future snapshots for existing probes in this location will be skipped until the probes are re-applied'
          )

          const { cause } = error
          assert.ok(cause instanceof Error)
          assert.strictEqual(cause.message, 'Protocol error')
        }

        assert.deepStrictEqual(processLocalState(), {})
      })
    })
  })

  describe('evaluateCaptureExpressions', function () {
    describe('error handling', function () {
      const mockCallFrame = { callFrameId: 'frame-123' }

      it('should return fatalErrors when session.post throws an error', async function () {
        const expressions = [{
          name: 'testExpr',
          expression: 'someVariable',
          limits: DEFAULT_CAPTURE_LIMITS,
        }]

        sessionPostStub = sinon.stub(session, 'post')
        sessionPostStub.withArgs('Debugger.evaluateOnCallFrame').rejects(new Error('boom!'))

        const result = await evaluateCaptureExpressions(mockCallFrame, expressions)

        assert.strictEqual(result.fatalErrors.length, 1)
        assert.strictEqual(result.evaluationErrors.length, 0)
        assert.strictEqual(result.incomplete.reasons, INCOMPLETE_REASON.RUNTIME_ERROR)

        const error = result.fatalErrors[0]
        assert.ok(error instanceof Error)
        assert.strictEqual(
          error.message,
          'Error capturing expression "testExpr". ' +
          'Capture expressions for this probe will be skipped until the probe is re-applied'
        )

        const { cause } = error
        assert.ok(cause instanceof Error)
        assert.strictEqual(cause.message, 'boom!')

        // processCaptureExpressions should return empty object since no expressions succeeded
        assert.deepStrictEqual(result.processCaptureExpressions(), {})
      })

      it('should still capture the other expressions that do not throw errors', async function () {
        const expressions = [{
          name: 'firstExpr',
          expression: 'variable1',
          limits: DEFAULT_CAPTURE_LIMITS,
        }, {
          name: 'secondExpr',
          expression: 'variable2',
          limits: DEFAULT_CAPTURE_LIMITS,
        }, {
          name: 'thirdExpr',
          expression: 'variable3',
          limits: DEFAULT_CAPTURE_LIMITS,
        }]

        sessionPostStub = sinon.stub(session, 'post')
        sessionPostStub.onCall(0).resolves({ result: { type: 'string', value: 'hello' } })
        sessionPostStub.onCall(1).rejects(new Error('Second error'))
        sessionPostStub.onCall(2).resolves({ result: { type: 'boolean', value: true } })

        const result = await evaluateCaptureExpressions(mockCallFrame, expressions)

        // Should have one fatal error
        assert.strictEqual(result.fatalErrors.length, 1)
        assert.ok(
          result.fatalErrors[0].message.includes('secondExpr'),
          `Got: ${inspect(result.fatalErrors[0].message)}`
        )

        const captured = result.processCaptureExpressions()

        // Should have captured first and third expressions
        assert.ok('firstExpr' in captured)
        assert.strictEqual(captured.firstExpr.type, 'string')
        assert.strictEqual(captured.firstExpr.value, 'hello')
        assert.ok('thirdExpr' in captured)
        assert.strictEqual(captured.thirdExpr.type, 'boolean')
        assert.strictEqual(captured.thirdExpr.value, 'true')

        // Second expression should not be in captured results
        assert.ok(!('secondExpr' in captured))
      })

      it('should report an expression that exceeds the evaluation time budget', async function () {
        const expressions = [{
          name: 'slowExpr',
          expression: 'slow',
          limits: DEFAULT_CAPTURE_LIMITS,
        }, {
          name: 'fastExpr',
          expression: 'fast',
          limits: DEFAULT_CAPTURE_LIMITS,
        }]

        let nowNs = 0n
        const hrtime = sinon.stub(process.hrtime, 'bigint').callsFake(() => nowNs)
        sessionPostStub = sinon.stub(session, 'post')
        sessionPostStub.onCall(0).callsFake(() => {
          nowNs += 10_000_001n
          return Promise.resolve({ result: { type: 'string', value: 'slow' } })
        })
        sessionPostStub.onCall(1).callsFake(() => {
          nowNs += 10_000_000n
          return Promise.resolve({ result: { type: 'string', value: 'fast' } })
        })

        let result
        try {
          result = await evaluateCaptureExpressions(mockCallFrame, expressions, undefined, 10_000_000n)
        } finally {
          hrtime.restore()
        }

        assert.strictEqual(result.timedOut, true)
        assert.strictEqual(result.incomplete.reasons, INCOMPLETE_REASON.TIMEOUT)
        assert.deepStrictEqual(result.evaluationErrors, [{
          expr: 'slowExpr',
          message: 'Expression evaluation exceeded its time budget of 10ms',
        }])
        assert.deepStrictEqual(result.processCaptureExpressions(), {
          slowExpr: { type: 'string', value: 'slow' },
          fastExpr: { type: 'string', value: 'fast' },
        }, 'should still capture the results')
      })

      it('should distinguish between evaluationErrors and fatalErrors', async function () {
        const expressions = [{
          name: 'undefinedVar',
          expression: 'doesNotExist',
          limits: DEFAULT_CAPTURE_LIMITS,
        }, {
          name: 'protocolError',
          expression: 'something',
          limits: DEFAULT_CAPTURE_LIMITS,
        }]

        sessionPostStub = sinon.stub(session, 'post')
        // First call returns evaluation exception (transient error)
        sessionPostStub.onCall(0).resolves({
          exceptionDetails: {
            exception: {
              description: 'ReferenceError: doesNotExist is not defined\n    at eval...',
            },
          },
        })
        // Second call throws protocol error (fatal error)
        sessionPostStub.onCall(1).rejects(new Error('boom!'))

        const result = await evaluateCaptureExpressions(mockCallFrame, expressions)

        // Should have one evaluation error (transient)
        assert.strictEqual(result.timedOut, false)
        assert.deepStrictEqual(result.evaluationErrors, [{
          expr: 'undefinedVar',
          message: 'ReferenceError: doesNotExist is not defined',
        }])

        // Should have one fatal error (permanent)
        assert.strictEqual(result.fatalErrors.length, 1)
        assert.strictEqual(
          result.fatalErrors[0].message,
          'Error capturing expression "protocolError". ' +
          'Capture expressions for this probe will be skipped until the probe is re-applied'
        )

        // Both count as a runtime error once
        assert.strictEqual(result.incomplete.reasons, INCOMPLETE_REASON.RUNTIME_ERROR)
      })
    })
  })
})
