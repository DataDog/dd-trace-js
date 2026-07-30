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
      queueBatchMetaFlat: sinon.stub(),
      queueBatchMetricsFlat: sinon.stub(),
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

  describe('markExported', () => {
    beforeEach(() => {
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id,
      })
    })

    it('does not queue native ops for a span native storage has already dropped', () => {
      // `applyOtelHttpSemantics` returns early unless http.method/http.url is
      // present, so these tags are what make it a real exercise of the
      // exported guard rather than the non-HTTP early return.
      spanContext.setTag('span.kind', 'server')
      spanContext.setTag('http.method', 'GET')
      spanContext.setTag('http.url', 'http://h/p')
      spanContext.markExported()
      nativeSpans.queueOp.resetHistory()
      nativeSpans.queueBatchMetaFlat.resetHistory()
      nativeSpans.queueBatchMetricsFlat.resetHistory()

      spanContext.applyOtelHttpSemantics()
      spanContext.setTag('peer.service', 'db')
      spanContext.syncFinalTagsToNative({ name: 'n', resource: 'r', error: 0, meta: {}, metrics: {} })

      sinon.assert.notCalled(nativeSpans.queueOp)
      sinon.assert.notCalled(nativeSpans.queueBatchMetaFlat)
      sinon.assert.notCalled(nativeSpans.queueBatchMetricsFlat)
      // The JS tag cache stays readable for in-process consumers.
      assert.strictEqual(spanContext.getTag('http.url'), 'http://h/p')
      assert.strictEqual(spanContext.getTag('peer.service'), 'db')
    })
  })

  describe('tag cache and final native sync', () => {
    beforeEach(() => {
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id,
      })
    })

    it('keeps setTag JS-cache-only before the final sync', () => {
      spanContext.setTag('dynamic.tag', 'first')
      spanContext.setTag('flag', true)

      assert.strictEqual(spanContext.getTag('dynamic.tag'), 'first')
      assert.strictEqual(spanContext.getTag('flag'), true)
      sinon.assert.notCalled(nativeSpans.queueOp)
      sinon.assert.notCalled(nativeSpans.queueBatchMetaFlat)
      sinon.assert.notCalled(nativeSpans.queueBatchMetricsFlat)
    })

    it('queues one final formatted snapshot to native storage', () => {
      spanContext.syncFinalTagsToNative({
        name: 'operation',
        resource: 'resource',
        service: 'svc',
        type: 'web',
        error: 1,
        meta: { 'meta.key': 'value', language: 'javascript' },
        metrics: { 'metric.key': 2, process_id: 123 },
      })

      sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetName, leSpanId, 'operation')
      sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetResourceName, leSpanId, 'resource')
      sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetServiceName, leSpanId, 'svc')
      sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetType, leSpanId, 'web')
      sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetError, leSpanId, ['i32', 1])
      sinon.assert.calledWith(
        nativeSpans.queueBatchMetaFlat,
        leSpanId,
        ['meta.key', 'value', 'language', 'javascript']
      )
      sinon.assert.calledWith(
        nativeSpans.queueBatchMetricsFlat,
        leSpanId,
        ['metric.key', 2, 'process_id', 123]
      )
    })

    it('does not queue the final snapshot after export', () => {
      spanContext.markExported()
      spanContext.syncFinalTagsToNative({
        name: 'operation',
        resource: 'resource',
        error: 0,
        meta: { k: 'v' },
        metrics: { n: 1 },
      })

      sinon.assert.notCalled(nativeSpans.queueOp)
      sinon.assert.notCalled(nativeSpans.queueBatchMetaFlat)
      sinon.assert.notCalled(nativeSpans.queueBatchMetricsFlat)
    })
  })

  // setTag/getTag/hasTag/deleteTag/getTags all inherit from DatadogSpanContext
  // and are covered by `packages/dd-trace/test/opentracing/span_context.spec.js`.
  // The native subclass doesn't override them: tag writes stay JS-cache-only
  // until the finish-time snapshot (tested above).
  //
  // The span name likewise never gets its own WASM op during a span's life
  // (`_setNameLocal` writes only the Symbol-keyed slot). It reaches WASM through
  // `queueCreateSpan` at start and through `syncFinalTagsToNative`'s SetName op
  // at finish, asserted by 'queues one final formatted snapshot to native
  // storage' above.

  describe('OTEL semantics (DD_TRACE_OTEL_SEMANTICS_ENABLED)', () => {
    beforeEach(() => {
      nativeSpans.otelSemanticsEnabled = true
      spanContext = new NativeSpanContext(nativeSpans, { traceId: id, spanId: id })
      nativeSpans.queueOp.resetHistory()
      nativeSpans.queueBatchMetaFlat.resetHistory()
      nativeSpans.queueBatchMetricsFlat.resetHistory()
    })

    it('holds DD HTTP keys out of the final WASM snapshot', () => {
      spanContext.setTag('http.url', 'http://h/p')
      spanContext.setTag('http.method', 'GET')

      spanContext.syncFinalTagsToNative({
        name: 'n',
        resource: 'r',
        error: 0,
        meta: {
          'http.url': 'http://h/p',
          'http.method': 'GET',
          'out.host': 'h',
          'http.useragent': 'curl/8',
          'peer.service': 'db',
        },
        metrics: { 'network.destination.port': 8080, 'metric.key': 3 },
      })

      const evenItems = calls => calls.flatMap(c => c.args[1].filter((_, i) => i % 2 === 0))
      const metaKeys = evenItems(nativeSpans.queueBatchMetaFlat.getCalls())
      const metricKeys = evenItems(nativeSpans.queueBatchMetricsFlat.getCalls())
      const opKeys = nativeSpans.queueOp.getCalls().map(c => c.args[2])
      for (const k of ['http.url', 'http.method', 'out.host', 'http.useragent', 'network.destination.port']) {
        assert.ok(!metaKeys.includes(k) && !metricKeys.includes(k) && !opKeys.includes(k), `${k} leaked to WASM`)
      }
      // Non-HTTP tags are unaffected by the deferral.
      assert.ok(metaKeys.includes('peer.service'))
      assert.ok(metricKeys.includes('metric.key'))
      // setTag still populates the JS cache, so the finish-time remap can read
      // the DD tags that were held out of WASM.
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
