'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()
const { MsgpackEncoder } = require('../../src/msgpack')

require('../setup/core')

// NativeDatadogSpan extends DatadogSpan, so all inherited behavior (default
// context, trace-started tracking, parent context, start/finish times,
// duration, processor.process, double-finish guard, span links/events
// serialization, toString, etc.) is exercised by
// `packages/dd-trace/test/opentracing/span.spec.js`. This file only covers
// the native subclass's overrides and the native-sync side effects it adds
// on top of the inherited behavior.

describe('NativeDatadogSpan', () => {
  let NativeDatadogSpan
  let span
  let tracer
  let processor
  let prioritySampler
  let nativeSpans
  let now
  let id
  let OpCode
  let NativeSpanContext

  beforeEach(() => {
    sinon.stub(Date, 'now').returns(1500000000000)

    now = sinon.stub().returns(0)

    // Mock ID generator
    const idCounter = { value: 0 }
    id = sinon.stub().callsFake(() => {
      const val = ++idCounter.value
      return {
        toString: () => String(val),
        toBigInt: () => BigInt(val),
        toBuffer: () => {
          const buf = Buffer.alloc(8)
          buf.writeBigUInt64BE(BigInt(val))
          return buf
        },
      }
    })

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

    tracer = {
      _config: {
        tags: {},
      },
      _service: 'test-service',
    }

    processor = {
      process: sinon.stub(),
    }

    prioritySampler = {
      sample: sinon.stub(),
    }

    // NativeSpansInterface allocates a segment id per local trace and uses
    // queueCreateSpan for the combined Create+SetName+SetStart op. Stub
    // these so the constructor can run without touching real WASM.
    let nextSegment = 0
    nativeSpans = {
      queueOp: sinon.stub(),
      queueCreateSpan: sinon.stub(),
      queueBatchMeta: sinon.stub(),
      queueBatchMetrics: sinon.stub(),
      flushChangeQueue: sinon.stub(),
      setMetaStruct: sinon.stub(),
      addSpanEvent: sinon.stub(),
      allocSegment: sinon.stub().callsFake(() => nextSegment++),
      OpCode,
    }

    // Create a mock NativeSpanContext that tracks tags. The real
    // class adds syncToNativeOnly / syncOneTagToNative /
    // _setNameLocal — provide stubs so the production span code can call
    // them without TypeErrors.
    NativeSpanContext = function (ns, props) {
      this._nativeSpans = ns
      this._nativeSpanId = props.spanId.toBuffer()
      this._traceId = props.traceId
      this._spanId = props.spanId
      this._parentId = props.parentId || null
      this._sampling = props.sampling || {}
      this._baggageItems = props.baggageItems || {}
      this._trace = props.trace || {
        started: [],
        finished: [],
        tags: {},
      }
      // Backing store renamed away from `_tags` so the
      // `eslint-no-private-tags-access` rule does not flag mock-internal access.
      this.tagStore = { ...(props.tags || {}) }
      // Mirror the production NativeSpanContext shape: `_name` is a getter/setter
      // pair, and the setter fires `_syncNameToNative` once the context is
      // `[NATIVE_READY]`. The mock starts ready so `setOperationName` writes
      // are observed via the stub.
      let nameValue
      Object.defineProperty(this, '_name', {
        configurable: true,
        get () { return nameValue },
        set (v) {
          nameValue = v
          this._syncNameToNative(v)
        },
      })
      this._hostname = undefined
      this._isFinished = false
      // Per-instance call tracker. The production NativeDatadogSpan
      // shadows the prototype's `_syncNameToNative` with a no-op on
      // the instance during construction (to suppress the parent's
      // double-SetName), then deletes the shadow once super() returns.
      // We keep the underlying tracker as `_syncNameToNativeStub` so
      // tests can still assert against it post-construction.
      this._syncNameToNativeStub = sinon.stub()
      this._setNameLocal = (name) => { nameValue = name }
      // Initial tags are seeded into `_tags` by the parent
      // DatadogSpanContext via Object.assign in `getTags()`; the native
      // span constructor then calls `syncToNativeOnly(fields.tags)` to
      // push them to WASM. The stub here just needs to exist so that
      // production call does not blow up.
      this.syncToNativeOnly = sinon.stub()
      this.syncOneTagToNative = sinon.stub()

      // Tag accessor methods (matching real NativeSpanContext)
      this.setTag = (key, value) => {
        this.tagStore[key] = value
      }
      this.getTag = (key) => {
        return this.tagStore[key]
      }
      this.hasTag = (key) => {
        return key in this.tagStore
      }
      this.deleteTag = (key) => {
        delete this.tagStore[key]
      }
      this.getTags = () => {
        return this.tagStore
      }
    }
    // `_syncNameToNative` lives on the prototype so the production
    // `delete spanContext._syncNameToNative` (which removes only the
    // instance shadow installed during construction) leaves a usable
    // method behind for post-construction `setOperationName` calls.
    NativeSpanContext.prototype._syncNameToNative = function (v) {
      this._syncNameToNativeStub(v)
    }

    // Mock DatadogSpan parent — exercises the relevant constructor
    // surface (calls `_createContext`, sets `_spanContext`, `_name`,
    // tags, hostname, trace.started.push, `_startTime`, `_links`),
    // plus `setOperationName`, `addTags`, and `finish` — so that the
    // NativeDatadogSpan extends/super path is observable in tests
    // without dragging in the real parent class's deps.
    const MockDatadogSpan = class MockDatadogSpan {
      constructor (tracer, processor, prioritySampler, fields, debug) {
        this._processor = processor
        this._prioritySampler = prioritySampler
        this._debug = debug
        this._duration = undefined
        this._events = []
        this._name = fields.operationName
        this._integrationName = fields.integrationName || 'opentracing'
        this._spanContext = this._createContext(fields.parent || null, fields)
        this._spanContext._name = fields.operationName
        Object.assign(this._spanContext.getTags(), { ...fields.tags })
        this._spanContext._hostname = fields.hostname
        this._spanContext._trace.started.push(this)
        this._startTime = fields.startTime || this._getTime()
        this._links = fields.links?.map(link => ({
          context: link.context,
          attributes: link.attributes ?? {},
        })) ?? []
        this._mockTracer = tracer
      }

      tracer () { return this._mockTracer }
      context () { return this._spanContext }
      setOperationName (name) {
        this._spanContext._name = name
        return this
      }

      setTag (key, value) { this._addTags({ [key]: value }); return this }
      addTags (keyValueMap) { this._addTags(keyValueMap); return this }
      _addTags (kv) {
        for (const k of Object.keys(kv)) this._spanContext.tagStore[k] = kv[k]
        this._prioritySampler.sample(this, false)
      }

      _getTime () { return Date.now() }
      finish (finishTime) {
        if (this._duration !== undefined) return
        const t = finishTime === undefined
          ? this._getTime()
          : (Number.parseFloat(finishTime) || this._getTime())
        this._duration = t - this._startTime
        this._spanContext._trace.finished.push(this)
        this._spanContext._isFinished = true
        this._processor.process(this)
      }
    }

    // Mock all dependencies with noCallThru to avoid resolving real modules
    NativeDatadogSpan = proxyquire('../../src/native/span', {
      perf_hooks: {
        performance: { now },
      },
      '../id': id,
      './index': { OpCode },
      './span_context': NativeSpanContext,
      '../opentracing/span': MockDatadogSpan,
      '../opentracing/span_context': class MockDatadogSpanContext {},
      '../tagger': {
        add: (tags, keyValuePairs) => {
          for (const [key, value] of Object.entries(keyValuePairs)) {
            tags[key] = value
          }
        },
      },
    })
  })

  afterEach(() => {
    Date.now.restore()
  })

  describe('constructor', () => {
    it('should issue a combined queueCreateSpan op to native', () => {
      // queueCreateSpan emits a single combined opcode that encodes name and
      // start time alongside Create, saving WASM round-trips on construction.
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation',
      }, false, nativeSpans)

      sinon.assert.calledOnce(nativeSpans.queueCreateSpan)
      const args = nativeSpans.queueCreateSpan.getCall(0).args
      // queueCreateSpan(spanId, traceId, segmentId, parentId, name, startMs)
      assert.ok(args[0] instanceof Uint8Array) // spanId (8-byte LE handle)
      assert.strictEqual(typeof args[2], 'number') // segmentId
      assert.strictEqual(args[4], 'test-operation') // name
      assert.strictEqual(typeof args[5], 'number') // startMs
    })

    it('gives child spans the same 128-bit native trace id as the root (not zero-padded)', () => {
      const root = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'root',
        traceId128BitGenerationEnabled: true,
      }, false, nativeSpans)
      const rootTraceId = nativeSpans.queueCreateSpan.getCall(0).args[1]
      assert.ok(Array.isArray(rootTraceId) && rootTraceId.length === 16, 'root trace id should be 16 bytes')
      assert.ok(rootTraceId.slice(0, 8).some(b => b !== 0), 'root high 8 bytes (tid) should be non-zero')

      nativeSpans.queueCreateSpan.resetHistory()
      // eslint-disable-next-line no-new
      new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'child',
        parent: root.context(),
        traceId128BitGenerationEnabled: true,
      }, false, nativeSpans)
      const childTraceId = nativeSpans.queueCreateSpan.getCall(0).args[1]
      // Child must carry the SAME full 128-bit id, not a high-bits-zeroed one.
      assert.deepStrictEqual(childTraceId, rootTraceId)
    })

    it('builds the full 128-bit id for a child of a propagated (16-byte) trace id', () => {
      // Propagated 128-bit context: _traceId.toBuffer() is 16 bytes [high 8][low 8].
      const high = [0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44]
      const low = [1, 2, 3, 4, 5, 6, 7, 8]
      const sixteen = Buffer.from([...high, ...low])
      const tidHex = Buffer.from(high).toString('hex')
      const parent = {
        _traceId: { toBuffer: () => sixteen, toString: () => 't' },
        _spanId: { toBuffer: () => Buffer.from(low), toString: () => 'p' },
        _sampling: {},
        _baggageItems: {},
        _trace: { started: [{}], finished: [], tags: { '_dd.p.tid': tidHex } },
        _tracestate: undefined,
      }
      // eslint-disable-next-line no-new
      new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'child',
        parent,
        traceId128BitGenerationEnabled: true,
      }, false, nativeSpans)
      const childTraceId = nativeSpans.queueCreateSpan.getCall(0).args[1]
      // Low 8 bytes come from slice(-8) of the 16-byte id, not [0..7] (the high bytes).
      assert.deepStrictEqual(childTraceId, [...high, ...low])
    })

    it('should NOT also issue a separate SetName op on init', () => {
      // CreateSpan already carries the name; the subclass shadows
      // `_syncNameToNative` with a no-op so the parent constructor's
      // `_spanContext._name = operationName` line doesn't double-emit.
      // We assert at the WASM-op level (no SetName op queued) rather
      // than against the `_syncNameToNative` stub directly, since the
      // shadow replaces the instance property during construction.
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation',
      }, false, nativeSpans)

      for (const call of nativeSpans.queueOp.getCalls()) {
        assert.notStrictEqual(call.args[0], OpCode.SetName,
          'no separate SetName op should be queued during construction')
      }
      assert.strictEqual(span.context()._name, 'test-operation')
    })

    it('should throw when wrapping an existing NativeSpanContext', () => {
      // Re-wrapping a NativeSpanContext would duplicate the span under two
      // span ids. Throw so callers get a loud error rather than a silent
      // double-emit.
      const nativeContext = { _nativeSpanId: new Uint8Array(8) }
      assert.throws(
        () => new NativeDatadogSpan(tracer, processor, prioritySampler, {
          operationName: 'test',
          context: nativeContext,
        }, false, nativeSpans),
        /cannot wrap an existing NativeSpanContext/
      )
      sinon.assert.notCalled(nativeSpans.queueCreateSpan)
    })
  })

  describe('setOperationName', () => {
    it('should update operation name and sync to native', () => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'original-name',
      }, false, nativeSpans)

      span.setOperationName('new-name')

      assert.strictEqual(span.context()._name, 'new-name')
      // The prototype `_syncNameToNative` delegates to the per-instance
      // `_syncNameToNativeStub` (so the construction-time shadow doesn't
      // erase call history). See the NativeSpanContext mock definition.
      sinon.assert.calledWith(span.context()._syncNameToNativeStub, 'new-name')
    })
  })

  // Baggage operations (setBaggageItem, getBaggageItem, getAllBaggageItems,
  // removeBaggageItem, removeAllBaggageItems) are inherited from DatadogSpan
  // and are covered by `packages/dd-trace/test/opentracing/span.spec.js`.
  // The native subclass doesn't override any of them, so we don't re-test here.

  describe('setTag / addTags', () => {
    beforeEach(() => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation',
      }, false, nativeSpans)
    })

    it('should sync setTag value to native via syncOneTagToNative', () => {
      span.context().syncOneTagToNative.resetHistory()
      span.setTag('http.url', 'https://example.test/x')
      sinon.assert.calledWith(span.context().syncOneTagToNative, 'http.url', 'https://example.test/x')
    })

    it('should sync addTags batch to native via syncToNativeOnly', () => {
      span.context().syncToNativeOnly.resetHistory()
      const batch = { 'http.method': 'GET', 'http.status_code': 200 }
      span.addTags(batch)
      sinon.assert.calledWith(span.context().syncToNativeOnly, batch)
    })

    it('publishes dd-trace:span:tags:update after addTags (so subscribers like the wall profiler refresh)', () => {
      const { channel } = require('dc-polyfill')
      const ch = channel('dd-trace:span:tags:update')
      const onUpdate = sinon.stub()
      ch.subscribe(onUpdate)
      try {
        span.addTags({ 'span.type': 'web' })
        sinon.assert.calledWith(onUpdate, span)
      } finally {
        ch.unsubscribe(onUpdate)
      }
    })

    it('should call prioritySampler.sample when priority is undefined', () => {
      // Fresh span: priority starts undefined; setTag should re-evaluate sampling.
      prioritySampler.sample.resetHistory()
      span._spanContext._sampling = {}
      span.setTag('manual.keep', true)
      sinon.assert.calledOnce(prioritySampler.sample)
    })

    it('should skip prioritySampler.sample when priority is already set', () => {
      // Priority short-circuit: avoid the dispatch + arg setup on the
      // setTag/addTags hot path once a priority has been decided.
      prioritySampler.sample.resetHistory()
      span._spanContext._sampling = { priority: 1 }
      span.setTag('http.method', 'GET')
      sinon.assert.notCalled(prioritySampler.sample)
    })
  })

  describe('finish', () => {
    beforeEach(() => {
      now.onFirstCall().returns(100)
      now.onSecondCall().returns(100)

      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation',
      }, false, nativeSpans)

      now.resetHistory()
      now.returns(500)
    })

    it('should queue SetDuration operation to native', () => {
      span.finish()

      // finish() encodes duration with the 'ns' tag, which converts the
      // JS-side ms duration to a u64 LE nanosecond value.
      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetDuration,
        sinon.match.any,
        ['ns', sinon.match.number]
      )
    })

    it('forwards qualifying meta_struct entries as msgpack bytes, skipping null/boolean', () => {
      span.meta_struct = { obj: { a: 1 }, str: 'x', num: 5, nil: null, bool: true }

      span.finish()

      // string, number and non-null object are forwarded; null and boolean are
      // dropped (mirrors the legacy #encodeMetaStruct value filter).
      sinon.assert.calledThrice(nativeSpans.setMetaStruct)
      const keys = nativeSpans.setMetaStruct.getCalls().map(c => c.args[1])
      assert.deepEqual(keys.sort(), ['num', 'obj', 'str'])

      const expected = new MsgpackEncoder().encode({ a: 1 })
      const objCall = nativeSpans.setMetaStruct.getCalls().find(c => c.args[1] === 'obj')
      assert.deepEqual(Uint8Array.from(objCall.args[2]), Uint8Array.from(expected))
    })

    it('does not call setMetaStruct when the span has no meta_struct', () => {
      span.finish()
      sinon.assert.notCalled(nativeSpans.setMetaStruct)
    })

    it('forwards each span event to the native setter when DD_TRACE_NATIVE_SPAN_EVENTS is enabled', () => {
      tracer._config.DD_TRACE_NATIVE_SPAN_EVENTS = true
      span._events.push({
        name: 'exception',
        startTime: 2,
        attributes: { msg: 'boom', code: 42, ratio: 0.5, ok: true, tags: ['a', 'b'] },
      })
      span._events.push({ name: 'plain', startTime: 3 })

      span.finish()

      sinon.assert.calledTwice(nativeSpans.addSpanEvent)
      const first = nativeSpans.addSpanEvent.getCall(0)
      assert.strictEqual(first.args[0], span._spanContext._nativeSpanId)
      assert.strictEqual(first.args[1], 'exception')
      assert.strictEqual(first.args[2], BigInt(Math.round(2 * 1e6)))
      assert.deepStrictEqual(decodeSpanEventAttrs(first.args[3]), {
        msg: 'boom', code: 42n, ratio: 0.5, ok: true, tags: ['a', 'b'],
      })

      const second = nativeSpans.addSpanEvent.getCall(1)
      assert.strictEqual(second.args[1], 'plain')
      assert.strictEqual(second.args[3].length, 0) // no attributes

      // The meta-tag fallback must NOT be written on the native path.
      assert.strictEqual(span._spanContext.getTag('_dd.span_events'), undefined)
    })

    it('falls back to the _dd.span_events meta tag when the flag is disabled', () => {
      tracer._config.DD_TRACE_NATIVE_SPAN_EVENTS = false
      span._events.push({ name: 'evt', startTime: 1, attributes: { k: 'v' } })

      span.finish()

      sinon.assert.notCalled(nativeSpans.addSpanEvent)
      const parsed = JSON.parse(span._spanContext.getTag('_dd.span_events'))
      assert.strictEqual(parsed[0].name, 'evt')
      assert.strictEqual(parsed[0].time_unix_nano, Math.round(1 * 1e6))
      assert.deepStrictEqual(parsed[0].attributes, { k: 'v' })
    })

    it('does not touch either span-events path when there are no events', () => {
      tracer._config.DD_TRACE_NATIVE_SPAN_EVENTS = true
      span.finish()
      sinon.assert.notCalled(nativeSpans.addSpanEvent)
      assert.strictEqual(span._spanContext.getTag('_dd.span_events'), undefined)
    })

    it('encodes an integer beyond i64/safe range as a double instead of throwing', () => {
      tracer._config.DD_TRACE_NATIVE_SPAN_EVENTS = true
      // 1e21 is an integer-valued float but exceeds i64 range; writeBigInt64LE
      // would throw, so it must be encoded as a double (tag 3), not i64.
      span._events.push({ name: 'big', startTime: 1, attributes: { n: 1e21 } })

      span.finish() // must not throw on the i64-overflow value

      const attrs = decodeSpanEventAttrs(nativeSpans.addSpanEvent.getCall(0).args[3])
      assert.strictEqual(typeof attrs.n, 'number') // double, not BigInt
      assert.strictEqual(attrs.n, 1e21)
    })
  })
})

// Mirror of `decode_span_event_attributes` (libdatadog-nodejs pipeline crate):
// decodes the flat attribute buffer the production encoder produces so tests
// can assert the typed round-trip. Integers come back as BigInt (i64).
function decodeSpanEventAttrs (buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let i = 0
  const u32 = () => { const v = dv.getUint32(i, true); i += 4; return v }
  const u8 = () => buf[i++]
  const str = () => {
    const len = u32()
    const s = Buffer.from(buf.buffer, buf.byteOffset + i, len).toString('utf8')
    i += len
    return s
  }
  const scalar = (tag) => {
    switch (tag) {
      case 0: return str()
      case 1: return u8() !== 0
      case 2: { const v = dv.getBigInt64(i, true); i += 8; return v }
      case 3: { const v = dv.getFloat64(i, true); i += 8; return v }
      default: throw new Error(`bad span-event attr tag: ${tag}`)
    }
  }
  const out = {}
  while (i < buf.length) {
    const key = str()
    const tag = u8()
    if (tag === 4) {
      const count = u32()
      const arr = []
      for (let n = 0; n < count; n++) arr.push(scalar(u8()))
      out[key] = arr
    } else {
      out[key] = scalar(tag)
    }
  }
  return out
}
