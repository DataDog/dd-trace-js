'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')

require('../setup/core')

/**
 * Smoke tests for native spans end-to-end functionality.
 *
 * These tests verify that the native spans components work together.
 * They use mocked NativeSpanState to avoid requiring the actual native module.
 */
describe('Native Spans Smoke Tests', () => {
  let NativeSpansInterface
  let NativeSpanContext
  let NativeDatadogSpan
  let NativeExporter
  let nativeSpans
  let mockState
  let OpCode

  beforeEach(() => {
    sinon.stub(Date, 'now').returns(1500000000000)

    OpCode = {
      Create: 0,
      SetMetaAttr: 1,
      SetMetricAttr: 2,
      SetServiceName: 3,
      SetResourceName: 4,
      SetName: 5,
      SetType: 6,
      SetError: 7,
      SetStart: 8,
      SetDuration: 9,
      SetTraceMetaAttr: 10,
      SetTraceMetricsAttr: 11,
      SetTraceOrigin: 12
    }

    mockState = {
      flushChangeQueue: sinon.stub(),
      flushChunk: sinon.stub().resolves('OK'),
      stringTableInsertOne: sinon.stub(),
      stringTableEvict: sinon.stub(),
      sample: sinon.stub().returns(1),
      getName: sinon.stub().returns('test'),
      getServiceName: sinon.stub().returns('test-service'),
      getResourceName: sinon.stub().returns('test'),
      getType: sinon.stub().returns('web'),
      getError: sinon.stub().returns(0),
      getStart: sinon.stub().returns(1000000000),
      getDuration: sinon.stub().returns(500000000),
      getMetaAttr: sinon.stub().returns(null),
      getMetricAttr: sinon.stub().returns(null),
      getTraceMetaAttr: sinon.stub().returns(null),
      getTraceMetricAttr: sinon.stub().returns(null),
      getTraceOrigin: sinon.stub().returns(null)
    }

    // Load modules with mocked native state
    const proxyquire = require('proxyquire').noCallThru()

    const mockNativeIndex = {
      NativeSpanState: sinon.stub().returns(mockState),
      OpCode,
      available: true
    }

    NativeSpansInterface = proxyquire('../../src/native/native_spans', {
      './index': mockNativeIndex
    })

    NativeSpanContext = proxyquire('../../src/native/span_context', {
      './index': mockNativeIndex
    })

    NativeExporter = proxyquire('../../src/exporters/native', {
      '../../log': {
        warn: sinon.stub(),
        error: sinon.stub(),
        debug: sinon.stub()
      }
    })

    nativeSpans = new NativeSpansInterface({
      agentUrl: 'http://localhost:8126',
      tracerVersion: '1.0.0',
      lang: 'nodejs',
      langVersion: 'v20.0.0',
      langInterpreter: 'v8',
      pid: 12345,
      tracerService: 'test-service'
    })
  })

  afterEach(() => {
    Date.now.restore()
  })

  describe('NativeSpansInterface integration', () => {
    it('should queue operations and flush to native', () => {
      const spanId = 12345n

      nativeSpans.queueOp(OpCode.Create, spanId, ['u128', [0n, spanId]], ['u64', 0n])
      nativeSpans.queueOp(OpCode.SetName, spanId, 'test-operation')
      nativeSpans.queueOp(OpCode.SetServiceName, spanId, 'test-service')

      assert.strictEqual(nativeSpans._cqbCount, 3)

      nativeSpans.flushChangeQueue()

      sinon.assert.called(mockState.flushChangeQueue)
      assert.strictEqual(nativeSpans._cqbCount, 0)
    })

    it('should manage string table', () => {
      const id1 = nativeSpans.getStringId('test-string')
      const id2 = nativeSpans.getStringId('test-string')
      const id3 = nativeSpans.getStringId('another-string')

      assert.strictEqual(id1, id2)
      assert.notStrictEqual(id1, id3)
    })

    it('should flush spans to agent', async () => {
      const spanIds = [123n, 456n]

      await nativeSpans.flushSpans(spanIds, true)

      sinon.assert.calledWith(mockState.flushChunk, 2, true, sinon.match.instanceOf(Buffer))
    })

    it('should sample spans', () => {
      mockState.sample.returns(2) // USER_KEEP

      const priority = nativeSpans.sample(123n)

      assert.strictEqual(priority, 2)
    })
  })

  describe('NativeSpanContext integration', () => {
    let spanContext
    let mockId

    beforeEach(() => {
      mockId = {
        toString: () => '123',
        toBigInt: () => 123n,
        toBuffer: () => Buffer.alloc(8)
      }

      spanContext = new NativeSpanContext(nativeSpans, {
        traceId: mockId,
        spanId: mockId
      })
    })

    it('should sync tags to native storage via setTag()', () => {
      const initialCount = nativeSpans._cqbCount

      spanContext.setTag('service.name', 'my-service')
      spanContext.setTag('http.url', 'https://example.com')
      spanContext.setTag('http.status_code', 200)

      // Tags should be cached locally
      assert.strictEqual(spanContext.getTag('service.name'), 'my-service')
      assert.strictEqual(spanContext.getTag('http.url'), 'https://example.com')
      assert.strictEqual(spanContext.getTag('http.status_code'), 200)

      // Operations should be queued to the change buffer
      assert.ok(nativeSpans._cqbCount > initialCount, 'Operations should be queued to native')
    })

    it('should sync span name to native', () => {
      const initialCount = nativeSpans._cqbCount

      spanContext._syncNameToNative('my-operation')

      // Operation should be queued
      assert.ok(nativeSpans._cqbCount > initialCount, 'SetName operation should be queued')
    })
  })

  describe('NativeExporter integration', () => {
    let exporter
    let config

    beforeEach(() => {
      config = {
        url: 'http://localhost:8126',
        flushInterval: 0
      }

      exporter = new NativeExporter(config, {}, nativeSpans)
    })

    it('should export spans through native interface', (done) => {
      const mockSpan = createMockSpan(123n)

      exporter.export([mockSpan])

      // With flushInterval: 0, should flush immediately
      setTimeout(() => {
        sinon.assert.called(mockState.flushChunk)
        done()
      }, 10)
    })

    it('should sync trace tags to first span on flush', (done) => {
      const mockSpan = createMockSpan(123n)
      mockSpan.context()._parentId = null // Make it a local root
      mockSpan.context()._trace.tags = { '_dd.p.tid': 'abc123' }
      mockSpan.context()._trace.started = [mockSpan]

      exporter.export([mockSpan])

      // With flushInterval: 0, should flush immediately and sync tags
      setTimeout(() => {
        assert.strictEqual(mockSpan.context()._tags['_dd.p.tid'], 'abc123')
        done()
      }, 10)
    })
  })

  describe('End-to-end span lifecycle', () => {
    it('should handle complete span lifecycle', async () => {
      // 1. Create span context
      const mockId = {
        toString: () => '999',
        toBigInt: () => 999n,
        toBuffer: () => Buffer.alloc(8)
      }

      const spanContext = new NativeSpanContext(nativeSpans, {
        traceId: mockId,
        spanId: mockId,
        trace: {
          started: [],
          finished: [],
          tags: {}
        }
      })

      // 2. Set span properties
      spanContext._tags['service.name'] = 'test-service'
      spanContext._tags['resource.name'] = 'GET /api/users'
      spanContext._tags['span.type'] = 'web'
      spanContext._syncNameToNative('http.request')

      // 3. Queue start time
      nativeSpans.queueOp(OpCode.SetStart, 999n, ['i64', 1500000000000000000n])

      // 4. Simulate span finishing - queue duration
      nativeSpans.queueOp(OpCode.SetDuration, 999n, ['i64', 100000000n])

      // 5. Export via NativeExporter
      const exporter = new NativeExporter({ url: 'http://localhost:8126', flushInterval: 0 }, {}, nativeSpans)

      const mockSpan = {
        context: () => spanContext
      }

      spanContext._trace.started.push(mockSpan)
      spanContext._trace.finished.push(mockSpan)

      // 6. Export and flush
      exporter.export([mockSpan])
      await new Promise(resolve => exporter.flush(resolve))

      // Verify native flush was called
      sinon.assert.called(mockState.flushChunk)
    })

    it('should handle parent-child span relationships', () => {
      const parentId = {
        toString: () => '100',
        toBigInt: () => 100n,
        toBuffer: () => Buffer.alloc(8)
      }

      const childId = {
        toString: () => '200',
        toBigInt: () => 200n,
        toBuffer: () => Buffer.alloc(8)
      }

      const sharedTrace = {
        started: [],
        finished: [],
        tags: {}
      }

      // Create parent context
      const parentContext = new NativeSpanContext(nativeSpans, {
        traceId: parentId,
        spanId: parentId,
        trace: sharedTrace
      })

      // Create child context with parent
      const childContext = new NativeSpanContext(nativeSpans, {
        traceId: parentId, // Same trace ID
        spanId: childId,
        parentId: parentId,
        trace: sharedTrace // Shared trace
      })

      // Verify relationship
      assert.strictEqual(childContext._traceId, parentContext._traceId)
      assert.strictEqual(childContext._parentId, parentId)
      assert.strictEqual(childContext._trace, parentContext._trace)
    })
  })

  // Helper to create mock spans
  function createMockSpan (nativeSpanId) {
    const spanId = {
      toString: () => String(nativeSpanId),
      toBigInt: () => nativeSpanId
    }

    const context = {
      _nativeSpanId: nativeSpanId,
      _spanId: spanId,
      _parentId: { toString: () => '0' },
      _isRemote: false,
      _trace: {
        started: [],
        finished: [],
        tags: {}
      },
      _tags: {}
    }

    return {
      context: () => context
    }
  }
})
