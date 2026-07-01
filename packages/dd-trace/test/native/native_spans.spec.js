'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

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
      getTraceOrigin: sinon.stub().returns('synthetics'),
      setMetaStruct: sinon.stub(),
      addSpanEvent: sinon.stub(),
      setUseV05: sinon.stub(),
      setOtlpEndpoint: sinon.stub(),
      setOtlpProtocol: sinon.stub(),
      setOtlpHeaders: sinon.stub(),
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
        OpCode,
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
          },
        },
        {
          name: 'id128 with 16-byte buffer',
          args: [OpCode.Create, spanId, ['id128', id16]],
          assert: () => {
            assert.strictEqual(nativeSpans._cqbCount, 1)
          },
        },
        {
          name: 'id64',
          args: [OpCode.Create, spanId, ['id64', id64Buf]],
          assert: () => {
            assert.strictEqual(nativeSpans._cqbCount, 1)
          },
        },
        {
          name: 'id64 with null value',
          args: [OpCode.Create, spanId, ['id64', null]],
          assert: () => {
            assert.strictEqual(nativeSpans._cqbCount, 1)
          },
        },
        {
          name: 'ns (ms -> nanoseconds)',
          args: [OpCode.SetStart, spanId, ['ns', 1000]],
          assert: () => {
            assert.strictEqual(nativeSpans._cqbCount, 1)
          },
        },
        {
          name: 'f64',
          args: [OpCode.SetMetricAttr, spanId, 'metric', ['f64', 3.14]],
          assert: () => {
            assert.strictEqual(nativeSpans._cqbCount, 1)
          },
        },
        {
          name: 'i32',
          args: [OpCode.SetError, spanId, ['i32', 1]],
          assert: () => {
            assert.strictEqual(nativeSpans._cqbCount, 1)
          },
        },
      ]

      for (const c of cases) {
        // Reset queue state between cases so byte-offset/count assertions
        // are deterministic regardless of preceding cases.
        nativeSpans.resetChangeQueue()
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
  })

  describe('flushChangeQueue', () => {
    it('flushes to native and resets buffer state on success', () => {
      nativeSpans.queueOp(OpCode.SetName, spanId, 'test')
      nativeSpans.flushChangeQueue()

      sinon.assert.calledOnce(mockState.flushChangeQueue)
      assert.strictEqual(nativeSpans._cqbIndex, 8)
      assert.strictEqual(nativeSpans._cqbCount, 0)
    })

    it('should not call native if no operations queued', () => {
      nativeSpans.flushChangeQueue()

      sinon.assert.notCalled(mockState.flushChangeQueue)
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

    it('should reset queue state when sendPreparedChunk rejects', async () => {
      nativeSpans.queueOp(OpCode.SetName, spanId, 'test')
      assert.notStrictEqual(nativeSpans._cqbCount, 0)
      const err = new Error('send failed')
      mockState.sendPreparedChunk = sinon.stub().rejects(err)

      await assert.rejects(nativeSpans.flushSpans([spanId], true), err)

      assert.strictEqual(nativeSpans._cqbIndex, 8)
      assert.strictEqual(nativeSpans._cqbCount, 0)
    })

    it('should rethrow + recover when flushChangeQueue throws', () => {
      nativeSpans.queueOp(OpCode.SetName, spanId, 'test')
      mockState.flushChangeQueue = sinon.stub().throws(new Error('drain failed'))

      assert.throws(() => nativeSpans.flushChangeQueue(), /drain failed/)

      // Even on rethrow, JS-side counters are reset so future queue writes
      // don't accumulate atop a partially-consumed buffer.
      assert.strictEqual(nativeSpans._cqbIndex, 8)
      assert.strictEqual(nativeSpans._cqbCount, 0)
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
      const ns = new NativeSpansInterface({ ...baseOpts, agentUrl: 'unix:///var/run/datadog/apm.socket' })
      assert.ok(ns)
      // ddcommon parse_uri understands `unix:///path` directly.
      assert.strictEqual(WasmSpanState.lastCall.args[0], 'unix:///var/run/datadog/apm.socket')
    })

    it('rewrites a Windows named-pipe URL to the windows: scheme', () => {
      const ns = new NativeSpansInterface({ ...baseOpts, agentUrl: 'unix://./pipe/datadog/foo' })
      assert.ok(ns)
      // `unix://./pipe/...` (legacy pipe form) must become `windows://./pipe/...`
      // so ddcommon decodes the socket path to `//./pipe/...`.
      assert.strictEqual(WasmSpanState.lastCall.args[0], 'windows://./pipe/datadog/foo')
    })

    it('leaves http(s) URLs unchanged', () => {
      const ns = new NativeSpansInterface({ ...baseOpts, agentUrl: 'http://localhost:8126' })
      assert.ok(ns)
      assert.strictEqual(WasmSpanState.lastCall.args[0], 'http://localhost:8126')
    })

    it('applies the same normalization on setAgentUrl', () => {
      nativeSpans.setAgentUrl('unix://./pipe/datadog/bar')
      assert.strictEqual(WasmSpanState.lastCall.args[0], 'windows://./pipe/datadog/bar')
    })

    it('is idempotent on already-normalized windows: URLs', () => {
      // Normalizing a successfully rewritten URL should not change it.
      const ns = new NativeSpansInterface({ ...baseOpts, agentUrl: 'windows://./pipe/idempotent' })
      assert.ok(ns)
      assert.strictEqual(WasmSpanState.lastCall.args[0], 'windows://./pipe/idempotent')
    })

    it('properly handles a plain Unix socket path with trailing/edge forms', () => {
      // Any variation that is `unix:///`-syntax should be passed through unchanged.
      const cases = ['unix:///var/run/datadog/apm.socket', 'unix:///path/to/socket', 'unix:///tmp/my.sock']
      for (const url of cases) {
        const ns = new NativeSpansInterface({ ...baseOpts, agentUrl: url })
        assert.ok(ns)
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

      nativeSpans.queueCreateSpan(spanId, traceId, 0, parentId, 'op', 1500)

      assert.strictEqual(nativeSpans._cqbCount, 1)
      // Op header is [opcode u16 LE][span_id u64 LE]; opcode sits at offset 8.
      assert.strictEqual(nativeSpans._cqbView.getUint16(8, true), 13)
    })
  })

  describe('queueBatchMeta / queueBatchMetrics', () => {
    it('is a no-op for empty input', () => {
      const indexBefore = nativeSpans._cqbIndex
      nativeSpans.queueBatchMeta(spanId, [])
      nativeSpans.queueBatchMetrics(spanId, [])
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
  })
})
