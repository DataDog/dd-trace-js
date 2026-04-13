'use strict'

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { getDatadogTraceMetadata } = require('../src/trace-metadata')

describe('getDatadogTraceMetadata', () => {
  let tracer
  let spanContext
  let activeSpan

  beforeEach(() => {
    spanContext = {
      _trace: { started: [], origin: undefined },
      _parentId: undefined,
      toTraceId: sinon.stub().returns('12345678'),
    }
    activeSpan = {
      context: sinon.stub().returns(spanContext),
    }
    tracer = {
      scope: sinon.stub().returns({
        active: sinon.stub().returns(activeSpan),
      }),
    }
    global._ddtrace = tracer
  })

  afterEach(() => {
    delete global._ddtrace
  })

  it('should return empty object when tracer is not available', () => {
    delete global._ddtrace

    assert.deepStrictEqual(getDatadogTraceMetadata(), {})
  })

  it('should return empty object when no active span', () => {
    tracer.scope().active.returns(null)

    assert.deepStrictEqual(getDatadogTraceMetadata(), {})
  })

  it('should return empty object when origin is rum', () => {
    spanContext._trace.origin = 'rum'

    assert.deepStrictEqual(getDatadogTraceMetadata(), {})
  })

  it('should return metadata with trace id, time, and root span id', () => {
    const result = getDatadogTraceMetadata()

    assert.ok(result.other)
    assert.equal(result.other['dd-trace-id'], '12345678')
    assert.ok(result.other['dd-trace-time'])
    assert.ok(result.other['dd-root-span-id'])
  })

  it('should set _parentId directly on context when trace.started is empty', () => {
    const result = getDatadogTraceMetadata()

    assert.ok(spanContext._parentId)
    assert.equal(result.other['dd-root-span-id'], spanContext._parentId.toString(10))
  })

  it('should set _parentId on the root span in trace.started', () => {
    const rootSpanContext = { _parentId: undefined }
    const childSpanContext = { _parentId: { toString: () => '999' } }
    spanContext._trace.started = [
      { context: sinon.stub().returns(rootSpanContext) },
      { context: sinon.stub().returns(childSpanContext) },
    ]

    const result = getDatadogTraceMetadata()

    assert.ok(rootSpanContext._parentId)
    assert.equal(result.other['dd-root-span-id'], rootSpanContext._parentId.toString(10))
    // child span should not be touched
    assert.deepStrictEqual(childSpanContext._parentId, { toString: childSpanContext._parentId.toString })
  })

  it('should return cached metadata on repeated calls (idempotency)', () => {
    const first = getDatadogTraceMetadata()
    const second = getDatadogTraceMetadata()

    assert.equal(first.other['dd-root-span-id'], second.other['dd-root-span-id'])
    assert.equal(first.other['dd-trace-id'], second.other['dd-trace-id'])
  })

  it('should not re-parent the root span on repeated calls', () => {
    const rootSpanContext = { _parentId: undefined }
    spanContext._trace.started = [
      { context: sinon.stub().returns(rootSpanContext) },
    ]

    getDatadogTraceMetadata()
    const firstParentId = rootSpanContext._parentId

    getDatadogTraceMetadata()

    assert.equal(rootSpanContext._parentId, firstParentId)
  })
})
