'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  buildSpanParentContext,
  carrierFromTraceContext,
  extractContext,
  getInstanceId,
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

    it('reads durable activity context from any argument with traceContext', () => {
      const ctx = { traceContext: { traceParent: '00-a-b-01' } }
      assert.equal(getInvocationContext([ctx], 'durable-activity'), ctx)
      assert.equal(getInvocationContext(['input', ctx], 'durable-activity'), ctx)
    })
  })

  describe('getInstanceId', () => {
    it('reads the durable instance id from traceContext attributes', () => {
      assert.equal(getInstanceId({
        traceContext: {
          attributes: {
            'durabletask.task.instance_id': 'abc123',
          },
        },
      }), 'abc123')
    })
  })

  describe('buildSpanParentContext', () => {
    it('parents activity spans to the in-flight orchestration span', () => {
      const api = require('@opentelemetry/api')
      const {
        registerOrchestrationSpan,
        unregisterOrchestrationSpan,
      } = require('../../src/helpers/otel-orchestration-registry')

      const orchestrationSpan = {
        spanContext () {
          return {
            traceId: '00000000000000000000000000000001',
            spanId: '0000000000000002',
            traceFlags: 1,
          }
        },
      }

      registerOrchestrationSpan('abc123', orchestrationSpan)

      const activityContext = {
        traceContext: {
          traceParent: '00-00000000000000000000000000000001-0000000000000003-00',
          attributes: {
            'durabletask.task.instance_id': 'abc123',
          },
        },
      }

      const parentContext = buildSpanParentContext(['input', activityContext], 'durable-activity')
      const span = api.trace.getSpan(parentContext)

      assert.equal(span, orchestrationSpan)
      unregisterOrchestrationSpan('abc123')
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
    it('returns root context when traceContext is missing', () => {
      const root = extractContext(undefined)
      assert.ok(root)
    })
  })
})
