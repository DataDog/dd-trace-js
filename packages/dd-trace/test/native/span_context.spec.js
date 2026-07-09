'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()
const { IGNORE_OTEL_ERROR } = require('../../src/constants')

require('../setup/core')

describe('NativeSpanContext', () => {
  let NativeSpanContext
  let spanContext
  let nativeSpans
  let OpCode
  let id
  let idBuffer
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
    })

    it('should set native span ID buffer from spanId (little-endian)', () => {
      // NativeSpanContext stores spanId as a LE Uint8Array so the WASM
      // change-buffer can copy it directly. id.toBuffer() returns the
      // original BE Identifier buffer; the constructor reverses it.
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id,
      })

      assert.deepStrictEqual(spanContext._nativeSpanId, leSpanId)
    })
  })

  describe('setTag', () => {
    beforeEach(() => {
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id,
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
          expect: [OpCode.SetServiceName, leSpanId, 'my-service'],
        },
        {
          name: 'resource.name → SetResourceName',
          key: 'resource.name',
          value: 'GET /api/users',
          expect: [OpCode.SetResourceName, leSpanId, 'GET /api/users'],
        },
        {
          name: 'span.type → SetType',
          key: 'span.type',
          value: 'web',
          expect: [OpCode.SetType, leSpanId, 'web'],
        },
        {
          name: 'error=true → SetError with i32 1',
          key: 'error',
          value: true,
          expect: [OpCode.SetError, leSpanId, ['i32', 1]],
        },
        {
          name: 'error=false → SetError with i32 0',
          key: 'error',
          value: false,
          expect: [OpCode.SetError, leSpanId, ['i32', 0]],
        },
        {
          name: 'string tag → SetMetaAttr',
          key: 'http.url',
          value: 'https://example.com',
          expect: [OpCode.SetMetaAttr, leSpanId, 'http.url', 'https://example.com'],
        },
        {
          name: 'number tag → SetMetricAttr',
          key: 'response.size',
          value: 1024,
          expect: [OpCode.SetMetricAttr, leSpanId, 'response.size', ['f64', 1024]],
        },
        {
          name: 'http.status_code → SetMetaAttr as string (special case)',
          key: 'http.status_code',
          value: 200,
          expect: [OpCode.SetMetaAttr, leSpanId, 'http.status_code', '200'],
        },
        {
          name: 'boolean tag → SetMetricAttr (0/1)',
          key: 'some.flag',
          value: true,
          expect: [OpCode.SetMetricAttr, leSpanId, 'some.flag', ['f64', 1]],
        },
      ]
      for (const { name, key, value, expect } of cases) {
        nativeSpans.queueOp.resetHistory()
        spanContext.setTag(key, value)
        assert.ok(nativeSpans.queueOp.called, `case "${name}" did not dispatch queueOp`)
        sinon.assert.calledWith(nativeSpans.queueOp, ...expect)
      }
    })

    it('does not queue SetError for error.type when IGNORE_OTEL_ERROR is set (otel recordException)', () => {
      // recordException() sets error.type alongside IGNORE_OTEL_ERROR=true; the
      // error bit must not flip (only setStatus(ERROR) does that).
      spanContext.setTag(IGNORE_OTEL_ERROR, true)
      nativeSpans.queueOp.resetHistory()
      spanContext.setTag('error.type', 'Error')
      const setErrorCalls = nativeSpans.queueOp.getCalls().filter(c => c.args[0] === OpCode.SetError)
      assert.strictEqual(setErrorCalls.length, 0, 'SetError must not be queued when IGNORE_OTEL_ERROR is set')
      // The meta tag is still written.
      sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetMetaAttr, leSpanId, 'error.type', 'Error')
    })

    it('queues SetError for error.type when IGNORE_OTEL_ERROR is absent', () => {
      nativeSpans.queueOp.resetHistory()
      spanContext.setTag('error.type', 'Error')
      sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetError, leSpanId, ['i32', 1])
    })

    it('routes a bare `service` tag to meta (parity with the JS formatter), not SetServiceName', () => {
      // The global config stamps a bare `service` tag on every span; the JS
      // span formatter has no `case 'service'`, so it lands in meta.service.
      // `service.name` remains the only route to the native service field.
      nativeSpans.queueOp.resetHistory()
      spanContext.setTag('service', 'test')
      sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetMetaAttr, leSpanId, 'service', 'test')
      const serviceNameCalls = nativeSpans.queueOp.getCalls().filter(c => c.args[0] === OpCode.SetServiceName)
      assert.strictEqual(serviceNameCalls.length, 0, 'bare `service` must not queue SetServiceName')
    })

    it('flips the error bit for error.message / error.stack, not just error.type (matches extractError)', () => {
      // OTel setStatus(ERROR) sets only error.message; the JS formatter flips
      // error=1 for any of error.type/message/stack.
      for (const key of ['error.message', 'error.stack']) {
        nativeSpans.queueOp.resetHistory()
        spanContext.setTag(key, 'boom')
        sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetError, leSpanId, ['i32', 1])
        sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetMetaAttr, leSpanId, key, 'boom')
      }
    })

    it('extracts error meta from a plain error-shaped object (duck-typed like util.isError)', () => {
      // gRPC tags `error` with a plain `{ message, code }` object (not an Error
      // instance). Mirror the JS formatter's extractError so error.message meta
      // is still emitted.
      nativeSpans.queueOp.resetHistory()
      spanContext.setTag('error', { message: 'foobar', code: 5 })
      sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetError, leSpanId, ['i32', 1])
      sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetMetaAttr, leSpanId, 'error.message', 'foobar')
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
        assert.deepStrictEqual(nativeSpans.queueOp.getCall(0).args[1], leSpanId)
        assert.strictEqual(nativeSpans.queueOp.getCall(0).args[2], MEASURED)
        assert.deepStrictEqual(nativeSpans.queueOp.getCall(0).args[3], ['f64', 1])
        // Second call: SetMetaAttr for span.kind
        assert.strictEqual(nativeSpans.queueOp.getCall(1).args[0], OpCode.SetMetaAttr)
        assert.deepStrictEqual(nativeSpans.queueOp.getCall(1).args[1], leSpanId)
        assert.strictEqual(nativeSpans.queueOp.getCall(1).args[2], 'span.kind')
        assert.strictEqual(nativeSpans.queueOp.getCall(1).args[3], kind)
      }

      // internal should NOT set _dd.measured — only meta tag
      nativeSpans.queueOp.resetHistory()
      spanContext.setTag('span.kind', 'internal')
      assert.strictEqual(nativeSpans.queueOp.callCount, 1)
      assert.strictEqual(nativeSpans.queueOp.getCall(0).args[0], OpCode.SetMetaAttr)
      assert.deepStrictEqual(nativeSpans.queueOp.getCall(0).args[1], leSpanId)
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

    it('should drop NaN number metrics rather than emitting NaN', () => {
      spanContext.setTag('bad.metric', Number.NaN)
      // NaN is never queued to native (matches the legacy formatter).
      for (const call of nativeSpans.queueOp.getCalls()) {
        assert.notStrictEqual(call.args[2], 'bad.metric')
      }
      sinon.assert.notCalled(nativeSpans.queueBatchMetrics)
    })

    it('should flatten plain object tag values one level', () => {
      spanContext.setTag('obj', { a: 1, b: 'x', c: true })
      const calls = nativeSpans.queueOp.getCalls().map(c => c.args)
      // number -> metric, string -> meta, boolean -> 0/1 metric, all prefixed
      assert.deepStrictEqual(
        calls.find(a => a[2] === 'obj.a'),
        [OpCode.SetMetricAttr, leSpanId, 'obj.a', ['f64', 1]]
      )
      assert.deepStrictEqual(
        calls.find(a => a[2] === 'obj.b'),
        [OpCode.SetMetaAttr, leSpanId, 'obj.b', 'x']
      )
      assert.deepStrictEqual(
        calls.find(a => a[2] === 'obj.c'),
        [OpCode.SetMetricAttr, leSpanId, 'obj.c', ['f64', 1]]
      )
      // The unflattened key itself is never emitted as [object Object].
      assert.strictEqual(calls.find(a => a[2] === 'obj'), undefined)
    })

    it('should not flatten arrays — stringified as a meta leaf', () => {
      spanContext.setTag('arr', [1, 2, 3])
      const calls = nativeSpans.queueOp.getCalls().map(c => c.args)
      assert.deepStrictEqual(
        calls.find(a => a[2] === 'arr'),
        [OpCode.SetMetaAttr, leSpanId, 'arr', '1,2,3']
      )
    })

    it('should treat Buffer and URL values as stringified meta leaves', () => {
      spanContext.setTag('buf', Buffer.from('hello'))
      spanContext.setTag('url', new URL('https://example.com/path'))
      const calls = nativeSpans.queueOp.getCalls().map(c => c.args)
      // Buffers/URLs are not flattened — they stringify to a single meta tag.
      assert.deepStrictEqual(
        calls.find(a => a[2] === 'buf'),
        [OpCode.SetMetaAttr, leSpanId, 'buf', 'hello']
      )
      assert.deepStrictEqual(
        calls.find(a => a[2] === 'url'),
        [OpCode.SetMetaAttr, leSpanId, 'url', 'https://example.com/path']
      )
      // No flattened sub-keys leaked from the URL object.
      assert.strictEqual(calls.find(a => String(a[2]).startsWith('url.')), undefined)
    })

    it('should not crash when a tag value has a throwing toString', () => {
      // Array leaf is stringified via String([...]) -> element.toString().
      const hostile = [{ toString () { throw new Error('boom') } }]
      // Must not throw into the caller; coerces to a safe placeholder.
      spanContext.setTag('hostile', hostile)
      const calls = nativeSpans.queueOp.getCalls().map(c => c.args)
      assert.deepStrictEqual(
        calls.find(a => a[2] === 'hostile'),
        [OpCode.SetMetaAttr, leSpanId, 'hostile', '[unserializable]']
      )
    })

    it('should only flatten objects one level deep', () => {
      spanContext.setTag('obj', { a: 1, b: { c: 'foo' } })
      const calls = nativeSpans.queueOp.getCalls().map(c => c.args)
      assert.deepStrictEqual(
        calls.find(a => a[2] === 'obj.a'),
        [OpCode.SetMetricAttr, leSpanId, 'obj.a', ['f64', 1]]
      )
      // The nested object stops at one level: stringified, not flattened.
      assert.deepStrictEqual(
        calls.find(a => a[2] === 'obj.b'),
        [OpCode.SetMetaAttr, leSpanId, 'obj.b', '[object Object]']
      )
      assert.strictEqual(calls.find(a => a[2] === 'obj.b.c'), undefined)
    })
  })

  describe('syncToNativeOnly (batch path)', () => {
    beforeEach(() => {
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id,
      })
    })

    it('batches meta/metrics, drops NaN, and flattens objects one level', () => {
      spanContext.syncToNativeOnly({
        'good.metric': 123,
        'bad.metric': Number.NaN,
        'a.string': 'hello',
        flag: true,
        obj: { a: 1, b: 'x' },
      })

      const metricBatch = nativeSpans.queueBatchMetrics.getCall(0).args[1]
      const metaBatch = nativeSpans.queueBatchMeta.getCall(0).args[1]

      // NaN is dropped; valid number, boolean, and flattened obj.a are metrics.
      assert.deepStrictEqual(metricBatch, [
        ['good.metric', 123],
        ['flag', 1],
        ['obj.a', 1],
      ])
      // Strings and the flattened obj.b land in meta.
      assert.deepStrictEqual(metaBatch, [
        ['a.string', 'hello'],
        ['obj.b', 'x'],
      ])
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
      })
    })

    it('should queue SetName operation', () => {
      spanContext._syncNameToNative('my-operation')

      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetName,
        leSpanId,
        'my-operation'
      )
    })
  })

  describe('OTEL semantics (DD_TRACE_OTEL_SEMANTICS_ENABLED)', () => {
    beforeEach(() => {
      nativeSpans.otelSemanticsEnabled = true
      spanContext = new NativeSpanContext(nativeSpans, { traceId: id, spanId: id })
      nativeSpans.queueOp.resetHistory()
      nativeSpans.queueBatchMeta.resetHistory()
      nativeSpans.queueBatchMetrics.resetHistory()
    })

    it('holds DD HTTP keys out of WASM across setTag, batch, and single-sync paths', () => {
      spanContext.setTag('http.url', 'http://h/p')
      spanContext.syncToNativeOnly({ 'http.method': 'GET', 'out.host': 'h' })
      spanContext.syncOneTagToNative('http.useragent', 'curl/8')

      const opKeys = nativeSpans.queueOp.getCalls().map(c => c.args[2])
      const batchKeys = nativeSpans.queueBatchMeta.getCalls().flatMap(c => c.args[1].map(([k]) => k))
      for (const k of ['http.url', 'http.method', 'out.host', 'http.useragent']) {
        assert.ok(!opKeys.includes(k) && !batchKeys.includes(k), `${k} leaked to WASM`)
      }
      // setTag still populates the JS cache (only the WASM sync is skipped) so
      // the finish-time remap can read the DD tag. (syncToNativeOnly/
      // syncOneTagToNative sync WASM only; their callers write the cache.)
      assert.strictEqual(spanContext.getTag('http.url'), 'http://h/p')
    })

    it('remaps DD HTTP tags to OTel names at finish (server span)', () => {
      spanContext.setTag('span.kind', 'server')
      spanContext.setTag('http.method', 'GET')
      spanContext.setTag('http.url', 'http://example.test:8080/users?q=1')
      spanContext.setTag('http.status_code', 200)
      nativeSpans.queueOp.resetHistory()

      spanContext.applyOtelHttpSemantics()

      const meta = nativeSpans.queueOp.getCalls()
        .filter(c => c.args[0] === OpCode.SetMetaAttr)
        .map(c => [c.args[2], c.args[3]])
      const metrics = nativeSpans.queueOp.getCalls()
        .filter(c => c.args[0] === OpCode.SetMetricAttr)
        .map(c => [c.args[2], c.args[3]])

      assert.deepStrictEqual(meta.find(([k]) => k === 'http.request.method'), ['http.request.method', 'GET'])
      assert.deepStrictEqual(meta.find(([k]) => k === 'url.path'), ['url.path', '/users'])
      assert.deepStrictEqual(meta.find(([k]) => k === 'server.address'), ['server.address', 'example.test'])
      assert.deepStrictEqual(
        metrics.find(([k]) => k === 'http.response.status_code'),
        ['http.response.status_code', ['f64', 200]]
      )
      assert.deepStrictEqual(metrics.find(([k]) => k === 'server.port'), ['server.port', ['f64', 8080]])
      // DD names are never emitted to WASM
      assert.ok(!meta.some(([k]) => k === 'http.url' || k === 'http.method' || k === 'http.status_code'))
    })

    it('applyOtelHttpSemantics is a no-op for non-HTTP spans', () => {
      spanContext.setTag('custom.tag', 'v')
      nativeSpans.queueOp.resetHistory()
      spanContext.applyOtelHttpSemantics()
      sinon.assert.notCalled(nativeSpans.queueOp)
    })
  })
})
