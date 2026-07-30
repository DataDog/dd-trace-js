'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

require('../setup/core')

// Helper to read a u64 LE from the change-queue buffer at a given byte offset.
function readU64LE (view, offset) {
  return view.getBigUint64(offset, true)
}

// Simulate WebAssembly.Memory.grow() for tests: the new buffer preserves the
// old bytes, but JS views must be refreshed because future writes need to land
// in wasmMemory.buffer, not the stale pre-growth buffer.
function simulateWasmMemoryGrow (wasmMemory) {
  const oldBytes = new Uint8Array(wasmMemory.buffer)
  const newBuffer = new ArrayBuffer(oldBytes.byteLength + 64 * 1024)
  new Uint8Array(newBuffer).set(oldBytes)
  wasmMemory.buffer = newBuffer
  return newBuffer
}

describe('NativeSpansInterface', () => {
  let NativeSpansInterface
  let nativeSpans
  let WasmSpanState
  let mockState
  let OpCode
  let fakeWasmMemory
  let metricsCount
  let logError
  let logErrorWithoutTelemetry
  // The op handle used by most queueOp tests. The native API addresses
  // spans by their 8-byte LE span id, not by a u32 slot number.
  const spanId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

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
      SetTraceOrigin: 12,
    }

    // Mock WasmSpanState (the pipeline crate exposes this as the WASM-side anchor).
    // change_queue_ptr() returns the byte offset of the change queue inside
    // wasmMemory; the JS side opens DataView/Uint8Array views starting at
    // that offset.
    mockState = {
      flushChangeQueue: sinon.stub(),
      prepareChunk: sinon.stub().returns(true),
      sendPreparedChunk: sinon.stub().resolves('OK'),
      free: sinon.stub(),
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
      getTraceOrigin: sinon.stub().returns('synthetics'),
      setMetaStruct: sinon.stub(),
      addSpanEvent: sinon.stub(),
      setUseV05: sinon.stub(),
      setOtlpEndpoint: sinon.stub(),
      setOtlpProtocol: sinon.stub(),
      setOtlpHeaders: sinon.stub(),
    }

    metricsCount = sinon.stub()
    logError = sinon.stub()
    logErrorWithoutTelemetry = sinon.stub()

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
        OpCode,
      },
      '../runtime_metrics': { count: metricsCount },
      '../log': {
        error: logError,
        errorWithoutTelemetry: logErrorWithoutTelemetry,
        warn: sinon.stub(),
        debug: sinon.stub(),
      },
    })

    nativeSpans = new NativeSpansInterface({
      agentUrl: 'http://localhost:8126',
      tracerVersion: '1.0.0',
      lang: 'nodejs',
      langVersion: 'v20.0.0',
      langInterpreter: 'v8',
      pid: 12345,
      tracerService: 'test-service',
    })
  })

  describe('constructor', () => {
    it('should initialize WasmSpanState + queue state with the agent URL and tracer metadata', () => {
      // The WasmSpanState constructor was called once during NativeSpansInterface
      // construction in beforeEach. Assert on the user-provided positional args
      // (trailing args are buffer sizes / stats opts and aren't worth pinning).
      sinon.assert.calledOnce(WasmSpanState)
      const args = WasmSpanState.getCall(0).args
      assert.strictEqual(args[0], 'http://localhost:8126')
      assert.strictEqual(args[1], '1.0.0')
      assert.strictEqual(args[2], 'nodejs')
      assert.strictEqual(args[3], 'v20.0.0')
      assert.strictEqual(args[4], 'v8')
      assert.strictEqual(args[7], 12345)
      assert.strictEqual(args[8], 'test-service')

      // Initial queue / string-table state — the invariants the rest of the
      // suite relies on (header offset, zero count, empty string table).
      assert.strictEqual(nativeSpans._cqbIndex, 8)
      assert.strictEqual(nativeSpans._cqbCount, 0)
      assert.strictEqual(nativeSpans._stringIdCounter, 0)
    })
  })

  describe('getStringId', () => {
    it('returns monotonically-assigned IDs, deduped by string', () => {
      const a1 = nativeSpans.getStringId('foo')
      const b = nativeSpans.getStringId('bar')
      const a2 = nativeSpans.getStringId('foo')
      const c = nativeSpans.getStringId('baz')
      assert.strictEqual(a1, 0)
      assert.strictEqual(b, 1)
      assert.strictEqual(a2, a1, 'duplicate returns same ID')
      assert.strictEqual(c, 2)
      // Three distinct strings => exactly three WASM inserts.
      sinon.assert.calledThrice(mockState.stringTableInsertOne)
      sinon.assert.calledWith(mockState.stringTableInsertOne, 0, 'foo')
      sinon.assert.calledWith(mockState.stringTableInsertOne, 1, 'bar')
      sinon.assert.calledWith(mockState.stringTableInsertOne, 2, 'baz')
    })
  })

  describe('queueOp', () => {
    it('encodes each argument shape correctly into the change buffer', () => {
      // Each case exercises one queueOp argument-encoding path. We reset the
      // change queue between cases so the per-case assertions about _cqbCount
      // (and the header) hold deterministically.
      const id8 = Buffer.alloc(8)
      id8.writeBigUInt64BE(12345n)
      const id16 = Buffer.alloc(16)
      id16.writeBigUInt64BE(1n, 0)
      id16.writeBigUInt64BE(2n, 8)
      const id64Buf = Buffer.alloc(8)
      id64Buf.writeBigUInt64BE(456n)

      const cases = [
        {
          name: 'opcode + count + header (string-only arg path)',
          args: [OpCode.SetName, spanId, 'test-name'],
          assert: () => {
            assert.strictEqual(nativeSpans._cqbCount, 1)
            // The first 8 bytes of the change queue store the count
            // (u32 LE at offset 0; u32 LE at offset 4 is left as 0).
            // Read as a u64 LE for a stable cross-byte assertion.
            assert.strictEqual(readU64LE(nativeSpans._cqbView, 0), 1n)
            // Opcode is a u16 LE at the start of the record (byte 8), and the
            // 8-byte LE span id handle follows it at bytes 10..17.
            assert.strictEqual(nativeSpans._cqbView.getUint16(8, true), OpCode.SetName)
            assert.deepStrictEqual(nativeSpans._cqbBytes.subarray(10, 18), spanId)
          },
        },
        {
          name: 'string arguments resolved via string table',
          args: [OpCode.SetMetaAttr, spanId, 'key', 'value'],
          assert: () => {
            assert.ok(nativeSpans._stringMap.has('key'))
            assert.ok(nativeSpans._stringMap.has('value'))
          },
        },
        {
          name: 'id128 with 8-byte buffer',
          args: [OpCode.Create, spanId, ['id128', id8]],
          assert: () => {
            assert.strictEqual(nativeSpans._cqbCount, 1)
            // A short (8-byte) id128 byte-swaps BE -> LE into the low half and
            // zero-fills the high half.
            assert.strictEqual(readU64LE(nativeSpans._cqbView, 18), 12345n)
            assert.strictEqual(readU64LE(nativeSpans._cqbView, 26), 0n)
          },
        },
        {
          name: 'id128 with 16-byte buffer',
          args: [OpCode.Create, spanId, ['id128', id16]],
          assert: () => {
            assert.strictEqual(nativeSpans._cqbCount, 1)
            // BE layout is [hi=1n][lo=2n]; the LE wire order is [lo][hi].
            assert.strictEqual(readU64LE(nativeSpans._cqbView, 18), 2n)
            assert.strictEqual(readU64LE(nativeSpans._cqbView, 26), 1n)
          },
        },
        {
          name: 'id64',
          args: [OpCode.Create, spanId, ['id64', id64Buf]],
          assert: () => {
            assert.strictEqual(nativeSpans._cqbCount, 1)
            assert.strictEqual(readU64LE(nativeSpans._cqbView, 18), 456n)
          },
        },
        {
          name: 'id64 with null value',
          args: [OpCode.Create, spanId, ['id64', null]],
          assert: () => {
            assert.strictEqual(nativeSpans._cqbCount, 1)
            assert.strictEqual(readU64LE(nativeSpans._cqbView, 18), 0n)
          },
        },
        {
          name: 'ns (ms -> nanoseconds)',
          args: [OpCode.SetStart, spanId, ['ns', 1000]],
          assert: () => {
            assert.strictEqual(nativeSpans._cqbCount, 1)
            // 1000 ms == 1e9 ns.
            assert.strictEqual(readU64LE(nativeSpans._cqbView, 18), 1_000_000_000n)
          },
        },
        {
          name: 'f64',
          args: [OpCode.SetMetricAttr, spanId, 'metric', ['f64', 3.14]],
          assert: () => {
            assert.strictEqual(nativeSpans._cqbCount, 1)
            // The 'metric' key resolves to a u32 string id at bytes 18..21, so
            // the f64 payload starts at byte 22.
            assert.strictEqual(nativeSpans._cqbView.getFloat64(22, true), 3.14)
          },
        },
        {
          name: 'i32',
          args: [OpCode.SetError, spanId, ['i32', 1]],
          assert: () => {
            assert.strictEqual(nativeSpans._cqbCount, 1)
            assert.strictEqual(nativeSpans._cqbView.getInt32(18, true), 1)
          },
        },
      ]

      for (const c of cases) {
        // Reset queue state between cases so byte-offset/count assertions
        // are deterministic regardless of preceding cases.
        nativeSpans.resetChangeQueue()
        // Poison the record region so any byte the encoder fails to write reads
        // back as 0xff. Without this, the `=== 0n` assertions (id128 high half,
        // null id64) would pass vacuously against a freshly-zeroed ArrayBuffer.
        nativeSpans._cqbBytes.fill(0xff, 8, 80)
        nativeSpans.queueOp(...c.args)
        c.assert()
      }
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

      nativeSpans.queueOp(OpCode.SetMetaAttr, spanId, 'key', 'value')

      sinon.assert.called(mockState.flushChangeQueue)
    })

    it('refreshes queue views when stringTableInsertOne grows memory during queueOp', () => {
      const oldBuffer = fakeWasmMemory.buffer
      mockState.stringTableInsertOne.callsFake(() => simulateWasmMemoryGrow(fakeWasmMemory))

      nativeSpans.queueOp(OpCode.SetName, spanId, 'growth-name')

      assert.strictEqual(new DataView(oldBuffer).getUint16(8, true), 0)
      assert.notStrictEqual(nativeSpans._cqbView.buffer, oldBuffer)
      assert.strictEqual(nativeSpans._cqbView.buffer, fakeWasmMemory.buffer)
      assert.strictEqual(nativeSpans._cqbView.getUint16(8, true), OpCode.SetName)
    })
  })

  describe('flushChangeQueue', () => {
    it('flushes to native and resets buffer state on success', () => {
      nativeSpans.queueOp(OpCode.SetName, spanId, 'test')
      nativeSpans.flushChangeQueue()

      sinon.assert.calledOnce(mockState.flushChangeQueue)
      assert.strictEqual(nativeSpans._cqbIndex, 8)
      assert.strictEqual(nativeSpans._cqbCount, 0)
    })

    it('resets the current WASM buffer when memory grows after queueing before flush', () => {
      nativeSpans.queueOp(OpCode.SetName, spanId, 'test')
      const oldBuffer = fakeWasmMemory.buffer
      const grownBuffer = simulateWasmMemoryGrow(fakeWasmMemory)

      mockState.flushChangeQueue.callsFake(() => {
        const grownView = new DataView(grownBuffer)
        assert.strictEqual(readU64LE(grownView, 0), 1n)
        assert.strictEqual(grownView.getUint16(8, true), OpCode.SetName)
      })

      nativeSpans.flushChangeQueue()

      assert.strictEqual(readU64LE(new DataView(grownBuffer), 0), 0n)
      assert.strictEqual(readU64LE(new DataView(oldBuffer), 0), 1n)
    })

    it('should not call native if no operations queued', () => {
      nativeSpans.flushChangeQueue()

      sinon.assert.notCalled(mockState.flushChangeQueue)
    })

    it('swallows a "span not found" error (orphaned span) instead of crashing the host', () => {
      // An op referenced a span missing from native storage. If the offending
      // span cannot be found in the JS buffer, the batch is dropped but this
      // must never throw into application code.
      mockState.flushChangeQueue = sinon.stub().throws(new Error('span not found: 12345'))
      nativeSpans.queueOp(OpCode.SetName, spanId, 'test')

      nativeSpans.flushChangeQueue() // must not throw

      assert.strictEqual(nativeSpans._cqbCount, 0) // batch was reset
    })

    it('preserves sibling ops queued after a span-not-found operation', () => {
      const id1 = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0])
      const id2 = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0])
      const id3 = new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0])
      mockState.flushChangeQueue = sinon.stub()
      mockState.flushChangeQueue.onFirstCall().throws(new Error('span not found: 2'))

      nativeSpans.queueOp(OpCode.SetName, id1, 'first')
      nativeSpans.queueOp(OpCode.SetName, id2, 'missing')
      nativeSpans.queueOp(OpCode.SetName, id3, 'third')

      nativeSpans.flushChangeQueue()

      assert.strictEqual(nativeSpans._cqbCount, 0)
      sinon.assert.calledTwice(mockState.flushChangeQueue)
    })

    it('drops the batch and logs when native flush throws for a reason other than "span not found"', () => {
      // A native fault must never escape: flushChangeQueue runs synchronously
      // inside span.finish()/setTag()/addTags(), so throwing would surface an
      // OOM, wasm trap or op desync as an exception in application code.
      mockState.flushChangeQueue = sinon.stub().throws(new Error('unexpected wasm fault'))
      nativeSpans.queueOp(OpCode.SetName, spanId, 'test')

      nativeSpans.flushChangeQueue()

      sinon.assert.calledWithMatch(logError, /dropped a change-queue batch after a native error/)
      assert.strictEqual(nativeSpans._cqbIndex, 8)
      assert.strictEqual(nativeSpans._cqbCount, 0)
    })

    it('resets the current WASM buffer when native flush grows memory then throws', () => {
      nativeSpans.queueOp(OpCode.SetName, spanId, 'test')
      const oldBuffer = fakeWasmMemory.buffer
      let grownBuffer
      mockState.flushChangeQueue = sinon.stub().callsFake(() => {
        grownBuffer = simulateWasmMemoryGrow(fakeWasmMemory)
        throw new Error('unexpected wasm fault')
      })

      nativeSpans.flushChangeQueue()

      sinon.assert.calledWithMatch(logError, /dropped a change-queue batch after a native error/)
      assert.strictEqual(readU64LE(new DataView(grownBuffer), 0), 0n)
      assert.strictEqual(readU64LE(new DataView(oldBuffer), 0), 1n)
      assert.strictEqual(nativeSpans._cqbView.buffer, grownBuffer)
    })
  })

  describe('flushSpans', () => {
    it('flushes change queue and calls prepareChunk + sendPreparedChunk with spanId indices', async () => {
      // Queue a pending op so flushSpans must drain the change queue
      // before delegating to prepareChunk.
      nativeSpans.queueOp(OpCode.SetName, spanId, 'test')
      const spanIds = [
        new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]),
        new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0]),
        new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0]),
      ]

      await nativeSpans.flushSpans(spanIds, true)

      sinon.assert.callOrder(
        mockState.flushChangeQueue,
        mockState.prepareChunk,
        mockState.sendPreparedChunk
      )
      // Exactly one flushChangeQueue call: the queueOp queued one op, then
      // flushSpans drained it before calling prepareChunk.
      sinon.assert.calledOnce(mockState.flushChangeQueue)
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
      // Span ids are u64 LE (8 bytes each); FLUSH_BUFFER_SIZE starts at
      // 10 KiB. 4000 ids = 32000 bytes => triggers reallocation.
      const spanIds = Array.from({ length: 4000 }, () => new Uint8Array(8))

      await nativeSpans.flushSpans(spanIds, false)

      assert.ok(nativeSpans._flushBuffer.length >= spanIds.length * 8)
    })

    it('refreshes queue views when prepareChunk grows memory during flushSpans', async () => {
      const oldBuffer = fakeWasmMemory.buffer
      mockState.prepareChunk.callsFake(() => {
        simulateWasmMemoryGrow(fakeWasmMemory)
        return true
      })

      await nativeSpans.flushSpans([spanId], true)

      assert.notStrictEqual(nativeSpans._cqbView.buffer, oldBuffer)
      assert.strictEqual(nativeSpans._cqbView.buffer, fakeWasmMemory.buffer)
    })

    it('should reset queue state when prepareChunk throws', async () => {
      // Make flushChangeQueue a no-op so it doesn't reset state itself —
      // this isolates the catch arm of `flushSpans` as the only path that
      // could clean up. Without this, the success-path reset inside
      // `flushChangeQueue` would mask whether the catch arm runs.
      nativeSpans.queueOp(OpCode.SetName, spanId, 'test')
      assert.notStrictEqual(nativeSpans._cqbCount, 0)
      const cqbCountBeforeThrow = nativeSpans._cqbCount
      mockState.flushChangeQueue = sinon.stub() // succeeds without resetting JS state
      mockState.prepareChunk = sinon.stub().throws(new Error('prep failed'))

      // Restore JS-side counters AFTER the no-op flushChangeQueue so the
      // reset can only come from the flushSpans catch arm.
      const origReset = nativeSpans.resetChangeQueue.bind(nativeSpans)
      let resetCallCount = 0
      nativeSpans.resetChangeQueue = function () {
        resetCallCount++
        if (resetCallCount === 1) {
          // Suppress the flushChangeQueue-success-path reset so the catch arm
          // is the only observable path that can clean state.
          return
        }
        origReset()
      }

      await assert.rejects(nativeSpans.flushSpans([spanId], true), /prep failed/)

      assert.ok(mockState.prepareChunk.calledOnce, 'prepareChunk should have been called')
      assert.ok(resetCallCount >= 2, 'resetChangeQueue should run from the flushSpans catch arm')
      assert.strictEqual(nativeSpans._cqbIndex, 8)
      assert.strictEqual(nativeSpans._cqbCount, 0)
      assert.notStrictEqual(cqbCountBeforeThrow, 0)
    })

    it('does not discard the change queue when sendPreparedChunk rejects', async () => {
      // A send failure must NOT reset the change queue: sendPreparedChunk is
      // async, so ops for *other* spans (including their Create) are queued
      // into the shared buffer while the send is in flight. Dropping them would
      // orphan those spans -> "span not found" at their next flush. Here the
      // pre-send op is drained by flushSpans' own flushChangeQueue; then, while
      // the send is "in flight", a new span's op is queued. That op must survive
      // the rejection.
      nativeSpans.queueOp(OpCode.SetName, spanId, 'pre-send')
      const err = new Error('send failed')
      mockState.sendPreparedChunk = sinon.stub().callsFake(() => {
        // Simulate a span created/finished while the send is in flight.
        nativeSpans.queueOp(OpCode.SetName, spanId, 'in-flight')
        return Promise.reject(err)
      })

      await assert.rejects(nativeSpans.flushSpans([spanId], true), err)

      // The op queued during the failed send must be preserved for the next
      // flush, not reset away.
      assert.strictEqual(nativeSpans._cqbCount, 1, 'pending op queued during the in-flight send was dropped')
      sinon.assert.calledOnce(mockState.sendPreparedChunk)
    })

    it('drops the batch, logs and recovers when flushChangeQueue throws', () => {
      nativeSpans.queueOp(OpCode.SetName, spanId, 'test')
      mockState.flushChangeQueue = sinon.stub().throws(new Error('drain failed'))

      nativeSpans.flushChangeQueue()

      // The fault is confined to the log; JS-side counters are reset so future
      // queue writes don't accumulate atop a partially-consumed buffer.
      sinon.assert.calledWithMatch(logError, /dropped a change-queue batch after a native error/)
      assert.strictEqual(nativeSpans._cqbIndex, 8)
      assert.strictEqual(nativeSpans._cqbCount, 0)
    })

    it('flushSpansGrouped stages every group then sends once', async () => {
      // `prepareChunk` appends to a native chunk Vec and `sendPreparedChunk` drains
      // all of it as one multi-trace request, so a flush is N stages + 1 send.
      // Sending per group would issue N sequential HTTP round-trips per flush.
      const idA = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0])
      const idB = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0])

      // Queue an op so the up-front drain actually calls into the pipeline.
      nativeSpans.queueOp(OpCode.SetName, idA, 'x')

      const order = []
      mockState.prepareChunk = sinon.stub().callsFake((len, firstIsLocalRoot) => {
        order.push(`prepare:${firstIsLocalRoot}`)
        return true
      })
      mockState.sendPreparedChunk = sinon.stub().callsFake(() => {
        order.push('send')
        return Promise.resolve('OK')
      })

      const result = await nativeSpans.flushSpansGrouped([
        { spanIds: [idA], firstIsLocalRoot: true },
        { spanIds: [idB], firstIsLocalRoot: false },
      ])

      // Change queue drained exactly once, up front.
      sinon.assert.calledOnce(mockState.flushChangeQueue)
      // One prepareChunk per group, carrying that group's firstIsLocalRoot, and a
      // single send after all staging.
      assert.deepStrictEqual(order, ['prepare:true', 'prepare:false', 'send'])
      assert.strictEqual(result, 'OK')
    })

    it('flushSpansGrouped keeps chunks staged before a mid-flush prepare failure', async () => {
      const idA = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0])
      const idB = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0])
      mockState.prepareChunk = sinon.stub()
      mockState.prepareChunk.onFirstCall().returns(true)
      mockState.prepareChunk.onSecondCall().throws(new Error('span not found: 2'))

      await assert.rejects(nativeSpans.flushSpansGrouped([
        { spanIds: [idA], firstIsLocalRoot: true },
        { spanIds: [idB], firstIsLocalRoot: false },
      ]), /span not found/)

      // Group A is already staged; it must NOT be sent by this failed flush, and it
      // must stay staged so the next flush ships it (these are real spans).
      sinon.assert.notCalled(mockState.sendPreparedChunk)
      assert.strictEqual(nativeSpans._cqbCount, 0)
    })

    it('flushSpansGrouped skips empty groups and does not send when nothing staged', async () => {
      // prepareChunk reports "no spans" (returns false) -> no send.
      mockState.prepareChunk = sinon.stub().returns(false)

      const result = await nativeSpans.flushSpansGrouped([
        { spanIds: [], firstIsLocalRoot: true }, // empty group: skipped entirely
        { spanIds: [spanId], firstIsLocalRoot: true }, // staged nothing (returns false)
      ])

      // Empty group never reaches prepareChunk; the non-empty one returns false.
      sinon.assert.calledOnce(mockState.prepareChunk)
      sinon.assert.notCalled(mockState.sendPreparedChunk)
      assert.strictEqual(result, 'no spans to flush')
    })

    it('evicts string table entries after spans are prepared for export', async () => {
      nativeSpans.queueOp(OpCode.SetMetaAttr, spanId, 'unique.key', 'unique.value')
      assert.ok(nativeSpans._stringMap.size > 0)

      await nativeSpans.flushSpansGrouped([{ spanIds: [spanId], firstIsLocalRoot: true }])

      assert.strictEqual(nativeSpans._stringMap.size, 0)
      sinon.assert.called(mockState.stringTableEvict)
    })

    it('resets the string id counter even when idle eviction already cleared the map', async () => {
      // The JS cache and the WASM table must be reset together: evicting without
      // resetting the counter leaks ids upward forever, and resetting the counter
      // without evicting re-issues live ids to different strings.
      nativeSpans._stringIdCounter = 7
      nativeSpans._stringMap.clear()

      await nativeSpans.flushSpansGrouped([{ spanIds: [spanId], firstIsLocalRoot: true }])

      assert.strictEqual(nativeSpans.getStringId('after-flush'), 0)
    })
  })

  describe('flushStats', () => {
    it('is a no-op resolving true when stats are disabled', async () => {
      // the shared instance is built without statsEnabled
      const result = await nativeSpans.flushStats()
      assert.strictEqual(result, true)
      sinon.assert.notCalled(mockState.flushStats)
    })

    it('force-flushes the native concentrator when stats are enabled', async () => {
      nativeSpans._options.statsEnabled = true
      mockState.flushStats.resetHistory()
      const result = await nativeSpans.flushStats()
      // force=true so the current (partial) bucket ships, unlike the 10s interval
      sinon.assert.calledOnceWithExactly(mockState.flushStats, true)
      assert.strictEqual(result, true)
    })

    it('emits collapsed-span metric and preserves boolean result for native object results', async () => {
      nativeSpans._options.statsEnabled = true
      mockState.flushStats.resolves({ sent: true, collapsedSpans: 12 })

      const result = await nativeSpans.flushStats()

      assert.strictEqual(result, true)
      sinon.assert.calledOnceWithExactly(mockState.flushStats, true)
      sinon.assert.calledOnceWithExactly(
        metricsCount,
        'datadog.tracer.stats.collapsed_spans',
        12,
        'collapsed_spans:whole_key',
        true
      )
    })

    it('emits collapsed-span metric from the periodic stats flush', async () => {
      const clock = sinon.useFakeTimers()
      let statsNativeSpans
      mockState.flushStats.resetHistory()
      mockState.flushStats.resolves({ sent: false, collapsedSpans: 7 })

      try {
        statsNativeSpans = new NativeSpansInterface({
          agentUrl: 'http://localhost:8126',
          tracerVersion: '1.0.0',
          tracerService: 'test-service',
          statsEnabled: true,
        })

        await clock.tickAsync(10_000)

        sinon.assert.calledOnceWithExactly(mockState.flushStats, false)
        sinon.assert.calledOnceWithExactly(
          metricsCount,
          'datadog.tracer.stats.collapsed_spans',
          7,
          'collapsed_spans:whole_key',
          true
        )
      } finally {
        clearInterval(statsNativeSpans?._statsInterval)
        clock.restore()
      }
    })

    it('coalesces overlapping flushes into one native call, then clears the slot', async () => {
      // The native collector holds a RefCell borrow of the stats aggregator
      // across its await, so re-entering it is a Rust BorrowMutError: a wasm
      // trap that aborts the process rather than a rejected promise. The second
      // caller must therefore get the in-flight promise, not a second flush.
      nativeSpans._options.statsEnabled = true
      mockState.flushStats.resetHistory()
      let settleNative
      mockState.flushStats.returns(new Promise((resolve) => { settleNative = resolve }))

      const first = nativeSpans.flushStats()
      const second = nativeSpans.flushStats()

      assert.strictEqual(first, second, 'the second caller joins the in-flight flush')
      sinon.assert.calledOnce(mockState.flushStats)

      settleNative(true)
      assert.deepStrictEqual(await Promise.all([first, second]), [true, true])

      // The slot clears on settle, so the next flush reaches the native layer.
      mockState.flushStats.resolves(true)
      assert.strictEqual(await nativeSpans.flushStats(), true)
      sinon.assert.calledTwice(mockState.flushStats)
    })

    it('clears the in-flight slot when a flush rejects', async () => {
      // A failed flush must not wedge the slot: the interval and every later
      // force-flush would then keep resolving the same stale rejection and the
      // native concentrator would never be drained again.
      nativeSpans._options.statsEnabled = true
      mockState.flushStats.resetHistory()
      mockState.flushStats.onFirstCall().rejects(new Error('stats send failed'))
      mockState.flushStats.onSecondCall().resolves(true)

      await assert.rejects(nativeSpans.flushStats(), /stats send failed/)
      assert.strictEqual(await nativeSpans.flushStats(), true)
      sinon.assert.calledTwice(mockState.flushStats)
    })

    it('stopStatsFlush stops the periodic flush', async () => {
      // Without this the interval keeps calling into wasm for the life of the
      // process after the exporter has disabled itself.
      const clock = sinon.useFakeTimers()
      let statsNativeSpans
      mockState.flushStats.resetHistory()

      try {
        statsNativeSpans = new NativeSpansInterface({
          agentUrl: 'http://localhost:8126',
          tracerVersion: '1.0.0',
          tracerService: 'test-service',
          statsEnabled: true,
        })

        await clock.tickAsync(10_000)
        sinon.assert.calledOnce(mockState.flushStats)

        statsNativeSpans.stopStatsFlush()
        assert.strictEqual(statsNativeSpans._statsInterval, undefined)

        await clock.tickAsync(30_000)
        sinon.assert.calledOnce(mockState.flushStats)
      } finally {
        clearInterval(statsNativeSpans?._statsInterval)
        clock.restore()
      }
    })
  })

  describe('getStringId error recovery', () => {
    it('should not commit to JS map if WASM insert throws', () => {
      mockState.stringTableInsertOne = sinon.stub().throws(new Error('table full'))

      assert.throws(() => nativeSpans.getStringId('boom'), /table full/)

      // The JS map must NOT carry the failed id — otherwise a later
      // queueOp(SetMetaAttr, spanId, 'boom', ...) would emit a dangling
      // string-id reference into the wire format.
      assert.strictEqual(nativeSpans._stringMap.has('boom'), false)
    })
  })

  describe('setAgentUrl', () => {
    it('should refresh both _cqbView and _cqbBytes after reinit', () => {
      // Pre-condition: capture the original buffer reference so we can
      // verify both views were rebuilt against the post-reinit memory.
      const originalView = nativeSpans._cqbView
      const originalBytes = nativeSpans._cqbBytes

      nativeSpans.setAgentUrl('http://localhost:9999')

      // Both views must be replaced — refreshing only `_cqbView` would
      // leave `_cqbBytes` pointed at the detached pre-reinit ArrayBuffer,
      // silently corrupting the next u128 byte-copy.
      assert.notStrictEqual(nativeSpans._cqbView, originalView)
      assert.notStrictEqual(nativeSpans._cqbBytes, originalBytes)
      // And both must point at the same underlying buffer.
      assert.strictEqual(nativeSpans._cqbView.buffer, nativeSpans._cqbBytes.buffer)
    })

    it('frees the superseded state so its change queue is reclaimed', () => {
      const oldState = nativeSpans._state

      nativeSpans.setAgentUrl('http://localhost:9999')

      // Each state owns an 8 MB change queue in the shared WebAssembly.Memory,
      // which never shrinks. Dropping the old state without freeing it leaks that
      // 8 MB per rebuild: measured 2428 MB after 300 rebuilds versus a flat 18 MB
      // with the free, and the wasm32 4 GB ceiling aborts the process.
      // (The stubbed WasmSpanState ctor hands back one shared mock object, so the
      // old and new state are the same reference here; only the free is testable.)
      sinon.assert.calledOnce(oldState.free)
    })

    it('defers the free until an in-flight send settles', async () => {
      let release
      mockState.sendPreparedChunk = sinon.stub().returns(new Promise(resolve => { release = resolve }))
      const oldState = mockState
      const send = nativeSpans.flushSpansGrouped([{ spanIds: [spanId], firstIsLocalRoot: true }])

      nativeSpans.setAgentUrl('http://localhost:9999')

      // `sendPreparedChunk` holds a Rust borrow of the state across its await, so
      // freeing now would be a use-after-free.
      sinon.assert.notCalled(oldState.free)

      release('OK')
      await send
      await Promise.resolve()

      sinon.assert.calledOnce(oldState.free)
    })

    it('should leave JS-side state consistent if WasmSpanState ctor throws', () => {
      const originalState = nativeSpans._state
      // Pre-populate the string map so we can detect a partial reset.
      nativeSpans.getStringId('keep-me')
      const mapSize = nativeSpans._stringMap.size
      const counterBefore = nativeSpans._stringIdCounter

      // Rig the next WasmSpanState construction to throw.
      WasmSpanState.throws(new Error('ctor boom'))

      assert.throws(() => nativeSpans.setAgentUrl('http://localhost:9999'), /ctor boom/)

      // After a failed swap, JS state must still match the OLD WasmSpanState
      // — otherwise subsequent getStringId() calls would corrupt the wire.
      assert.strictEqual(nativeSpans._state, originalState)
      assert.strictEqual(nativeSpans._stringIdCounter, counterBefore)
      assert.strictEqual(nativeSpans._stringMap.size, mapSize)
      assert.ok(nativeSpans._stringMap.has('keep-me'))
    })
  })

  describe('setUseV05 re-apply across setAgentUrl', () => {
    it('re-applies a negotiated v0.5 selection to the rebuilt state', () => {
      nativeSpans.setUseV05(true)
      const newState = { ...mockState, setUseV05: sinon.stub(), change_queue_ptr: sinon.stub().returns(0) }
      WasmSpanState.returns(newState)
      nativeSpans.setAgentUrl('http://localhost:9999')
      // The rebuilt state must have the format re-applied before its first send.
      sinon.assert.calledOnceWithExactly(newState.setUseV05, true)
    })

    it('does not enable v0.5 on the rebuilt state when none was negotiated', () => {
      const newState = { ...mockState, setUseV05: sinon.stub(), change_queue_ptr: sinon.stub().returns(0) }
      WasmSpanState.returns(newState)
      nativeSpans.setAgentUrl('http://localhost:9999')
      sinon.assert.notCalled(newState.setUseV05)
    })
  })

  describe('OTLP config', () => {
    it('forwards setOtlpEndpoint/Protocol/Headers to the native state', () => {
      nativeSpans.setOtlpEndpoint('http://c:4318/v1/traces')
      nativeSpans.setOtlpProtocol('http/protobuf')
      nativeSpans.setOtlpHeaders(['authorization', 'Bearer t'])
      sinon.assert.calledOnceWithExactly(mockState.setOtlpEndpoint, 'http://c:4318/v1/traces')
      sinon.assert.calledOnceWithExactly(mockState.setOtlpProtocol, 'http/protobuf')
      sinon.assert.calledOnceWithExactly(mockState.setOtlpHeaders, ['authorization', 'Bearer t'])
    })

    it('re-applies OTLP config to the rebuilt state across setAgentUrl', () => {
      nativeSpans.setOtlpEndpoint('http://c:4318/v1/traces')
      nativeSpans.setOtlpProtocol('http/protobuf')
      nativeSpans.setOtlpHeaders(['authorization', 'Bearer t'])
      const newState = {
        ...mockState,
        setOtlpEndpoint: sinon.stub(),
        setOtlpProtocol: sinon.stub(),
        setOtlpHeaders: sinon.stub(),
        change_queue_ptr: sinon.stub().returns(0),
      }
      WasmSpanState.returns(newState)
      nativeSpans.setAgentUrl('http://localhost:9999')
      sinon.assert.calledOnceWithExactly(newState.setOtlpEndpoint, 'http://c:4318/v1/traces')
      sinon.assert.calledOnceWithExactly(newState.setOtlpProtocol, 'http/protobuf')
      sinon.assert.calledOnceWithExactly(newState.setOtlpHeaders, ['authorization', 'Bearer t'])
    })

    it('does not configure OTLP on the rebuilt state when none was set', () => {
      const newState = { ...mockState, setOtlpEndpoint: sinon.stub(), change_queue_ptr: sinon.stub().returns(0) }
      WasmSpanState.returns(newState)
      nativeSpans.setAgentUrl('http://localhost:9999')
      sinon.assert.notCalled(newState.setOtlpEndpoint)
    })

    it('does not persist or re-apply a protocol the native layer rejects', () => {
      // setOtlpProtocol forwards first; a rejected value must NOT be persisted,
      // so a later setAgentUrl rebuild never re-applies (and re-throws) it.
      mockState.setOtlpProtocol.throws(new Error('OTLP gRPC export is not supported'))
      nativeSpans.setOtlpEndpoint('http://c:4318/v1/traces')
      assert.throws(() => nativeSpans.setOtlpProtocol('grpc'))
      const newState = {
        ...mockState,
        setOtlpEndpoint: sinon.stub(),
        setOtlpProtocol: sinon.stub(),
        setOtlpHeaders: sinon.stub(),
        change_queue_ptr: sinon.stub().returns(0),
      }
      WasmSpanState.returns(newState)
      nativeSpans.setAgentUrl('http://localhost:9999')
      // Endpoint re-applied; the rejected protocol was never persisted.
      sinon.assert.calledOnceWithExactly(newState.setOtlpEndpoint, 'http://c:4318/v1/traces')
      sinon.assert.notCalled(newState.setOtlpProtocol)
    })
  })

  describe('agent URL normalization', () => {
    const baseOpts = {
      tracerVersion: '1.0.0',
      lang: 'nodejs',
      langVersion: 'v20.0.0',
      langInterpreter: 'v8',
      pid: 1,
      tracerService: 's',
    }

    it('passes a Unix domain socket URL through to the native layer unchanged', () => {
      // eslint-disable-next-line no-new
      new NativeSpansInterface({ ...baseOpts, agentUrl: 'unix:///var/run/datadog/apm.socket' })
      // ddcommon parse_uri understands `unix:///path` directly.
      assert.strictEqual(WasmSpanState.lastCall.args[0], 'unix:///var/run/datadog/apm.socket')
    })

    it('rewrites a Windows named-pipe URL to the windows: scheme', () => {
      // eslint-disable-next-line no-new
      new NativeSpansInterface({ ...baseOpts, agentUrl: 'unix://./pipe/datadog/foo' })
      // `unix://./pipe/...` (legacy pipe form) must become `windows://./pipe/...`
      // so ddcommon decodes the socket path to `//./pipe/...`.
      assert.strictEqual(WasmSpanState.lastCall.args[0], 'windows://./pipe/datadog/foo')
    })

    it('leaves http(s) URLs unchanged', () => {
      // eslint-disable-next-line no-new
      new NativeSpansInterface({ ...baseOpts, agentUrl: 'http://localhost:8126' })
      assert.strictEqual(WasmSpanState.lastCall.args[0], 'http://localhost:8126')
    })

    it('applies the same normalization on setAgentUrl', () => {
      nativeSpans.setAgentUrl('unix://./pipe/datadog/bar')
      assert.strictEqual(WasmSpanState.lastCall.args[0], 'windows://./pipe/datadog/bar')
    })

    it('is idempotent on already-normalized windows: URLs', () => {
      // Normalizing a successfully rewritten URL should not change it.
      // eslint-disable-next-line no-new
      new NativeSpansInterface({ ...baseOpts, agentUrl: 'windows://./pipe/idempotent' })
      assert.strictEqual(WasmSpanState.lastCall.args[0], 'windows://./pipe/idempotent')
    })

    it('properly handles a plain Unix socket path with trailing/edge forms', () => {
      // Any variation that is `unix:///`-syntax should be passed through unchanged.
      const cases = ['unix:///var/run/datadog/apm.socket', 'unix:///path/to/socket', 'unix:///tmp/my.sock']
      for (const url of cases) {
        // eslint-disable-next-line no-new
        new NativeSpansInterface({ ...baseOpts, agentUrl: url })
        assert.strictEqual(WasmSpanState.lastCall.args[0], url)
      }
    })
  })

  // Sampling happens in the JS-side priority sampler — `nativeSpans.sample()`
  // is intentionally not exposed by the WASM pipeline. See the trailing
  // comment in native_spans.js.

  describe('resetChangeQueue', () => {
    it('should reset buffer index and count', () => {
      nativeSpans.queueOp(OpCode.SetName, spanId, 'test')

      nativeSpans.resetChangeQueue()

      assert.strictEqual(nativeSpans._cqbIndex, 8)
      assert.strictEqual(nativeSpans._cqbCount, 0)
    })
  })

  describe('segment allocator', () => {
    it('allocates segment ids sequentially', () => {
      const a = nativeSpans.allocSegment()
      const b = nativeSpans.allocSegment()
      const c = nativeSpans.allocSegment()
      assert.deepStrictEqual([a, b, c], [0, 1, 2])
    })
  })

  describe('queueCreateSpan', () => {
    it('should write a CreateSpan record (opcode 13) and bump count', () => {
      const traceId = Buffer.alloc(8)
      traceId.writeBigUInt64BE(0xabcdn)
      const parentId = Buffer.alloc(8)
      parentId.writeBigUInt64BE(0x1234n)

      // Poison the record region (see queueOp encoding test) so the zero-valued
      // trace-id high half and segment id can't pass vacuously.
      nativeSpans._cqbBytes.fill(0xff, 8, 80)
      nativeSpans.queueCreateSpan(spanId, traceId, 0, parentId, 'op', 1500)

      assert.strictEqual(nativeSpans._cqbCount, 1)
      // Op header is [opcode u16 LE][span_id u64 LE]; opcode sits at offset 8.
      assert.strictEqual(nativeSpans._cqbView.getUint16(8, true), 13)
      assert.deepStrictEqual(nativeSpans._cqbBytes.subarray(10, 18), spanId)
      // Payload: [traceId lo @18][traceId hi @26][segmentId @34][parentId @42]
      //          [nameId u32 @50][start u64 @54]
      assert.strictEqual(readU64LE(nativeSpans._cqbView, 18), 0xabcdn)
      assert.strictEqual(readU64LE(nativeSpans._cqbView, 26), 0n)
      assert.strictEqual(readU64LE(nativeSpans._cqbView, 34), 0n)
      assert.strictEqual(readU64LE(nativeSpans._cqbView, 42), 0x1234n)
      assert.strictEqual(nativeSpans._cqbView.getUint32(50, true), nativeSpans._stringMap.get('op'))
      assert.strictEqual(readU64LE(nativeSpans._cqbView, 54), 1_500_000_000n)
    })

    it('splits a 16-byte trace id into low and high halves', () => {
      const traceId = Buffer.alloc(16)
      traceId.writeBigUInt64BE(0x1122334455667788n, 0)
      traceId.writeBigUInt64BE(0xaabbccddeeff0011n, 8)
      const parentId = Buffer.alloc(8)
      parentId.writeBigUInt64BE(0x1234n)

      nativeSpans.queueCreateSpan(spanId, traceId, 0, parentId, 'op', 1500)

      // BE [hi][lo] becomes LE [lo][hi] on the wire.
      assert.strictEqual(readU64LE(nativeSpans._cqbView, 18), 0xaabbccddeeff0011n)
      assert.strictEqual(readU64LE(nativeSpans._cqbView, 26), 0x1122334455667788n)
    })

    it('writes a zero parent id for a root span', () => {
      const traceId = Buffer.alloc(8)
      traceId.writeBigUInt64BE(0xabcdn)

      // Poison the record region so the zero parent id can't pass vacuously.
      nativeSpans._cqbBytes.fill(0xff, 8, 80)
      nativeSpans.queueCreateSpan(spanId, traceId, 0, null, 'op', 1500)

      assert.strictEqual(readU64LE(nativeSpans._cqbView, 18), 0xabcdn)
      assert.strictEqual(readU64LE(nativeSpans._cqbView, 42), 0n)
    })

    it('refreshes queue views at entry when memory grew before a cached-name create', () => {
      const traceId = Buffer.alloc(8)
      const parentId = Buffer.alloc(8)
      nativeSpans.getStringId('cached-op')
      nativeSpans.resetChangeQueue()
      const oldBuffer = fakeWasmMemory.buffer
      const oldView = nativeSpans._cqbView
      simulateWasmMemoryGrow(fakeWasmMemory)

      nativeSpans.queueCreateSpan(spanId, traceId, 0, parentId, 'cached-op', 1500)

      assert.strictEqual(new DataView(oldBuffer).getUint16(8, true), 0)
      assert.notStrictEqual(nativeSpans._cqbView, oldView)
      assert.strictEqual(nativeSpans._cqbView.buffer, fakeWasmMemory.buffer)
      assert.strictEqual(nativeSpans._cqbView.getUint16(8, true), 13)
    })
  })

  describe('queueBatchMeta / queueBatchMetrics', () => {
    // The change queue is 8 MiB and its first 8 bytes hold the op count, so a
    // batch record starts at byte 8 in a freshly reset queue. That record is
    // [opcode u16][spanId u64][count u32] = 14 bytes of header (which the
    // writers conservatively reserve as 16 when checking headroom) followed by
    // 8 bytes per meta pair or 12 bytes per metric pair.
    const CHANGE_QUEUE_BUFFER_SIZE = 8 * 1024 * 1024
    const RECORD_START = 8
    const RECORD_HEADER_SIZE = 14
    const RECORD_COUNT_OFFSET = RECORD_START + 2 + 8
    // Largest batch that still fits an otherwise empty queue.
    const MAX_META_PAIRS = Math.floor((CHANGE_QUEUE_BUFFER_SIZE - RECORD_START - 16) / 8)
    const MAX_METRIC_PAIRS = Math.floor((CHANGE_QUEUE_BUFFER_SIZE - RECORD_START - 16) / 12)

    // Capture `_cqbCount` as each native flush sees it. One batch that forces a
    // flush of its own first part produced more than one record, which is the
    // observable signature of the oversized-batch split.
    function trackFlushedCounts () {
      const counts = []
      mockState.flushChangeQueue.callsFake(() => counts.push(nativeSpans._cqbCount))
      return counts
    }

    it('is a no-op for empty input', () => {
      const indexBefore = nativeSpans._cqbIndex
      nativeSpans.queueBatchMeta(spanId, [])
      nativeSpans.queueBatchMetrics(spanId, [])
      nativeSpans.queueBatchMetaFlat(spanId, [])
      nativeSpans.queueBatchMetricsFlat(spanId, [])
      assert.strictEqual(nativeSpans._cqbIndex, indexBefore)
      assert.strictEqual(nativeSpans._cqbCount, 0)
    })

    it('writes opcode + count + resolved string IDs for both meta (15) and metric (16)', () => {
      // queueBatchMeta -> opcode 15, both key and value interned as strings.
      nativeSpans.queueBatchMeta(spanId, [['k1', 'v1'], ['k2', 'v2']])

      assert.strictEqual(nativeSpans._cqbCount, 1)
      assert.strictEqual(nativeSpans._cqbView.getUint16(8, true), 15)
      assert.ok(nativeSpans._stringMap.has('k1'))
      assert.ok(nativeSpans._stringMap.has('v1'))
      assert.ok(nativeSpans._stringMap.has('k2'))
      assert.ok(nativeSpans._stringMap.has('v2'))

      // queueBatchMetrics -> opcode 16, only the key is interned;
      // the value is written inline as an f64.
      const metaRecordEnd = nativeSpans._cqbIndex
      nativeSpans.queueBatchMetrics(spanId, [['m1', 1.5], ['m2', 2.5]])

      assert.strictEqual(nativeSpans._cqbCount, 2)
      assert.strictEqual(nativeSpans._cqbView.getUint16(metaRecordEnd, true), 16)
      assert.ok(nativeSpans._stringMap.has('m1'))
      assert.ok(nativeSpans._stringMap.has('m2'))
    })

    it('writes flat meta and metric batches without pair arrays', () => {
      nativeSpans.queueBatchMetaFlat(spanId, ['k1', 'v1', 'k2', 'v2'])

      assert.strictEqual(nativeSpans._cqbCount, 1)
      assert.strictEqual(nativeSpans._cqbView.getUint16(8, true), 15)
      assert.ok(nativeSpans._stringMap.has('k1'))
      assert.ok(nativeSpans._stringMap.has('v1'))
      assert.ok(nativeSpans._stringMap.has('k2'))
      assert.ok(nativeSpans._stringMap.has('v2'))

      const metaRecordEnd = nativeSpans._cqbIndex
      nativeSpans.queueBatchMetricsFlat(spanId, ['m1', 1.5, 'm2', 2.5])

      assert.strictEqual(nativeSpans._cqbCount, 2)
      assert.strictEqual(nativeSpans._cqbView.getUint16(metaRecordEnd, true), 16)
      assert.ok(nativeSpans._stringMap.has('m1'))
      assert.ok(nativeSpans._stringMap.has('m2'))
    })

    it('refreshes queue views at entry for cached flat meta batches after memory growth', () => {
      for (const str of ['k1', 'v1', 'k2', 'v2']) nativeSpans.getStringId(str)
      nativeSpans.resetChangeQueue()
      const oldBuffer = fakeWasmMemory.buffer
      const oldView = nativeSpans._cqbView
      simulateWasmMemoryGrow(fakeWasmMemory)

      nativeSpans.queueBatchMetaFlat(spanId, ['k1', 'v1', 'k2', 'v2'])

      assert.strictEqual(new DataView(oldBuffer).getUint16(8, true), 0)
      assert.notStrictEqual(nativeSpans._cqbView, oldView)
      assert.strictEqual(nativeSpans._cqbView.buffer, fakeWasmMemory.buffer)
      assert.strictEqual(nativeSpans._cqbView.getUint16(8, true), 15)
    })

    it('refreshes queue views at entry for cached flat metric batches after memory growth', () => {
      nativeSpans.getStringId('m1')
      nativeSpans.getStringId('m2')
      nativeSpans.resetChangeQueue()
      const oldBuffer = fakeWasmMemory.buffer
      const oldView = nativeSpans._cqbView
      simulateWasmMemoryGrow(fakeWasmMemory)

      nativeSpans.queueBatchMetricsFlat(spanId, ['m1', 1.5, 'm2', 2.5])

      assert.strictEqual(new DataView(oldBuffer).getUint16(8, true), 0)
      assert.notStrictEqual(nativeSpans._cqbView, oldView)
      assert.strictEqual(nativeSpans._cqbView.buffer, fakeWasmMemory.buffer)
      assert.strictEqual(nativeSpans._cqbView.getUint16(8, true), 16)
    })

    it('splits a meta batch that cannot fit the whole queue instead of writing past it', () => {
      // `_cqbBytes` is a Uint8Array over ALL of wasm memory with no queue-length
      // bound, so a batch larger than the queue would run past it into the Rust
      // heap without throwing. One interned key/value pair is reused for every
      // entry so the string table (and this test) stays cheap.
      const pair = ['oversized.key', 'oversized.value']
      const tags = Array.from({ length: MAX_META_PAIRS + 1 }, () => pair)
      // A pending op makes the first (headroom) flush reach the native layer.
      nativeSpans.queueOp(OpCode.SetName, spanId, 'pending')
      const flushedCounts = trackFlushedCounts()

      nativeSpans.queueBatchMeta(spanId, tags)

      // Flush 1 drained the pending op; flush 2 drained the batch's own first
      // part, so this single batch became two records.
      assert.deepStrictEqual(flushedCounts, [1, 1])
      assert.strictEqual(nativeSpans._cqbCount, 1, 'the second part is still queued')
      assert.ok(
        nativeSpans._cqbIndex <= CHANGE_QUEUE_BUFFER_SIZE,
        `_cqbIndex ${nativeSpans._cqbIndex} ran past the ${CHANGE_QUEUE_BUFFER_SIZE}-byte queue`
      )
      // MAX_META_PAIRS + 1 pairs split into MAX_META_PAIRS and a 1-pair
      // remainder, which is the record left resident.
      assert.strictEqual(nativeSpans._cqbView.getUint16(RECORD_START, true), 15)
      assert.strictEqual(nativeSpans._cqbView.getUint32(RECORD_COUNT_OFFSET, true), 1)
      assert.strictEqual(nativeSpans._cqbIndex, RECORD_START + RECORD_HEADER_SIZE + 8)
    })

    it('splits an oversized flat meta batch (its own copy of the headroom re-check)', () => {
      const tags = Array.from(
        { length: (MAX_META_PAIRS + 1) * 2 },
        (_, i) => (i % 2 === 0 ? 'oversized.key' : 'oversized.value')
      )
      nativeSpans.queueOp(OpCode.SetName, spanId, 'pending')
      const flushedCounts = trackFlushedCounts()

      nativeSpans.queueBatchMetaFlat(spanId, tags)

      assert.deepStrictEqual(flushedCounts, [1, 1])
      assert.strictEqual(nativeSpans._cqbCount, 1)
      assert.ok(
        nativeSpans._cqbIndex <= CHANGE_QUEUE_BUFFER_SIZE,
        `_cqbIndex ${nativeSpans._cqbIndex} ran past the ${CHANGE_QUEUE_BUFFER_SIZE}-byte queue`
      )
      assert.strictEqual(nativeSpans._cqbView.getUint16(RECORD_START, true), 15)
      assert.strictEqual(nativeSpans._cqbView.getUint32(RECORD_COUNT_OFFSET, true), 1)
      assert.strictEqual(nativeSpans._cqbIndex, RECORD_START + RECORD_HEADER_SIZE + 8)
    })

    it('splits a metric batch that cannot fit the whole queue instead of writing past it', () => {
      // Metric pairs cost 12 bytes (u32 key id + f64 value), so the queue holds
      // fewer of them than meta pairs.
      const pair = ['oversized.metric', 1.5]
      const tags = Array.from({ length: MAX_METRIC_PAIRS + 1 }, () => pair)
      nativeSpans.queueOp(OpCode.SetName, spanId, 'pending')
      const flushedCounts = trackFlushedCounts()

      nativeSpans.queueBatchMetrics(spanId, tags)

      assert.deepStrictEqual(flushedCounts, [1, 1])
      assert.strictEqual(nativeSpans._cqbCount, 1)
      assert.ok(
        nativeSpans._cqbIndex <= CHANGE_QUEUE_BUFFER_SIZE,
        `_cqbIndex ${nativeSpans._cqbIndex} ran past the ${CHANGE_QUEUE_BUFFER_SIZE}-byte queue`
      )
      assert.strictEqual(nativeSpans._cqbView.getUint16(RECORD_START, true), 16)
      assert.strictEqual(nativeSpans._cqbView.getUint32(RECORD_COUNT_OFFSET, true), 1)
      assert.strictEqual(nativeSpans._cqbIndex, RECORD_START + RECORD_HEADER_SIZE + 12)
    })

    it('splits an oversized flat metric batch (its own copy of the headroom re-check)', () => {
      const tags = Array.from(
        { length: (MAX_METRIC_PAIRS + 1) * 2 },
        (_, i) => (i % 2 === 0 ? 'oversized.metric' : 1.5)
      )
      nativeSpans.queueOp(OpCode.SetName, spanId, 'pending')
      const flushedCounts = trackFlushedCounts()

      nativeSpans.queueBatchMetricsFlat(spanId, tags)

      assert.deepStrictEqual(flushedCounts, [1, 1])
      assert.strictEqual(nativeSpans._cqbCount, 1)
      assert.ok(
        nativeSpans._cqbIndex <= CHANGE_QUEUE_BUFFER_SIZE,
        `_cqbIndex ${nativeSpans._cqbIndex} ran past the ${CHANGE_QUEUE_BUFFER_SIZE}-byte queue`
      )
      assert.strictEqual(nativeSpans._cqbView.getUint16(RECORD_START, true), 16)
      assert.strictEqual(nativeSpans._cqbView.getUint32(RECORD_COUNT_OFFSET, true), 1)
      assert.strictEqual(nativeSpans._cqbIndex, RECORD_START + RECORD_HEADER_SIZE + 12)
    })

    it('ignores the trailing orphan of an odd-length flat meta batch', () => {
      // The header records `tags.length >> 1` pairs, so writing a pair for the
      // unpaired tail would put one pair more in the record than the header
      // announces and desync every following op in the same flush.
      nativeSpans.queueBatchMetaFlat(spanId, ['k1', 'v1', 'orphan'])

      assert.strictEqual(nativeSpans._cqbCount, 1)
      assert.strictEqual(nativeSpans._cqbView.getUint16(RECORD_START, true), 15)
      assert.strictEqual(nativeSpans._cqbView.getUint32(RECORD_COUNT_OFFSET, true), 1)
      // Exactly one pair's worth of payload: the orphan was neither written nor
      // interned.
      assert.strictEqual(nativeSpans._cqbIndex, RECORD_START + RECORD_HEADER_SIZE + 8)
      assert.ok(!nativeSpans._stringMap.has('orphan'))
    })

    it('ignores the trailing orphan of an odd-length flat metric batch', () => {
      nativeSpans.queueBatchMetricsFlat(spanId, ['m1', 1.5, 'orphan'])

      assert.strictEqual(nativeSpans._cqbCount, 1)
      assert.strictEqual(nativeSpans._cqbView.getUint16(RECORD_START, true), 16)
      assert.strictEqual(nativeSpans._cqbView.getUint32(RECORD_COUNT_OFFSET, true), 1)
      assert.strictEqual(nativeSpans._cqbIndex, RECORD_START + RECORD_HEADER_SIZE + 12)
      assert.ok(!nativeSpans._stringMap.has('orphan'))
    })
  })

  describe('setMetaStruct', () => {
    it('drains the queue, folds the handle little-endian to a u64, and forwards bytes', () => {
      // Queue an op so there is pending work to drain.
      const spanId = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0])
      nativeSpans.queueOp(OpCode.SetError, spanId, ['i32', 1])
      assert.strictEqual(nativeSpans._cqbCount, 1)

      // Non-palindromic handle: LE => 2n (BE would be 0x0200000000000000), so
      // this asserts the LE fold the change buffer keys spans by.
      const handle = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0]) // LE => 2n
      const bytes = new Uint8Array([0x81, 0xa1, 0x61, 0x01])
      nativeSpans.setMetaStruct(handle, 'appsec', bytes)

      // Queue was flushed first (kept in sync with the WASM-internal flush).
      sinon.assert.called(mockState.flushChangeQueue)
      assert.strictEqual(nativeSpans._cqbCount, 0)
      // Handle folds little-endian to the numeric id the WASM state expects
      // (matching queueOp/queueCreateSpan, which copy the LE handle bytes).
      sinon.assert.calledOnceWithExactly(mockState.setMetaStruct, 2n, 'appsec', bytes)
    })
    it('folds the all-ones handle correctly with no sign/wrap error', () => {
      // Queue an op so there is pending work to drain.
      const spanId = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0])
      nativeSpans.queueOp(OpCode.SetError, spanId, ['i32', 1])
      assert.strictEqual(nativeSpans._cqbCount, 1)

      // palindromic: (2n ** 64n) - 1n in either endianness
      const handle = Uint8Array.from([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])
      const bytes = new Uint8Array([0x81, 0xa1, 0x61, 0x01])
      nativeSpans.setMetaStruct(handle, 'appsec', bytes)

      // Queue was flushed first, and the all-ones handle folded to the correct u64 value.
      sinon.assert.called(mockState.flushChangeQueue)
      assert.strictEqual(nativeSpans._cqbCount, 0)
      const expectedId = (2n ** 64n) - 1n
      sinon.assert.calledOnceWithExactly(mockState.setMetaStruct, expectedId, 'appsec', bytes)
    })

    it('refreshes queue views when setMetaStruct grows memory', () => {
      const oldBuffer = fakeWasmMemory.buffer
      mockState.setMetaStruct.callsFake(() => simulateWasmMemoryGrow(fakeWasmMemory))
      const handle = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0])
      const bytes = new Uint8Array([0x81, 0xa1, 0x61, 0x01])

      nativeSpans.setMetaStruct(handle, 'appsec', bytes)

      assert.notStrictEqual(nativeSpans._cqbView.buffer, oldBuffer)
      assert.strictEqual(nativeSpans._cqbView.buffer, fakeWasmMemory.buffer)
    })
  })

  describe('addSpanEvent', () => {
    it('drains the queue and folds the handle little-endian before forwarding', () => {
      // Queue an op so flushChangeQueue has work to drain.
      nativeSpans.queueOp(OpCode.SetError, new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]), ['i32', 1])
      const handle = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0]) // LE => 2n
      const attrs = new Uint8Array([0, 0, 0, 0])
      nativeSpans.addSpanEvent(handle, 'exception', 123n, attrs)
      sinon.assert.called(mockState.flushChangeQueue)
      sinon.assert.calledOnceWithExactly(mockState.addSpanEvent, 2n, 'exception', 123n, attrs)
    })

    it('refreshes queue views when addSpanEvent grows memory', () => {
      const oldBuffer = fakeWasmMemory.buffer
      mockState.addSpanEvent.callsFake(() => simulateWasmMemoryGrow(fakeWasmMemory))
      const handle = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0])
      const attrs = new Uint8Array([0, 0, 0, 0])

      nativeSpans.addSpanEvent(handle, 'exception', 123n, attrs)

      assert.notStrictEqual(nativeSpans._cqbView.buffer, oldBuffer)
      assert.strictEqual(nativeSpans._cqbView.buffer, fakeWasmMemory.buffer)
    })
  })
})
