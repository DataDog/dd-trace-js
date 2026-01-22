'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

// Helper to create 8-byte big-endian buffer from BigInt
function bigIntToBuffer (value) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(value)
  return buf
}

describe('NativeSpansInterface', () => {
  let NativeSpansInterface
  let nativeSpans
  let NativeSpanState
  let mockState
  let OpCode
  let spanIdBuffer

  beforeEach(() => {
    // Create a span ID buffer for tests
    spanIdBuffer = bigIntToBuffer(123456789n)

    // Mock OpCode enum
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

    // Mock NativeSpanState
    mockState = {
      flushChangeQueue: sinon.stub(),
      flushChunk: sinon.stub().resolves('OK'),
      stringTableInsertOne: sinon.stub(),
      stringTableEvict: sinon.stub(),
      sample: sinon.stub().returns(1),
      getName: sinon.stub().returns('test-span'),
      getServiceName: sinon.stub().returns('test-service'),
      getResourceName: sinon.stub().returns('test-resource'),
      getType: sinon.stub().returns('web'),
      getError: sinon.stub().returns(0),
      getStart: sinon.stub().returns(1000000000),
      getDuration: sinon.stub().returns(500000000),
      getMetaAttr: sinon.stub().returns('value'),
      getMetricAttr: sinon.stub().returns(42),
      getTraceMetaAttr: sinon.stub().returns('trace-value'),
      getTraceMetricAttr: sinon.stub().returns(100),
      getTraceOrigin: sinon.stub().returns('synthetics')
    }

    NativeSpanState = sinon.stub().returns(mockState)

    // Mock the native module
    NativeSpansInterface = proxyquire('../../src/native/native_spans', {
      './index': {
        NativeSpanState,
        OpCode
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

  describe('constructor', () => {
    it('should initialize NativeSpanState with correct parameters', () => {
      sinon.assert.calledOnce(NativeSpanState)
      sinon.assert.calledWith(
        NativeSpanState,
        'http://localhost:8126',
        '1.0.0',
        'nodejs',
        'v20.0.0',
        'v8',
        sinon.match.instanceOf(Buffer), // changeQueueBuffer
        sinon.match.instanceOf(Buffer), // stringTableInputBuffer
        12345,
        'test-service',
        sinon.match.instanceOf(Buffer) // samplingBuffer
      )
    })

    it('should allocate buffers', () => {
      assert.ok(nativeSpans._changeQueueBuffer instanceof Buffer)
      assert.ok(nativeSpans._stringTableInputBuffer instanceof Buffer)
      assert.ok(nativeSpans._samplingBuffer instanceof Buffer)
      assert.ok(nativeSpans._flushBuffer instanceof Buffer)
    })

    it('should initialize change queue state', () => {
      assert.strictEqual(nativeSpans._cqbIndex, 8)
      assert.strictEqual(nativeSpans._cqbCount, 0)
    })

    it('should initialize string table state', () => {
      assert.ok(nativeSpans._stringMap instanceof Map)
      assert.strictEqual(nativeSpans._stringIdCounter, 0)
    })
  })

  describe('getStringId', () => {
    it('should return a new ID for a new string', () => {
      const id = nativeSpans.getStringId('test-string')
      assert.strictEqual(id, 0)
      sinon.assert.calledWith(mockState.stringTableInsertOne, 0, 'test-string')
    })

    it('should return the same ID for a duplicate string', () => {
      const id1 = nativeSpans.getStringId('test-string')
      const id2 = nativeSpans.getStringId('test-string')
      assert.strictEqual(id1, id2)
      sinon.assert.calledOnce(mockState.stringTableInsertOne)
    })

    it('should assign sequential IDs to different strings', () => {
      const id1 = nativeSpans.getStringId('string1')
      const id2 = nativeSpans.getStringId('string2')
      const id3 = nativeSpans.getStringId('string3')
      assert.strictEqual(id1, 0)
      assert.strictEqual(id2, 1)
      assert.strictEqual(id3, 2)
    })
  })

  describe('evictString', () => {
    it('should evict a string from the string table', () => {
      nativeSpans.getStringId('test-string')
      nativeSpans.evictString('test-string')
      sinon.assert.calledWith(mockState.stringTableEvict, 0)
    })

    it('should not call evict for unknown strings', () => {
      nativeSpans.evictString('unknown-string')
      sinon.assert.notCalled(mockState.stringTableEvict)
    })
  })

  describe('queueOp', () => {
    it('should write opcode and span ID to change buffer', () => {
      nativeSpans.queueOp(OpCode.SetName, spanIdBuffer, 'test-name')

      // Check count was incremented
      assert.strictEqual(nativeSpans._cqbCount, 1)

      // Check count is written to buffer
      const count = nativeSpans._changeQueueBuffer.readBigUInt64LE(0)
      assert.strictEqual(count, 1n)
    })

    it('should handle string arguments via string table', () => {
      nativeSpans.queueOp(OpCode.SetMetaAttr, spanIdBuffer, 'key', 'value')

      // Both strings should be in string table
      assert.ok(nativeSpans._stringMap.has('key'))
      assert.ok(nativeSpans._stringMap.has('value'))
    })

    it('should handle u64 arguments', () => {
      nativeSpans.queueOp(OpCode.Create, spanIdBuffer, ['u64', 999n])

      assert.strictEqual(nativeSpans._cqbCount, 1)
    })

    it('should handle id128 arguments with 8-byte buffer', () => {
      const traceId = bigIntToBuffer(12345n)
      nativeSpans.queueOp(OpCode.Create, spanIdBuffer, ['id128', traceId])

      assert.strictEqual(nativeSpans._cqbCount, 1)
    })

    it('should handle id128 arguments with 16-byte buffer', () => {
      const traceId = Buffer.alloc(16)
      traceId.writeBigUInt64BE(1n, 0) // high
      traceId.writeBigUInt64BE(2n, 8) // low
      nativeSpans.queueOp(OpCode.Create, spanIdBuffer, ['id128', traceId])

      assert.strictEqual(nativeSpans._cqbCount, 1)
    })

    it('should handle id64 arguments', () => {
      const parentId = bigIntToBuffer(456n)
      nativeSpans.queueOp(OpCode.Create, spanIdBuffer, ['id64', parentId])

      assert.strictEqual(nativeSpans._cqbCount, 1)
    })

    it('should handle id64 with null value', () => {
      nativeSpans.queueOp(OpCode.Create, spanIdBuffer, ['id64', null])

      assert.strictEqual(nativeSpans._cqbCount, 1)
    })

    it('should handle i64 arguments', () => {
      nativeSpans.queueOp(OpCode.SetStart, spanIdBuffer, ['i64', 1000000000n])

      assert.strictEqual(nativeSpans._cqbCount, 1)
    })

    it('should handle f64 arguments', () => {
      nativeSpans.queueOp(OpCode.SetMetricAttr, spanIdBuffer, 'metric', ['f64', 3.14])

      assert.strictEqual(nativeSpans._cqbCount, 1)
    })

    it('should handle i32 arguments', () => {
      nativeSpans.queueOp(OpCode.SetError, spanIdBuffer, ['i32', 1])

      assert.strictEqual(nativeSpans._cqbCount, 1)
    })

    it('should flush when buffer is nearly full', () => {
      // Buffer is 8MB, each op is ~40 bytes, so we need ~200,000 ops to fill
      // For unit test, simulate by setting buffer index close to limit
      // Leave just enough room that estimatedSize check triggers a flush
      nativeSpans._cqbIndex = nativeSpans._changeQueueBuffer.length - 20
      nativeSpans._cqbCount = 1 // Pretend we have ops queued
      // Write count to buffer so the Rust-flush check doesn't reset the index
      nativeSpans._changeQueueBuffer.writeBigUInt64LE(1n, 0)

      // This op should trigger a flush due to estimated size check (estimatedSize = 16 + 2*16 = 48)
      nativeSpans.queueOp(OpCode.SetMetaAttr, spanIdBuffer, 'key', 'value')

      // flushChangeQueue should have been called
      sinon.assert.called(mockState.flushChangeQueue)
    })
  })

  describe('flushChangeQueue', () => {
    it('should call native flushChangeQueue', () => {
      nativeSpans.queueOp(OpCode.SetName, spanIdBuffer, 'test')
      nativeSpans.flushChangeQueue()

      sinon.assert.calledOnce(mockState.flushChangeQueue)
    })

    it('should reset buffer state after flush', () => {
      nativeSpans.queueOp(OpCode.SetName, spanIdBuffer, 'test')
      nativeSpans.flushChangeQueue()

      assert.strictEqual(nativeSpans._cqbIndex, 8)
      assert.strictEqual(nativeSpans._cqbCount, 0)
    })

    it('should not call native if no operations queued', () => {
      nativeSpans.flushChangeQueue()

      sinon.assert.notCalled(mockState.flushChangeQueue)
    })
  })

  describe('flushSpans', () => {
    it('should flush change queue before exporting', async () => {
      nativeSpans.queueOp(OpCode.SetName, spanIdBuffer, 'test')

      await nativeSpans.flushSpans([spanIdBuffer], true)

      sinon.assert.calledOnce(mockState.flushChangeQueue)
    })

    it('should call native flushChunk with span IDs', async () => {
      const spanIds = [bigIntToBuffer(123n), bigIntToBuffer(456n), bigIntToBuffer(789n)]

      await nativeSpans.flushSpans(spanIds, true)

      sinon.assert.calledWith(
        mockState.flushChunk,
        3, // count
        true, // firstIsLocalRoot
        sinon.match.instanceOf(Buffer) // flushBuffer
      )
    })

    it('should return early for empty span array', async () => {
      const result = await nativeSpans.flushSpans([], true)

      assert.strictEqual(result, 'no spans to flush')
      sinon.assert.notCalled(mockState.flushChunk)
    })

    it('should expand flush buffer if needed', async () => {
      // Create a large array of span ID buffers
      const spanIds = Array.from({ length: 2000 }, (_, i) => bigIntToBuffer(BigInt(i)))

      await nativeSpans.flushSpans(spanIds, false)

      // Buffer should have been expanded
      assert.ok(nativeSpans._flushBuffer.length >= spanIds.length * 8)
    })
  })

  describe('sample', () => {
    it('should flush change queue before sampling', () => {
      nativeSpans.queueOp(OpCode.SetName, spanIdBuffer, 'test')

      nativeSpans.sample(spanIdBuffer)

      sinon.assert.calledOnce(mockState.flushChangeQueue)
    })

    it('should call native sample and return result', () => {
      mockState.sample.returns(2)
      const result = nativeSpans.sample(spanIdBuffer)

      assert.strictEqual(result, 2)
      sinon.assert.calledOnce(mockState.sample)
    })
  })

  describe('getter methods', () => {
    it('should get meta attribute', () => {
      const result = nativeSpans.getMetaAttr(spanIdBuffer, 'key')
      assert.strictEqual(result, 'value')
      // Native method receives converted BigInt
      sinon.assert.calledWith(mockState.getMetaAttr, 123456789n, 'key')
    })

    it('should get metric attribute', () => {
      const result = nativeSpans.getMetricAttr(spanIdBuffer, 'metric')
      assert.strictEqual(result, 42)
      sinon.assert.calledWith(mockState.getMetricAttr, 123456789n, 'metric')
    })

    it('should get span name', () => {
      const result = nativeSpans.getName(spanIdBuffer)
      assert.strictEqual(result, 'test-span')
    })

    it('should get service name', () => {
      const result = nativeSpans.getServiceName(spanIdBuffer)
      assert.strictEqual(result, 'test-service')
    })

    it('should get resource name', () => {
      const result = nativeSpans.getResourceName(spanIdBuffer)
      assert.strictEqual(result, 'test-resource')
    })

    it('should get span type', () => {
      const result = nativeSpans.getType(spanIdBuffer)
      assert.strictEqual(result, 'web')
    })

    it('should get error flag', () => {
      const result = nativeSpans.getError(spanIdBuffer)
      assert.strictEqual(result, 0)
    })

    it('should get start time', () => {
      const result = nativeSpans.getStart(spanIdBuffer)
      assert.strictEqual(result, 1000000000)
    })

    it('should get duration', () => {
      const result = nativeSpans.getDuration(spanIdBuffer)
      assert.strictEqual(result, 500000000)
    })

    it('should get trace meta attribute', () => {
      const result = nativeSpans.getTraceMetaAttr(spanIdBuffer, 'key')
      assert.strictEqual(result, 'trace-value')
    })

    it('should get trace metric attribute', () => {
      const result = nativeSpans.getTraceMetricAttr(spanIdBuffer, 'metric')
      assert.strictEqual(result, 100)
    })

    it('should get trace origin', () => {
      const result = nativeSpans.getTraceOrigin(spanIdBuffer)
      assert.strictEqual(result, 'synthetics')
    })
  })

  describe('resetChangeQueue', () => {
    it('should reset buffer index and count', () => {
      nativeSpans.queueOp(OpCode.SetName, spanIdBuffer, 'test')

      nativeSpans.resetChangeQueue()

      assert.strictEqual(nativeSpans._cqbIndex, 8)
      assert.strictEqual(nativeSpans._cqbCount, 0)
    })
  })
})
