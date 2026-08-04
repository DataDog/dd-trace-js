'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  carrierFromTraceContext,
  extractContext,
  getInvocationContext,
  runWithTraceContext,
} = require('../../src/helpers/azure-trace-context')

describe('azure-trace-context', () => {
  describe('carrierFromTraceContext', () => {
    it('returns null when traceContext is missing', () => {
      assert.equal(carrierFromTraceContext(undefined), null)
    })

    it('maps traceParent and traceState to W3C carrier keys', () => {
      assert.deepEqual(
        carrierFromTraceContext({
          traceParent: '00-abc-def-01',
          traceState: 'dd=s:1',
        }),
        {
          traceparent: '00-abc-def-01',
          tracestate: 'dd=s:1',
        },
      )
    })

    it('returns null when no W3C fields are present', () => {
      assert.equal(carrierFromTraceContext({}), null)
    })
  })

  describe('getInvocationContext', () => {
    it('reads HTTP invocation context from the second argument', () => {
      const ctx = { traceContext: { traceParent: '00-a-b-01' } }
      assert.equal(getInvocationContext([{}, ctx], 'http'), ctx)
    })

    it('reads durable orchestration context from the first argument', () => {
      const ctx = { df: { isReplaying: false } }
      assert.equal(getInvocationContext([ctx], 'durable-orchestration'), ctx)
    })

    it('reads durable activity context from the last argument', () => {
      const ctx = { traceContext: { traceParent: '00-a-b-01' } }
      assert.equal(getInvocationContext(['input', ctx], 'durable-activity'), ctx)
    })
  })

  describe('runWithTraceContext', () => {
    it('runs the callback when traceContext is missing', () => {
      assert.equal(runWithTraceContext(undefined, () => 42), 42)
    })

    it('runs the callback when traceContext is present', () => {
      const result = runWithTraceContext(
        { traceParent: '00-00000000000000000000000000000000-0000000000000000-01' },
        () => 'ok',
      )
      assert.equal(result, 'ok')
    })
  })

  describe('extractContext', () => {
    it('returns active context when traceContext is missing', () => {
      const active = extractContext(undefined)
      assert.ok(active)
    })
  })
})
