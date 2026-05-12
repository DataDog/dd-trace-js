'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

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

    // NativeSpansInterface allocates slot indices and uses
    // queueCreateSpan for the combined Create+SetName+SetStart op. Stub
    // both so the constructor can run without touching real WASM.
    let nextSlot = 0
    nativeSpans = {
      queueOp: sinon.stub(),
      queueCreateSpan: sinon.stub(),
      queueBatchMeta: sinon.stub(),
      queueBatchMetrics: sinon.stub(),
      flushChangeQueue: sinon.stub(),
      allocSlot: sinon.stub().callsFake(() => nextSlot++),
      freeSlots: sinon.stub(),
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
      this._slotIndex = props.slotIndex
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
      // queueCreateSpan(slotIndex, spanId, traceId, parentId, name, startMs)
      assert.strictEqual(typeof args[0], 'number') // slotIndex
      assert.strictEqual(args[4], 'test-operation') // name
      assert.strictEqual(typeof args[5], 'number') // startMs
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

    it('should free the slot and throw when wrapping an existing NativeSpanContext', () => {
      // Re-wrapping a NativeSpanContext would either leak the just-allocated
      // slot (early return) or duplicate the span across two slots. We free
      // the slot and throw so callers get a loud error rather than silent
      // resource exhaustion.
      const nativeContext = { _nativeSpanId: new Uint8Array(8), _slotIndex: 7 }
      assert.throws(
        () => new NativeDatadogSpan(tracer, processor, prioritySampler, {
          operationName: 'test',
          context: nativeContext,
        }, false, nativeSpans),
        /cannot wrap an existing NativeSpanContext/
      )
      sinon.assert.calledWith(nativeSpans.freeSlots, sinon.match.array)
      const freedSlots = nativeSpans.freeSlots.getCall(0).args[0]
      assert.strictEqual(freedSlots.length, 1, 'expected exactly one slot freed')
      assert.strictEqual(typeof freedSlots[0], 'number')
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
  })
})
