'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

describe('NativeSpanContext', () => {
  let NativeSpanContext
  let spanContext
  let nativeSpans
  let OpCode
  let id

  beforeEach(() => {
    OpCode = {
      SetMetaAttr: 1,
      SetMetricAttr: 2,
      SetServiceName: 3,
      SetResourceName: 4,
      SetName: 5,
      SetType: 6,
      SetError: 7,
      SetTraceMetaAttr: 10,
      SetTraceMetricsAttr: 11,
      SetTraceOrigin: 12
    }

    nativeSpans = {
      queueOp: sinon.stub()
    }

    // Create a mock ID object
    id = {
      toString: () => '123456789',
      toBigInt: () => 123456789n,
      toBuffer: () => Buffer.from('123456789')
    }

    NativeSpanContext = proxyquire('../../src/native/span_context', {
      './index': { OpCode }
    })
  })

  describe('constructor', () => {
    it('should initialize with provided properties', () => {
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id,
        parentId: id,
        sampling: { priority: 1 },
        baggageItems: { foo: 'bar' },
        trace: {
          started: [],
          finished: [],
          tags: {}
        }
      })

      assert.strictEqual(spanContext._traceId, id)
      assert.strictEqual(spanContext._spanId, id)
      assert.strictEqual(spanContext._parentId, id)
      assert.deepStrictEqual(spanContext._sampling, { priority: 1 })
      assert.deepStrictEqual(spanContext._baggageItems, { foo: 'bar' })
    })

    it('should set native span ID from spanId', () => {
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id
      })

      assert.strictEqual(spanContext._nativeSpanId, 123456789n)
    })

    it('should create tags proxy', () => {
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id
      })

      // Tags should be available
      assert.ok(spanContext._tags !== undefined)
    })
  })

  describe('tags proxy', () => {
    beforeEach(() => {
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id
      })
    })

    it('should sync service.name to native via SetServiceName immediately', () => {
      spanContext._tags['service.name'] = 'my-service'

      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetServiceName,
        123456789n,
        'my-service'
      )
    })

    it('should sync resource.name to native via SetResourceName immediately', () => {
      spanContext._tags['resource.name'] = 'GET /api/users'

      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetResourceName,
        123456789n,
        'GET /api/users'
      )
    })

    it('should sync span.type to native via SetType immediately', () => {
      spanContext._tags['span.type'] = 'web'

      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetType,
        123456789n,
        'web'
      )
    })

    it('should sync error to native via SetError immediately', () => {
      spanContext._tags.error = true

      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetError,
        123456789n,
        ['i32', 1]
      )
    })

    it('should sync error=false to native as 0', () => {
      spanContext._tags.error = false

      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetError,
        123456789n,
        ['i32', 0]
      )
    })

    it('should sync string tags via SetMetaAttr immediately', () => {
      spanContext._tags['http.url'] = 'https://example.com'

      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetMetaAttr,
        123456789n,
        'http.url',
        'https://example.com'
      )
    })

    it('should sync number tags via SetMetricAttr immediately', () => {
      spanContext._tags['http.status_code'] = 200

      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetMetricAttr,
        123456789n,
        'http.status_code',
        ['f64', 200]
      )
    })

    it('should sync boolean tags as metrics (0/1)', () => {
      spanContext._tags['some.flag'] = true

      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetMetricAttr,
        123456789n,
        'some.flag',
        ['f64', 1]
      )
    })

    it('should read tags from cache', () => {
      spanContext._tags['test.key'] = 'test-value'
      const value = spanContext._tags['test.key']

      assert.strictEqual(value, 'test-value')
    })

    it('should support tag deletion', () => {
      spanContext._tags['test.key'] = 'test-value'
      delete spanContext._tags['test.key']

      assert.strictEqual(spanContext._tags['test.key'], undefined)
    })

    it('should support "in" operator', () => {
      spanContext._tags['test.key'] = 'test-value'

      assert.ok('test.key' in spanContext._tags)
      assert.ok(!('missing.key' in spanContext._tags))
    })

    it('should support Object.keys()', () => {
      spanContext._tags['key1'] = 'value1'
      spanContext._tags['key2'] = 'value2'

      const keys = Object.keys(spanContext._tags)
      assert.ok(keys.includes('key1'))
      assert.ok(keys.includes('key2'))
    })

    it('should not sync undefined values', () => {
      spanContext._tags['test.key'] = undefined

      // Should not call queueOp for undefined
      sinon.assert.notCalled(nativeSpans.queueOp)
    })

    it('should not sync null values', () => {
      spanContext._tags['test.key'] = null

      // Should not call queueOp for null
      sinon.assert.notCalled(nativeSpans.queueOp)
    })
  })

  describe('_syncNameToNative', () => {
    beforeEach(() => {
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id
      })
    })

    it('should queue SetName operation', () => {
      spanContext._syncNameToNative('my-operation')

      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetName,
        123456789n,
        'my-operation'
      )
    })
  })

  describe('_setTraceTag', () => {
    beforeEach(() => {
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id,
        trace: {
          started: [],
          finished: [],
          tags: {}
        }
      })
    })

    it('should set trace tag in JS trace object', () => {
      spanContext._setTraceTag('_dd.p.tid', 'abc123')

      assert.strictEqual(spanContext._trace.tags['_dd.p.tid'], 'abc123')
    })

    it('should sync string trace tags via SetTraceMetaAttr', () => {
      spanContext._setTraceTag('_dd.p.tid', 'abc123')

      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetTraceMetaAttr,
        123456789n,
        '_dd.p.tid',
        'abc123'
      )
    })

    it('should sync numeric trace tags via SetTraceMetricsAttr', () => {
      spanContext._setTraceTag('_sampling_priority_v1', 2)

      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetTraceMetricsAttr,
        123456789n,
        '_sampling_priority_v1',
        ['f64', 2]
      )
    })
  })

  describe('_setTraceOrigin', () => {
    beforeEach(() => {
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id
      })
    })

    it('should queue SetTraceOrigin operation', () => {
      spanContext._setTraceOrigin('synthetics')

      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetTraceOrigin,
        123456789n,
        'synthetics'
      )
    })
  })

  describe('nativeSpanId getter', () => {
    it('should return the native span ID', () => {
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id
      })

      assert.strictEqual(spanContext.nativeSpanId, 123456789n)
    })
  })

  describe('inheritance from DatadogSpanContext', () => {
    beforeEach(() => {
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id
      })
    })

    it('should have toTraceId method', () => {
      assert.ok(typeof spanContext.toTraceId === 'function')
    })

    it('should have toSpanId method', () => {
      assert.ok(typeof spanContext.toSpanId === 'function')
    })
  })
})
