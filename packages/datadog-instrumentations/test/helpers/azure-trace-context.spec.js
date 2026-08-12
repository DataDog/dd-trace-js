'use strict'

const assert = require('node:assert/strict')

const api = require('@opentelemetry/api')
const { describe, it } = require('mocha')

const {
  carrierFromTraceContext,
  extractContext,
  getInvocationContext,
  runWithInvocationContext,
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

    it('reads durable entity context from the first argument', () => {
      const ctx = { df: { operationName: 'MyEntity' } }
      assert.equal(getInvocationContext([ctx], 'durable-entity'), ctx)
    })

    it('reads durable activity context from the last argument when it carries traceContext', () => {
      const ctx = { traceContext: { traceParent: '00-a-b-01' }, invocationId: 'inv-1' }
      assert.equal(getInvocationContext(['input', ctx], 'durable-activity'), ctx)
    })

    it('reads durable activity context from any argument with traceContext', () => {
      const ctx = { traceContext: { traceParent: '00-a-b-01' } }
      assert.equal(getInvocationContext([ctx], 'durable-activity'), ctx)
    })

    it('reads generic orchestration context from the second argument', () => {
      const ctx = { traceContext: { traceParent: '00-a-b-01' } }
      assert.equal(getInvocationContext([{}, ctx], 'orchestration-generic'), ctx)
    })
  })

  describe('extractContext', () => {
    it('returns ROOT_CONTEXT when traceContext is missing', () => {
      assert.equal(extractContext(undefined), api.ROOT_CONTEXT)
    })
  })

  describe('runWithTraceContext', () => {
    it('runs the callback inside extracted trace context', () => {
      let called = false
      runWithTraceContext(
        { traceParent: '00-00000000000000000000000000000001-0000000000000003-01' },
        () => { called = true },
      )
      assert.equal(called, true)
    })
  })

  describe('runWithInvocationContext', () => {
    it('runs HTTP handlers with the invocation trace context', () => {
      let called = false
      runWithInvocationContext(
        [{}, { traceContext: { traceParent: '00-00000000000000000000000000000001-0000000000000003-01' } }],
        'http',
        () => { called = true },
      )
      assert.equal(called, true)
    })
  })
})
