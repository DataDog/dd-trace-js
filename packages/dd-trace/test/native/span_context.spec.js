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
  let registerExtraService

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
    registerExtraService = sinon.stub()

    NativeSpanContext = proxyquire('../../src/native/span_context', {
      './index': { OpCode },
      '../service-naming/extra-services': { registerExtraService },
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

    it('keeps late tags in the JS cache without queueing native ops', () => {
      spanContext.markExported()
      nativeSpans.queueOp.resetHistory()
      nativeSpans.queueBatchMeta.resetHistory()
      nativeSpans.queueBatchMetrics.resetHistory()
      nativeSpans.queueBatchMetaFlat.resetHistory()
      nativeSpans.queueBatchMetricsFlat.resetHistory()

      spanContext.setTag('peer.service', 'db')
      spanContext.syncOneTagToNative('k', 'v')
      spanContext.syncToNativeOnly({ a: 'b', n: 1 })
      spanContext.syncFinalTagsToNative({ name: 'n', resource: 'r', error: 0, meta: {}, metrics: {} })

      assert.strictEqual(nativeSpans.queueOp.callCount, 0)
      assert.strictEqual(nativeSpans.queueBatchMeta.callCount, 0)
      assert.strictEqual(nativeSpans.queueBatchMetrics.callCount, 0)
      assert.strictEqual(nativeSpans.queueBatchMetaFlat.callCount, 0)
      assert.strictEqual(nativeSpans.queueBatchMetricsFlat.callCount, 0)
      assert.strictEqual(spanContext.getTag('peer.service'), 'db')
    })
  })

  describe('tag cache and final native sync', () => {
    beforeEach(() => {
      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: id,
        spanId: id,
        tracerService: 'svc',
        tracerServiceLower: 'svc',
      })
    })

    it('keeps mutation paths JS-cache-only before final sync', () => {
      spanContext.setTag('dynamic.tag', 'first')
      spanContext.syncOneTagToNative('dynamic.tag', 42)
      spanContext.syncToNativeOnly({ 'removed.tag': undefined, flag: true })

      assert.strictEqual(spanContext.getTag('dynamic.tag'), 'first')
      sinon.assert.notCalled(nativeSpans.queueOp)
      sinon.assert.notCalled(nativeSpans.queueBatchMeta)
      sinon.assert.notCalled(nativeSpans.queueBatchMetrics)
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

    it('skips formatter-added process tags from final meta batching', () => {
      spanContext.syncFinalTagsToNative({
        name: 'operation',
        resource: 'resource',
        error: 0,
        meta: { '_dd.tags.process': 'entrypoint.name:test', keep: 'yes' },
        metrics: {},
      })

      sinon.assert.calledWith(
        nativeSpans.queueBatchMetaFlat,
        leSpanId,
        ['keep', 'yes']
      )
    })

    it('keeps explicit process tags in final meta batching', () => {
      spanContext.setTag('_dd.tags.process', 'user:value')

      spanContext.syncFinalTagsToNative({
        name: 'operation',
        resource: 'resource',
        error: 0,
        meta: { '_dd.tags.process': 'user:value', keep: 'yes' },
        metrics: {},
      })

      sinon.assert.calledWith(
        nativeSpans.queueBatchMetaFlat,
        leSpanId,
        ['_dd.tags.process', 'user:value', 'keep', 'yes']
      )
    })

    it('skips final core fields already queued to native storage', () => {
      spanContext._recordNativeCoreFields('operation', 'operation')

      spanContext.syncFinalTagsToNative({
        name: 'operation',
        resource: 'operation',
        error: 0,
        meta: {},
        metrics: {},
      })

      sinon.assert.notCalled(nativeSpans.queueOp)
      sinon.assert.notCalled(nativeSpans.queueBatchMetaFlat)
      sinon.assert.notCalled(nativeSpans.queueBatchMetricsFlat)
    })

    it('fast-syncs primitive tags without a formatted snapshot', () => {
      spanContext._name = 'operation'
      spanContext._recordNativeCoreFields('operation', 'operation', 'svc', '')
      spanContext.setTag('service.name', 'svc')
      spanContext._sampling.priority = 1
      spanContext.setTag('component', 'express')
      spanContext.setTag('custom.metric', 2)
      spanContext.setTag('flag', true)
      spanContext.setTag('http.status_code', 200)
      spanContext.setTag('span.kind', 'server')

      assert.strictEqual(spanContext.tryFastFinalTagsToNative(), true)

      sinon.assert.notCalled(nativeSpans.queueOp)
      sinon.assert.calledWith(
        nativeSpans.queueBatchMetaFlat,
        leSpanId,
        ['component', 'express', 'http.status_code', '200', 'span.kind', 'server']
      )
      sinon.assert.calledWith(
        nativeSpans.queueBatchMetricsFlat,
        leSpanId,
        ['custom.metric', 2, 'flag', 1, '_dd.measured', 1, '_sampling_priority_v1', 1]
      )
    })

    it('fast-syncs supported core tag changes', () => {
      spanContext._recordNativeCoreFields('operation', 'operation', 'svc', '')
      spanContext._name = 'renamed-operation'
      spanContext.setTag('service.name', 'api')
      spanContext.setTag('resource.name', 'GET /users')
      spanContext.setTag('span.type', 'web')

      assert.strictEqual(spanContext.tryFastFinalTagsToNative(), true)

      sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetName, leSpanId, 'renamed-operation')
      sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetResourceName, leSpanId, 'GET /users')
      sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetServiceName, leSpanId, 'api')
      sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetType, leSpanId, 'web')
      sinon.assert.calledOnceWithExactly(registerExtraService, 'api')
      sinon.assert.notCalled(nativeSpans.queueBatchMetaFlat)
      sinon.assert.notCalled(nativeSpans.queueBatchMetricsFlat)
    })

    it('preserves resource names longer than the agent normalization threshold', () => {
      const resource = 'r'.repeat(5_001)

      spanContext._name = 'operation'
      spanContext._recordNativeCoreFields('operation', 'operation', 'svc', '')
      spanContext.setTag('service.name', 'svc')
      spanContext.setTag('resource.name', resource)

      assert.strictEqual(spanContext.tryFastFinalTagsToNative(), true)

      sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetResourceName, leSpanId, resource)
    })

    it('falls back without writing for unsupported final tags', () => {
      spanContext._name = 'operation'
      spanContext._recordNativeCoreFields('operation', 'operation', 'svc', '')
      spanContext.setTag('object.tag', { nested: true })

      assert.strictEqual(spanContext.tryFastFinalTagsToNative(), false)

      sinon.assert.notCalled(nativeSpans.queueOp)
      sinon.assert.notCalled(nativeSpans.queueBatchMetaFlat)
      sinon.assert.notCalled(nativeSpans.queueBatchMetricsFlat)
    })

    it('falls back before DD HTTP tags when OTel remapping is enabled', () => {
      nativeSpans.otelSemanticsEnabled = true
      spanContext._name = 'operation'
      spanContext._recordNativeCoreFields('operation', 'operation', 'svc', '')
      spanContext.setTag('http.method', 'GET')

      assert.strictEqual(spanContext.tryFastFinalTagsToNative(), false)

      sinon.assert.notCalled(nativeSpans.queueOp)
      sinon.assert.notCalled(nativeSpans.queueBatchMetaFlat)
      sinon.assert.notCalled(nativeSpans.queueBatchMetricsFlat)
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

  // getTag/hasTag/deleteTag/getTags inherit from DatadogSpanContext and are
  // covered by `packages/dd-trace/test/opentracing/span_context.spec.js`. The
  // native subclass adds native-storage sync on setTag (tested above) but
  // doesn't override the read-side accessors, so we don't re-test them here.

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
