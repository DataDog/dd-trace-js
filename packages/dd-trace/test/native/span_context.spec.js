'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

require('../setup/core')

describe('NativeSpanContext', () => {
  let NativeSpanContext
  let spanContext
  let nativeSpans
  let OpCode
  let id
  let idBuffer
  // Slot index used for queueOp dispatch — the native side addresses
  // spans by slot number, not by their raw spanId buffer.
  let slotIndex
  // LE form of idBuffer — NativeSpanContext stores spanId as
  // a little-endian Uint8Array (matches the WASM change-buffer wire format).
  let leSpanId

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
      SetTraceOrigin: 12,
    }

    nativeSpans = {
      queueOp: sinon.stub(),
      queueBatchMeta: sinon.stub(),
      queueBatchMetrics: sinon.stub(),
    }

    // Create a mock ID object with proper 8-byte buffer (big-endian)
    idBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x07, 0x5b, 0xcd, 0x15]) // 123456789 as BE
    leSpanId = new Uint8Array([0x15, 0xcd, 0x5b, 0x07, 0x00, 0x00, 0x00, 0x00])
    slotIndex = 7
    id = {
      toString: () => '123456789',
      toBigInt: () => 123456789n,
      toBuffer: () => idBuffer,
      _buffer: idBuffer,
    }

    NativeSpanContext = proxyquire('../../src/native/span_context', {
      './index': { OpCode },
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
        slotIndex,
        trace: {
          started: [],
          finished: [],
          tags: {},
        },
      })

      assert.strictEqual(spanContext._traceId, id)
      assert.strictEqual(spanContext._spanId, id)
      assert.strictEqual(spanContext._parentId, id)
      assert.deepStrictEqual(spanContext._sampling, { priority: 1 })
      assert.deepStrictEqual(spanContext._baggageItems, { foo: 'bar' })
      assert.strictEqual(spanContext._slotIndex, slotIndex)
    })

    it('should set native span ID buffer from spanId (little-endian)', () => {
      // NativeSpanContext stores spanId as a LE Uint8Array so the WASM
      // change-buffer can copy it directly. id.toBuffer() returns the
      // original BE Identifier buffer; the constructor reverses it.
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id,
        slotIndex,
      })

      assert.deepStrictEqual(spanContext._nativeSpanId, leSpanId)
    })
  })

  describe('setTag', () => {
    beforeEach(() => {
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id,
        slotIndex,
      })
    })

    // Each row exercises the same dispatch contract; one test verifies the
    // full table to cut the per-test scaffolding cost. Single-row failures
    // still pinpoint via the `name` field in the failure message.
    it('dispatches setTag to the correct native opcode based on key + value type', () => {
      const cases = [
        {
          name: 'service.name → SetServiceName',
          key: 'service.name',
          value: 'my-service',
          expect: [OpCode.SetServiceName, slotIndex, 'my-service'],
        },
        {
          name: 'resource.name → SetResourceName',
          key: 'resource.name',
          value: 'GET /api/users',
          expect: [OpCode.SetResourceName, slotIndex, 'GET /api/users'],
        },
        {
          name: 'span.type → SetType',
          key: 'span.type',
          value: 'web',
          expect: [OpCode.SetType, slotIndex, 'web'],
        },
        {
          name: 'error=true → SetError with i32 1',
          key: 'error',
          value: true,
          expect: [OpCode.SetError, slotIndex, ['i32', 1]],
        },
        {
          name: 'error=false → SetError with i32 0',
          key: 'error',
          value: false,
          expect: [OpCode.SetError, slotIndex, ['i32', 0]],
        },
        {
          name: 'string tag → SetMetaAttr',
          key: 'http.url',
          value: 'https://example.com',
          expect: [OpCode.SetMetaAttr, slotIndex, 'http.url', 'https://example.com'],
        },
        {
          name: 'number tag → SetMetricAttr',
          key: 'response.size',
          value: 1024,
          expect: [OpCode.SetMetricAttr, slotIndex, 'response.size', ['f64', 1024]],
        },
        {
          name: 'http.status_code → SetMetaAttr as string (special case)',
          key: 'http.status_code',
          value: 200,
          expect: [OpCode.SetMetaAttr, slotIndex, 'http.status_code', '200'],
        },
        {
          name: 'boolean tag → SetMetricAttr (0/1)',
          key: 'some.flag',
          value: true,
          expect: [OpCode.SetMetricAttr, slotIndex, 'some.flag', ['f64', 1]],
        },
      ]
      for (const { name, key, value, expect } of cases) {
        nativeSpans.queueOp.resetHistory()
        spanContext.setTag(key, value)
        assert.ok(nativeSpans.queueOp.called, `case "${name}" did not dispatch queueOp`)
        sinon.assert.calledWith(nativeSpans.queueOp, ...expect)
      }
    })

    it('should set _dd.measured when span.kind is non-internal', () => {
      // span.kind:client, server, producer, consumer → _dd.measured = 1
      // span.kind:internal → no _dd.measured
      // In both cases, span.kind itself is always stored as meta
      const MEASURED = '_dd.measured'

      for (const kind of ['client', 'server', 'producer', 'consumer']) {
        nativeSpans.queueOp.resetHistory()
        spanContext.setTag('span.kind', kind)
        // First call: SetMetricAttr for _dd.measured
        assert.strictEqual(nativeSpans.queueOp.callCount, 2)
        assert.strictEqual(nativeSpans.queueOp.getCall(0).args[0], OpCode.SetMetricAttr)
        assert.strictEqual(nativeSpans.queueOp.getCall(0).args[1], slotIndex)
        assert.strictEqual(nativeSpans.queueOp.getCall(0).args[2], MEASURED)
        assert.deepStrictEqual(nativeSpans.queueOp.getCall(0).args[3], ['f64', 1])
        // Second call: SetMetaAttr for span.kind
        assert.strictEqual(nativeSpans.queueOp.getCall(1).args[0], OpCode.SetMetaAttr)
        assert.strictEqual(nativeSpans.queueOp.getCall(1).args[1], slotIndex)
        assert.strictEqual(nativeSpans.queueOp.getCall(1).args[2], 'span.kind')
        assert.strictEqual(nativeSpans.queueOp.getCall(1).args[3], kind)
      }

      // internal should NOT set _dd.measured — only meta tag
      nativeSpans.queueOp.resetHistory()
      spanContext.setTag('span.kind', 'internal')
      assert.strictEqual(nativeSpans.queueOp.callCount, 1)
      assert.strictEqual(nativeSpans.queueOp.getCall(0).args[0], OpCode.SetMetaAttr)
      assert.strictEqual(nativeSpans.queueOp.getCall(0).args[1], slotIndex)
      assert.strictEqual(nativeSpans.queueOp.getCall(0).args[2], 'span.kind')
      assert.strictEqual(nativeSpans.queueOp.getCall(0).args[3], 'internal')
    })

    it('should store tag in JS cache', () => {
      spanContext.setTag('test.key', 'test-value')

      assert.strictEqual(spanContext.getTag('test.key'), 'test-value')
    })

    it('should not sync undefined or null values', () => {
      spanContext.setTag('test.key', undefined)
      spanContext.setTag('test.key', null)
      sinon.assert.notCalled(nativeSpans.queueOp)
    })
  })

  // getTag/hasTag/deleteTag/getTags inherit from DatadogSpanContext and are
  // covered by `packages/dd-trace/test/opentracing/span_context.spec.js`. The
  // native subclass adds native-storage sync on setTag (tested above) but
  // doesn't override the read-side accessors, so we don't re-test them here.

  describe('_syncNameToNative', () => {
    beforeEach(() => {
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id,
        slotIndex,
      })
    })

    it('should queue SetName operation', () => {
      spanContext._syncNameToNative('my-operation')

      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetName,
        slotIndex,
        'my-operation'
      )
    })
  })
})
