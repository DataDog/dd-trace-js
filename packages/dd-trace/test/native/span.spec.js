'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()
const { encode: encodeMsgpack } = require('../../src/msgpack')

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
      _exporter: {
        _trackSpanStart: sinon.stub(),
        _trackSpanFinish: sinon.stub(),
      },
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

    // Create a mock NativeSpanContext that tracks tags. On top of
    // DatadogSpanContext the real class adds `_setNameLocal`,
    // `markExported`/`isExported`, `syncFinalTagsToNative` and
    // `applyOtelHttpSemantics` — provide those so the production span code can
    // call them without TypeErrors.
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
      // Mirror the production NativeSpanContext shape: `_name` is a plain
      // getter/setter pair over a local slot which queues no WASM op. The name
      // reaches native storage through `queueCreateSpan` at start and through
      // `syncFinalTagsToNative`'s SetName op at finish.
      let nameValue
      Object.defineProperty(this, '_name', {
        configurable: true,
        get () { return nameValue },
        set (v) { nameValue = v },
      })
      this._hostname = undefined
      this._isFinished = false
      this._setNameLocal = (name) => { nameValue = name }
      // Driven by the span processor at export time rather than by
      // NativeDatadogSpan; stubbed so nothing here can call them blind.
      this.syncFinalTagsToNative = sinon.stub()
      this.applyOtelHttpSemantics = sinon.stub()
      this.markExported = () => { this.exported = true }
      this.isExported = () => this.exported === true

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

    it('derives the start time from the clock for `startTime: 0` instead of recording 1970', () => {
      // `_createContext` coerces the caller's start with `||`, exactly as the
      // parent constructor's `fields.startTime || this._getTime()` does.
      // `startTime: 0` is the one input where an `=== undefined` check diverges:
      // it would forward 0 verbatim to queueCreateSpan (start = 1970 in WASM)
      // while the parent's `||` fell back to the current time for `_startTime`,
      // so the exported span's start would not match the JS-side value that
      // consumers such as LLMObs read.
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'zero-start',
        startTime: 0,
      }, false, nativeSpans)

      const startArg = nativeSpans.queueCreateSpan.getCall(0).args[5]
      assert.strictEqual(startArg, 1500000000000) // the stubbed clock, not 0
      assert.strictEqual(startArg, span._startTime)
    })

    it('passes the parent span id as the queueCreateSpan parent id', () => {
      // Regression guard for the parent_id field: dropping it (or reading the
      // Identifier's bytes the wrong way downstream) zeroes parent_id in the
      // wire record, which exports every child span as a root.
      const parent = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'parent',
      }, false, nativeSpans)
      // A root span has no parent id at all.
      assert.strictEqual(nativeSpans.queueCreateSpan.getCall(0).args[3], null)

      nativeSpans.queueCreateSpan.resetHistory()
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'child',
        parent: parent.context(),
      }, false, nativeSpans)

      const parentIdArg = nativeSpans.queueCreateSpan.getCall(0).args[3]
      assert.ok(parentIdArg, 'child parent id must not be null/undefined')
      assert.deepStrictEqual(
        Buffer.from(parentIdArg.toBuffer()),
        Buffer.from(parent.context()._spanId.toBuffer())
      )
      // ...and it must be the parent's id, not the child's own span id.
      assert.notDeepStrictEqual(
        Buffer.from(parentIdArg.toBuffer()),
        Buffer.from(span.context()._spanId.toBuffer())
      )
    })

    it('defaults the resource to the operation name when no resource.name is supplied', () => {
      // The JS formatter defaulted resource to the span name; native has no
      // format step, so the span must queue SetResourceName(name) at creation.
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation',
      }, false, nativeSpans)

      const resourceOps = nativeSpans.queueOp.getCalls()
        .filter(c => c.args[0] === OpCode.SetResourceName)
        .map(c => c.args[2])
      assert.deepStrictEqual(resourceOps, ['test-operation'])
    })

    it('stamps meta.language = javascript at creation (matches the JS formatter)', () => {
      // The JS formatter set `meta.language = 'javascript'` on every span; native
      // has no format step and the agent would otherwise backfill `nodejs` from
      // the Datadog-Meta-Lang header.
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation',
      }, false, nativeSpans)

      sinon.assert.calledWith(nativeSpans.queueOp, OpCode.SetMetaAttr, sinon.match.any, 'language', 'javascript')
    })

    it('tracks active native spans on the exporter', () => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation',
      }, false, nativeSpans)

      sinon.assert.calledOnce(processor._exporter._trackSpanStart)
    })

    it('coerces a non-string operation name so the WASM string table never sees undefined', () => {
      // The dd-trace-api shim can create a span with an undefined operation
      // name; the JS formatter exported String(name), so native must too rather
      // than crash interning `undefined` (getStringId reads `.length`). Calling
      // the constructor directly (no assert.doesNotThrow) fails the test if it
      // throws, which is the behavior we're asserting.
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: undefined,
      }, false, nativeSpans)
      const createCall = nativeSpans.queueCreateSpan.getCall(0)
      assert.strictEqual(createCall.args[4], 'undefined')
    })

    it('skips the default resource when a string resource.name is supplied at creation', () => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation',
        tags: { 'resource.name': 'GET /users' },
      }, false, nativeSpans)

      // No default SetResourceName op is queued at creation: `_createContext`
      // skips the operation-name default when `fields.tags['resource.name']` is
      // a string. That explicit value then reaches WASM only through the
      // finish-time formatted snapshot (`syncFinalTagsToNative`).
      const resourceOps = nativeSpans.queueOp.getCalls().filter(c => c.args[0] === OpCode.SetResourceName)
      assert.strictEqual(resourceOps.length, 0)
    })

    it('defaults the resource to the operation name without a string resource.name', () => {
      // The skip above is keyed on `typeof === 'string'`, so an absent or
      // non-string `resource.name` must still get SetResourceName(name).
      for (const tags of [undefined, { 'resource.name': 42 }]) {
        nativeSpans.queueOp.resetHistory()
        // eslint-disable-next-line no-new
        new NativeDatadogSpan(tracer, processor, prioritySampler, {
          operationName: 'test-operation',
          tags,
        }, false, nativeSpans)

        sinon.assert.calledWith(
          nativeSpans.queueOp, OpCode.SetResourceName, sinon.match.any, 'test-operation'
        )
      }
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

    it('rebuilds the high 8 bytes when consecutive spans belong to traces with different tids', () => {
      // The `_dd.p.tid` -> high-8-bytes memo in src/native/span.js is
      // MODULE-level state keyed on the tid hex. Dropping that key comparison
      // (serving the cached array whenever one exists) splices trace A's high
      // bytes onto trace B's spans, recording B's children under a foreign
      // 128-bit trace id. The other 128-bit tests each use a single tid per
      // module instance — the spec re-proxyquires the module in `beforeEach`, so
      // the memo always starts empty there and never has to be invalidated.
      // Only alternating tids against the SAME instance observes the miss.
      const propagatedParent = (high, low) => ({
        _traceId: { toBuffer: () => Buffer.from([...high, ...low]), toString: () => 't' },
        _spanId: { toBuffer: () => Buffer.from(low), toString: () => 'p' },
        _sampling: {},
        _baggageItems: {},
        _trace: { started: [{}], finished: [], tags: { '_dd.p.tid': Buffer.from(high).toString('hex') } },
        _tracestate: undefined,
      })
      const highA = [0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44]
      const lowA = [1, 2, 3, 4, 5, 6, 7, 8]
      const highB = [0x0f, 0x1e, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78]
      const lowB = [9, 10, 11, 12, 13, 14, 15, 16]
      const parentA = propagatedParent(highA, lowA)
      const parentB = propagatedParent(highB, lowB)

      const childTraceIdUnder = (parent) => {
        nativeSpans.queueCreateSpan.resetHistory()
        // eslint-disable-next-line no-new
        new NativeDatadogSpan(tracer, processor, prioritySampler, {
          operationName: 'child',
          parent,
          traceId128BitGenerationEnabled: true,
        }, false, nativeSpans)
        return nativeSpans.queueCreateSpan.getCall(0).args[1]
      }

      // Warm the memo with tid A, then switch traces: B's span must carry B's
      // own high bytes.
      assert.deepStrictEqual(childTraceIdUnder(parentA), [...highA, ...lowA])
      assert.deepStrictEqual(childTraceIdUnder(parentB), [...highB, ...lowB])
      // Re-entry: back on trace A the high bytes must be A's again, not the
      // now-cached B ones.
      assert.deepStrictEqual(childTraceIdUnder(parentA), [...highA, ...lowA])
    })

    it('should NOT also issue a separate SetName op on init', () => {
      // CreateSpan already carries the name, and the `_name` setter that the
      // parent constructor triggers only writes a local slot — it queues
      // nothing. (An earlier no-op instance shadow plus `delete` did that
      // suppression and dropped every context into V8 dictionary mode.)
      // Assert at the WASM-op level: no SetName op during construction.
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
    it('should update the context name without queueing a native op', () => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'original-name',
      }, false, nativeSpans)
      nativeSpans.queueOp.resetHistory()

      span.setOperationName('new-name')

      assert.strictEqual(span.context()._name, 'new-name')
      // The rename queues nothing itself; the new name reaches WASM at finish
      // when the processor hands the formatted snapshot to
      // `syncFinalTagsToNative` (its SetName op is asserted in
      // `test/native/span_context.spec.js`). That call belongs to the processor,
      // not NativeDatadogSpan, so it is out of this file's scope.
      sinon.assert.notCalled(nativeSpans.queueOp)
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

    it('keeps setTag in the JS tag cache without queueing a native op', () => {
      nativeSpans.queueOp.resetHistory()
      span.setTag('http.url', 'https://example.test/x')

      assert.strictEqual(span.context().getTag('http.url'), 'https://example.test/x')
      // Native storage is written once at finish from the formatted snapshot.
      sinon.assert.notCalled(nativeSpans.queueOp)
    })

    it('merges an addTags batch into the JS tag cache without queueing native ops', () => {
      nativeSpans.queueOp.resetHistory()
      const batch = { 'http.method': 'GET', 'http.status_code': 200 }
      span.addTags(batch)

      assert.strictEqual(span.context().getTag('http.method'), 'GET')
      assert.strictEqual(span.context().getTag('http.status_code'), 200)
      sinon.assert.notCalled(nativeSpans.queueOp)
    })

    it('publishes dd-trace:span:tags:update after setTag (so subscribers like the wall profiler refresh)', () => {
      const { channel } = require('dc-polyfill')
      const ch = channel('dd-trace:span:tags:update')
      const onUpdate = sinon.stub()
      ch.subscribe(onUpdate)
      try {
        span.setTag('span.type', 'web')
        sinon.assert.calledWith(onUpdate, span)
      } finally {
        ch.unsubscribe(onUpdate)
      }
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

    it('samples when setting a manual priority tag', () => {
      prioritySampler.sample.resetHistory()
      span._spanContext._sampling = {}
      span.setTag('manual.keep', true)
      sinon.assert.calledOnce(prioritySampler.sample)
    })

    it('does not sample when setting a non-priority tag', () => {
      prioritySampler.sample.resetHistory()
      span._spanContext._sampling = {}
      span.setTag('http.method', 'GET')
      sinon.assert.notCalled(prioritySampler.sample)
    })

    it('samples when addTags includes a manual priority tag', () => {
      prioritySampler.sample.resetHistory()
      span._spanContext._sampling = {}
      span.addTags({ 'manual.keep': true })
      sinon.assert.calledOnce(prioritySampler.sample)
    })

    it('does not sample when addTags contains no priority tags', () => {
      prioritySampler.sample.resetHistory()
      span._spanContext._sampling = {}
      span.addTags({ 'http.method': 'GET' })
      sinon.assert.notCalled(prioritySampler.sample)
    })

    it('ignores invalid addTags input on v6', () => {
      nativeSpans.queueOp.resetHistory()
      prioritySampler.sample.resetHistory()
      const tagsBefore = { ...span.context().getTags() }
      span.addTags(undefined)
      assert.deepStrictEqual(span.context().getTags(), tagsBefore)
      sinon.assert.notCalled(nativeSpans.queueOp)
      sinon.assert.notCalled(prioritySampler.sample)
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
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation',
      }, false, nativeSpans)
    })

    it('queues SetDuration with the exact ns delta between finishTime and _startTime', () => {
      // `finish(finishTime)` normalizes to
      // `Number.parseFloat(finishTime) || this._getTime()` and queues
      // `['ns', resolvedFinishTime - this._startTime]` (the 'ns' tag converts the
      // JS-side ms value to a u64 LE nanosecond field). Drive a real, non-zero
      // duration through the public argument so the expected value is pinned
      // exactly rather than accidentally being 0 under the stubbed clock.
      const startTime = span._startTime
      span.finish(startTime + 7.5)

      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetDuration,
        span._spanContext._nativeSpanId,
        ['ns', 7.5]
      )
      // super.finish() receives the same resolved value, so the JS-side
      // duration and the native one cannot drift apart.
      assert.strictEqual(span._duration, 7.5)
    })

    it('falls back to _getTime() when finishTime is not a usable number', () => {
      // `Number.parseFloat(0) || this._getTime()` takes the fallback branch, and
      // `_getTime()` is the stubbed clock (Date.now() === 1500000000000). Start
      // the span 42.5ms earlier so the fallback produces a non-zero,
      // exactly-known duration instead of a vacuous 0.
      const startTime = 1500000000000 - 42.5
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'explicit-start',
        startTime,
      }, false, nativeSpans)
      assert.strictEqual(span._startTime, startTime)

      span.finish(0)

      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetDuration,
        span._spanContext._nativeSpanId,
        ['ns', 42.5]
      )
      assert.strictEqual(span._duration, 42.5)
    })

    it('tracks finished native spans on the exporter', () => {
      span.finish()

      sinon.assert.calledOnce(processor._exporter._trackSpanFinish)
    })

    it('forwards qualifying meta_struct entries as msgpack bytes, skipping null/boolean', () => {
      span.meta_struct = { obj: { a: 1 }, str: 'x', num: 5, nil: null, bool: true }

      span.finish()

      // string, number and non-null object are forwarded; null and boolean are
      // dropped (mirrors the legacy #encodeMetaStruct value filter).
      sinon.assert.calledThrice(nativeSpans.setMetaStruct)
      const keys = nativeSpans.setMetaStruct.getCalls().map(c => c.args[1])
      assert.deepEqual(keys.sort(), ['num', 'obj', 'str'])

      const expected = encodeMsgpack({ a: 1 })
      const objCall = nativeSpans.setMetaStruct.getCalls().find(c => c.args[1] === 'obj')
      assert.deepEqual(Uint8Array.from(objCall.args[2]), Uint8Array.from(expected))
    })

    it('recursively strips null/undefined from nested meta_struct values (matches legacy encoder)', () => {
      // Stack frames carry `class_name: null` / `function: null` from V8. The
      // legacy v0.4 encoder omits null map entries at every depth; a generic
      // msgpack encoder would write them as nil, so the agent would decode
      // `class_name: null` instead of absent — breaking IAST location matching.
      span.meta_struct = {
        '_dd.stack': {
          iast: [{ id: '1', frames: [{ file: 'a.js', line: 8, class_name: null, function: null, isNative: false }] }],
        },
      }

      span.finish()

      const call = nativeSpans.setMetaStruct.getCalls().find(c => c.args[1] === '_dd.stack')
      assert.ok(call, 'expected _dd.stack to be forwarded')
      // null-valued keys dropped at every level; strings/numbers/booleans kept.
      const expected = encodeMsgpack({
        iast: [{ id: '1', frames: [{ file: 'a.js', line: 8, isNative: false }] }],
      })
      assert.deepEqual(Uint8Array.from(call.args[2]), Uint8Array.from(expected))
    })

    it('drops booleans and nulls from meta_struct arrays (matches legacy #encodeObjectAsArray)', () => {
      // In array context the legacy encoder keeps string/number/non-null-object
      // and drops booleans + nulls (unlike map context, which keeps booleans).
      span.meta_struct = { arr: { list: ['keep', 7, true, null, { nested: 1 }] } }

      span.finish()

      const call = nativeSpans.setMetaStruct.getCalls().find(c => c.args[1] === 'arr')
      assert.ok(call, 'expected arr to be forwarded')
      const expected = encodeMsgpack({ list: ['keep', 7, { nested: 1 }] })
      assert.deepEqual(Uint8Array.from(call.args[2]), Uint8Array.from(expected))
    })

    it('does not call setMetaStruct when the span has no meta_struct', () => {
      span.finish()
      sinon.assert.notCalled(nativeSpans.setMetaStruct)
    })

    it('skips native direct writes and duration sync after native storage has discarded the span', () => {
      tracer._config.DD_TRACE_NATIVE_SPAN_EVENTS = true
      span.meta_struct = { obj: { a: 1 } }
      span._events.push({ name: 'late', startTime: 1, attributes: { k: 'v' } })
      span.context().markExported()
      nativeSpans.queueOp.resetHistory()
      nativeSpans.setMetaStruct.resetHistory()
      nativeSpans.addSpanEvent.resetHistory()

      span.finish()

      sinon.assert.notCalled(nativeSpans.queueOp)
      sinon.assert.notCalled(nativeSpans.setMetaStruct)
      sinon.assert.notCalled(nativeSpans.addSpanEvent)
      sinon.assert.calledOnce(processor._exporter._trackSpanFinish)
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
      // Array attributes are encoded as a typed array (tag 4), which the native
      // decoder rebuilds as a real array_value (not flattened indexed keys).
      assert.deepStrictEqual(decodeSpanEventAttrs(first.args[3]), {
        msg: 'boom', code: 42n, ratio: 0.5, ok: true, tags: ['a', 'b'],
      })

      const second = nativeSpans.addSpanEvent.getCall(1)
      assert.strictEqual(second.args[1], 'plain')
      assert.strictEqual(second.args[3].length, 0) // no attributes

      // The meta-tag fallback must NOT be written on the native path.
      assert.strictEqual(span._spanContext.getTag('events'), undefined)
    })

    it('falls back to the `events` meta tag when the flag is disabled', () => {
      tracer._config.DD_TRACE_NATIVE_SPAN_EVENTS = false
      span._events.push({ name: 'evt', startTime: 1, attributes: { k: 'v' } })

      span.finish()

      sinon.assert.notCalled(nativeSpans.addSpanEvent)
      // Same `events` meta key + shape the legacy JS encoder writes.
      const parsed = JSON.parse(span._spanContext.getTag('events'))
      assert.strictEqual(parsed[0].name, 'evt')
      assert.strictEqual(parsed[0].time_unix_nano, Math.round(1 * 1e6))
      assert.deepStrictEqual(parsed[0].attributes, { k: 'v' })
    })

    it('does not touch either span-events path when there are no events', () => {
      tracer._config.DD_TRACE_NATIVE_SPAN_EVENTS = true
      span.finish()
      sinon.assert.notCalled(nativeSpans.addSpanEvent)
      assert.strictEqual(span._spanContext.getTag('events'), undefined)
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
