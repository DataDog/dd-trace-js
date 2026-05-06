'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

// Helper to read a u64 LE from the change-queue buffer at a given byte offset.
function readU64LE (view, offset) {
  return view.getBigUint64(offset, true)
}

describe('NativeSpansInterface', () => {
  let NativeSpansInterface
  let nativeSpans
  let WasmSpanState
  let mockState
  let OpCode
  let fakeWasmMemory
  // The slotIndex used by most queueOp tests. The pre-rebase API addressed
  // spans by spanId buffer; the rebased API uses a u32 slot number.
  const slot = 7

  beforeEach(() => {
    // Mock OpCode enum (mirrors the values exported by the pipeline crate).
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

    // Mock WasmSpanState — the rebased class exposed by the pipeline crate.
    // change_queue_ptr() returns the byte offset of the change queue inside
    // wasmMemory; the JS side opens DataView/Uint8Array views starting at
    // that offset.
    mockState = {
      flushChangeQueue: sinon.stub(),
      prepareChunk: sinon.stub(),
      sendPreparedChunk: sinon.stub().resolves('OK'),
      stringTableInsertOne: sinon.stub(),
      stringTableEvict: sinon.stub(),
      flushStats: sinon.stub().resolves(true),
      change_queue_ptr: sinon.stub().returns(0),
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

    WasmSpanState = sinon.stub().returns(mockState)

    // Real ArrayBuffer backing for the WASM memory shim. NativeSpansInterface
    // opens DataView / Uint8Array views over this buffer; tests inspect those
    // views to verify queueOp wrote the expected wire format.
    // The change queue lives at offset 0 in WASM memory; allocate enough
    // room that the 8 MiB CHANGE_QUEUE_BUFFER_SIZE check inside queueOp can
    // be exercised by setting _cqbIndex near the end.
    fakeWasmMemory = { buffer: new ArrayBuffer(8 * 1024 * 1024 + 16 * 1024) }

    NativeSpansInterface = proxyquire('../../src/native/native_spans', {
      './index': {
        WasmSpanState,
        wasmMemory: fakeWasmMemory,
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
    it('should initialize WasmSpanState with the agent URL + tracer metadata', () => {
      // The WasmSpanState constructor was called once during NativeSpansInterface
      // construction in beforeEach. Assert on the first few positional args we
      // explicitly own; the trailing args (buffer sizes + stats opts) are
      // implementation details that don't need pinning here.
      sinon.assert.calledOnce(WasmSpanState)
      const args = WasmSpanState.getCall(0).args
      assert.strictEqual(args[0], 'http://localhost:8126')
      assert.strictEqual(args[1], '1.0.0')
      assert.strictEqual(args[2], 'nodejs')
      assert.strictEqual(args[3], 'v20.0.0')
      assert.strictEqual(args[4], 'v8')
      // args[5] and args[6] are CHANGE_QUEUE_BUFFER_SIZE and
      // STRING_TABLE_INPUT_BUFFER_SIZE (numbers).
      assert.strictEqual(typeof args[5], 'number')
      assert.strictEqual(typeof args[6], 'number')
      assert.strictEqual(args[7], 12345)
      assert.strictEqual(args[8], 'test-service')
    })

    it('should open WASM-memory views into the change queue', () => {
      assert.ok(nativeSpans._cqbView instanceof DataView)
      assert.ok(nativeSpans._cqbBytes instanceof Uint8Array)
      assert.strictEqual(nativeSpans._flushBuffer.constructor.name, 'Buffer')
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
    it('should write opcode and bump count + header', () => {
      nativeSpans.queueOp(OpCode.SetName, slot, 'test-name')

      assert.strictEqual(nativeSpans._cqbCount, 1)
      // The first 8 bytes of the change queue store the count as u64 LE.
      assert.strictEqual(readU64LE(nativeSpans._cqbView, 0), 1n)
    })

    it('should handle string arguments via string table', () => {
      nativeSpans.queueOp(OpCode.SetMetaAttr, slot, 'key', 'value')

      // Both strings should be in string table
      assert.ok(nativeSpans._stringMap.has('key'))
      assert.ok(nativeSpans._stringMap.has('value'))
    })

    it('should handle id128 arguments with 8-byte buffer', () => {
      const traceId = Buffer.alloc(8)
      traceId.writeBigUInt64BE(12345n)
      nativeSpans.queueOp(OpCode.Create, slot, ['id128', traceId])

      assert.strictEqual(nativeSpans._cqbCount, 1)
    })

    it('should handle id128 arguments with 16-byte buffer', () => {
      const traceId = Buffer.alloc(16)
      traceId.writeBigUInt64BE(1n, 0) // high
      traceId.writeBigUInt64BE(2n, 8) // low
      nativeSpans.queueOp(OpCode.Create, slot, ['id128', traceId])

      assert.strictEqual(nativeSpans._cqbCount, 1)
    })

    it('should handle id64 arguments', () => {
      const parentId = Buffer.alloc(8)
      parentId.writeBigUInt64BE(456n)
      nativeSpans.queueOp(OpCode.Create, slot, ['id64', parentId])

      assert.strictEqual(nativeSpans._cqbCount, 1)
    })

    it('should handle id64 with null value', () => {
      nativeSpans.queueOp(OpCode.Create, slot, ['id64', null])

      assert.strictEqual(nativeSpans._cqbCount, 1)
    })

    it('should handle ns arguments (ms -> nanoseconds)', () => {
      // The 'ns' tag converts a millisecond value to nanoseconds and writes
      // it as a u64 LE; replaces the i64-bigint path used in the old API.
      nativeSpans.queueOp(OpCode.SetStart, slot, ['ns', 1000])

      assert.strictEqual(nativeSpans._cqbCount, 1)
    })

    it('should handle f64 arguments', () => {
      nativeSpans.queueOp(OpCode.SetMetricAttr, slot, 'metric', ['f64', 3.14])

      assert.strictEqual(nativeSpans._cqbCount, 1)
    })

    it('should handle i32 arguments', () => {
      nativeSpans.queueOp(OpCode.SetError, slot, ['i32', 1])

      assert.strictEqual(nativeSpans._cqbCount, 1)
    })

    it('should flush when buffer is nearly full', () => {
      // queueOp checks against the CHANGE_QUEUE_BUFFER_SIZE constant (8 MiB),
      // not the underlying WASM ArrayBuffer length. Set _cqbIndex within 76
      // bytes of that limit so the next queueOp triggers flushChangeQueue()
      // before writing.
      const CHANGE_QUEUE_BUFFER_SIZE = 8 * 1024 * 1024
      nativeSpans._cqbIndex = CHANGE_QUEUE_BUFFER_SIZE - 20
      nativeSpans._cqbCount = 1
      // Write count to header so flushChangeQueue actually delegates to native.
      nativeSpans._cqbView.setUint32(0, 1, true)

      nativeSpans.queueOp(OpCode.SetMetaAttr, slot, 'key', 'value')

      sinon.assert.called(mockState.flushChangeQueue)
    })
  })

  describe('flushChangeQueue', () => {
    it('should call native flushChangeQueue', () => {
      nativeSpans.queueOp(OpCode.SetName, slot, 'test')
      nativeSpans.flushChangeQueue()

      sinon.assert.calledOnce(mockState.flushChangeQueue)
    })

    it('should reset buffer state after flush', () => {
      nativeSpans.queueOp(OpCode.SetName, slot, 'test')
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
      nativeSpans.queueOp(OpCode.SetName, slot, 'test')

      await nativeSpans.flushSpans([slot], true)

      // Exactly one flushChangeQueue call: the queueOp queued one op, then
      // flushSpans drained it before calling prepareChunk.
      sinon.assert.calledOnce(mockState.flushChangeQueue)
    })

    it('should call native prepareChunk + sendPreparedChunk with slot indices', async () => {
      const slots = [0, 1, 2]

      await nativeSpans.flushSpans(slots, true)

      sinon.assert.calledWith(
        mockState.prepareChunk,
        3, // count
        true, // firstIsLocalRoot
        sinon.match.instanceOf(Buffer) // flushBuffer
      )
      sinon.assert.calledOnce(mockState.sendPreparedChunk)
    })

    it('should return early for empty span array', async () => {
      const result = await nativeSpans.flushSpans([], true)

      assert.strictEqual(result, 'no spans to flush')
      sinon.assert.notCalled(mockState.prepareChunk)
      sinon.assert.notCalled(mockState.sendPreparedChunk)
    })

    it('should expand flush buffer if needed', async () => {
      // Slot indices are u32 LE (4 bytes each); FLUSH_BUFFER_SIZE starts at
      // 10 KiB. 4000 slots = 16000 bytes => triggers reallocation.
      const slots = Array.from({ length: 4000 }, (_, i) => i)

      await nativeSpans.flushSpans(slots, false)

      assert.ok(nativeSpans._flushBuffer.length >= slots.length * 4)
    })
  })

  // The pre-rebase API exposed nativeSpans.sample(). The rebased pipeline
  // crate doesn't include that method (sampling happens in the JS-side
  // priority sampler now — see the trailing comment in native_spans.js),
  // so the corresponding tests have been removed.

  describe('getter methods', () => {
    // Slot indices are plain numbers in the rebased API, not BigInt-converted
    // BE buffers. The mocks return canned values regardless of input.
    it('should get meta attribute', () => {
      const result = nativeSpans.getMetaAttr(slot, 'key')
      assert.strictEqual(result, 'value')
      sinon.assert.calledWith(mockState.getMetaAttr, slot, 'key')
    })

    it('should get metric attribute', () => {
      const result = nativeSpans.getMetricAttr(slot, 'metric')
      assert.strictEqual(result, 42)
      sinon.assert.calledWith(mockState.getMetricAttr, slot, 'metric')
    })

    it('should get span name', () => {
      assert.strictEqual(nativeSpans.getName(slot), 'test-span')
    })

    it('should get service name', () => {
      assert.strictEqual(nativeSpans.getServiceName(slot), 'test-service')
    })

    it('should get resource name', () => {
      assert.strictEqual(nativeSpans.getResourceName(slot), 'test-resource')
    })

    it('should get span type', () => {
      assert.strictEqual(nativeSpans.getType(slot), 'web')
    })

    it('should get error flag', () => {
      assert.strictEqual(nativeSpans.getError(slot), 0)
    })

    it('should get start time', () => {
      assert.strictEqual(nativeSpans.getStart(slot), 1000000000)
    })

    it('should get duration', () => {
      assert.strictEqual(nativeSpans.getDuration(slot), 500000000)
    })

    it('should get trace meta attribute', () => {
      assert.strictEqual(nativeSpans.getTraceMetaAttr(slot, 'key'), 'trace-value')
    })

    it('should get trace metric attribute', () => {
      assert.strictEqual(nativeSpans.getTraceMetricAttr(slot, 'metric'), 100)
    })

    it('should get trace origin', () => {
      assert.strictEqual(nativeSpans.getTraceOrigin(slot), 'synthetics')
    })
  })

  describe('resetChangeQueue', () => {
    it('should reset buffer index and count', () => {
      nativeSpans.queueOp(OpCode.SetName, slot, 'test')

      nativeSpans.resetChangeQueue()

      assert.strictEqual(nativeSpans._cqbIndex, 8)
      assert.strictEqual(nativeSpans._cqbCount, 0)
    })
  })

  describe('slot allocator', () => {
    it('should hand out sequential slot indices', () => {
      const a = nativeSpans.allocSlot()
      const b = nativeSpans.allocSlot()
      const c = nativeSpans.allocSlot()
      assert.strictEqual(a, 0)
      assert.strictEqual(b, 1)
      assert.strictEqual(c, 2)
    })

    it('should reuse freed slots before bumping the counter', () => {
      const a = nativeSpans.allocSlot()
      const b = nativeSpans.allocSlot()
      nativeSpans.freeSlots([a, b])
      // freeSlots is a stack (LIFO), so the most recently freed slot comes
      // back first. Asserting on identity of the returned values is enough
      // to prove the free list is wired correctly.
      const next = nativeSpans.allocSlot()
      assert.ok(next === a || next === b)
    })
  })

  describe('queueCreateSpan', () => {
    it('should write a CreateSpan record (opcode 13) and bump count', () => {
      const spanId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
      const traceId = Buffer.alloc(8)
      traceId.writeBigUInt64BE(0xabcdn)
      const parentId = Buffer.alloc(8)
      parentId.writeBigUInt64BE(0x1234n)

      nativeSpans.queueCreateSpan(slot, spanId, traceId, parentId, 'op', 1500)

      assert.strictEqual(nativeSpans._cqbCount, 1)
      // The opcode is the first u64 LE after the 8-byte header.
      assert.strictEqual(nativeSpans._cqbView.getUint32(8, true), 13)
    })
  })

  describe('queueBatchMeta / queueBatchMetrics', () => {
    it('queueBatchMeta should be a no-op for empty input', () => {
      nativeSpans.queueBatchMeta(slot, [])
      assert.strictEqual(nativeSpans._cqbCount, 0)
    })

    it('queueBatchMetrics should be a no-op for empty input', () => {
      nativeSpans.queueBatchMetrics(slot, [])
      assert.strictEqual(nativeSpans._cqbCount, 0)
    })

    it('queueBatchMeta should write opcode 15 and resolve string IDs for k/v pairs', () => {
      nativeSpans.queueBatchMeta(slot, [['k1', 'v1'], ['k2', 'v2']])

      assert.strictEqual(nativeSpans._cqbCount, 1)
      assert.strictEqual(nativeSpans._cqbView.getUint32(8, true), 15)
      assert.ok(nativeSpans._stringMap.has('k1'))
      assert.ok(nativeSpans._stringMap.has('v1'))
    })

    it('queueBatchMetrics should write opcode 16 and resolve key string IDs', () => {
      nativeSpans.queueBatchMetrics(slot, [['m1', 1.5], ['m2', 2.5]])

      assert.strictEqual(nativeSpans._cqbCount, 1)
      assert.strictEqual(nativeSpans._cqbView.getUint32(8, true), 16)
      assert.ok(nativeSpans._stringMap.has('m1'))
      assert.ok(nativeSpans._stringMap.has('m2'))
    })
  })
})
