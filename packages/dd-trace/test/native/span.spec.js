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
    // queueCreateSpanFull for the combined Create+SetName+SetService+
    // SetResource+SetType+SetStart op. Stub these so the constructor can run
    // without touching real WASM.
    let nextSegment = 0
    nativeSpans = {
      queueOp: sinon.stub(),
      queueCreateSpan: sinon.stub(),
      queueCreateSpanFull: sinon.stub(),
      queueBatchMeta: sinon.stub(),
      queueBatchMetrics: sinon.stub(),
      flushChangeQueue: sinon.stub(),
      setMetaStruct: sinon.stub(),
      addSpanEvent: sinon.stub(),
      allocSegment: sinon.stub().callsFake(() => nextSegment++),
      OpCode,
    }

    NativeSpanContext = proxyquire('../../src/native/span_context', {
      './index': { OpCode },
      '../service-naming/extra-services': { registerExtraService: sinon.stub() },
    })
    sinon.spy(NativeSpanContext.prototype, 'syncToNativeOnly')
    sinon.spy(NativeSpanContext.prototype, 'syncOneTagToNative')

    // Exercise the native subclass through the production DatadogSpan parent.
    NativeDatadogSpan = proxyquire('../../src/native/span', {
      perf_hooks: {
        performance: { now },
      },
      '../id': id,
      './index': { OpCode },
      './span_context': NativeSpanContext,
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
    it('should issue a combined queueCreateSpanFull op to native', () => {
      // queueCreateSpanFull emits a single combined opcode that encodes the
      // default core fields alongside Create, saving WASM change-buffer ops.
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation',
      }, false, nativeSpans)

      sinon.assert.calledOnce(nativeSpans.queueCreateSpanFull)
      sinon.assert.notCalled(nativeSpans.queueCreateSpan)
      const args = nativeSpans.queueCreateSpanFull.getCall(0).args
      // queueCreateSpanFull(spanId, traceId, segmentId, parentId,
      //   name, service, resource, type, startMs)
      assert.ok(args[0] instanceof Uint8Array) // spanId (8-byte LE handle)
      assert.strictEqual(typeof args[2], 'number') // segmentId
      assert.strictEqual(args[4], 'test-operation') // name
      assert.strictEqual(args[5], 'test-service') // service
      assert.strictEqual(args[6], 'test-operation') // resource
      assert.strictEqual(args[7], '') // type
      assert.strictEqual(typeof args[8], 'number') // startMs
    })

    it('defaults the resource to the operation name when no resource.name is supplied', () => {
      // Keep the live native resource aligned with the JS formatter default;
      // final sync tracks this value and skips the duplicate overwrite.
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation',
      }, false, nativeSpans)

      const args = nativeSpans.queueCreateSpanFull.getCall(0).args
      assert.strictEqual(args[6], 'test-operation')
      const resourceOps = nativeSpans.queueOp.getCalls()
        .filter(c => c.args[0] === OpCode.SetResourceName)
      assert.strictEqual(resourceOps.length, 0)
    })

    it('defers meta.language to final formatted sync', () => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation',
      }, false, nativeSpans)

      const languageOps = nativeSpans.queueOp.getCalls()
        .filter(c => c.args[0] === OpCode.SetMetaAttr && c.args[2] === 'language')
      assert.strictEqual(languageOps.length, 0)
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
      const createCall = nativeSpans.queueCreateSpanFull.getCall(0)
      assert.strictEqual(createCall.args[4], 'undefined')
    })

    it('skips the default resource when a string resource.name is supplied at creation', () => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation',
        tags: { 'resource.name': 'GET /users' },
      }, false, nativeSpans)

      // No default SetResourceName op is queued at creation; the explicit resource
      // is carried by CreateSpanFull and still observed by the tag path.
      const createCall = nativeSpans.queueCreateSpanFull.getCall(0)
      assert.strictEqual(createCall.args[6], 'GET /users')
      const resourceOps = nativeSpans.queueOp.getCalls()
        .filter(c => c.args[0] === OpCode.SetResourceName)
      assert.strictEqual(resourceOps.length, 0)
      sinon.assert.calledWith(
        span.context().syncToNativeOnly,
        sinon.match({ 'resource.name': 'GET /users' })
      )
    })

    it('gives child spans the same 128-bit native trace id as the root (not zero-padded)', () => {
      const root = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'root',
        traceId128BitGenerationEnabled: true,
      }, false, nativeSpans)
      const rootTraceId = nativeSpans.queueCreateSpanFull.getCall(0).args[1]
      assert.ok(Array.isArray(rootTraceId) && rootTraceId.length === 16, 'root trace id should be 16 bytes')
      assert.ok(rootTraceId.slice(0, 8).some(b => b !== 0), 'root high 8 bytes (tid) should be non-zero')

      nativeSpans.queueCreateSpanFull.resetHistory()
      // eslint-disable-next-line no-new
      new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'child',
        parent: root.context(),
        traceId128BitGenerationEnabled: true,
      }, false, nativeSpans)
      const childTraceId = nativeSpans.queueCreateSpanFull.getCall(0).args[1]
      // Child reuses the SAME full 128-bit id, not a rebuilt or high-bits-zeroed one.
      assert.strictEqual(childTraceId, rootTraceId)
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
      const childTraceId = nativeSpans.queueCreateSpanFull.getCall(0).args[1]
      // Low 8 bytes come from slice(-8) of the 16-byte id, not [0..7] (the high bytes).
      assert.deepStrictEqual(childTraceId, [...high, ...low])
    })

    it('should NOT also issue a separate SetName op on init', () => {
      // CreateSpan already carries the name. The parent constructor stores it
      // locally, so construction must not also queue a SetName operation.
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
    it('should update operation name locally for final synchronization', () => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'original-name',
      }, false, nativeSpans)

      span.setOperationName('new-name')

      assert.strictEqual(span.context()._name, 'new-name')
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
      span.context().syncToNativeOnly.resetHistory()
      prioritySampler.sample.resetHistory()
      const tagsBefore = { ...span.context().getTags() }
      span.addTags(undefined)
      assert.deepStrictEqual(span.context().getTags(), tagsBefore)
      sinon.assert.notCalled(span.context().syncToNativeOnly)
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

    it('drops events with a non-string name instead of throwing out of finish()', () => {
      // `addEvent` and the OTel bridge do not type-check `name`, and the WASM
      // string parameter throws on a non-string - which would surface inside
      // application code at finish(). The legacy v0.4 encoder drops these, so the
      // rest of the span still ships.
      tracer._config.DD_TRACE_NATIVE_SPAN_EVENTS = true
      span._events.push({ name: { toString: () => 'not-a-string' }, startTime: 1 })
      span._events.push({ name: 42, startTime: 2 })
      span._events.push(null)
      span._events.push({ name: 'good', startTime: 3 })

      // A throw here fails the test directly.
      span.finish()

      sinon.assert.calledOnce(nativeSpans.addSpanEvent)
      assert.strictEqual(nativeSpans.addSpanEvent.getCall(0).args[1], 'good')
    })

    it('uses the native event slot for OTLP even when the agent flag is disabled', () => {
      // The meta fallback exists for agents that cannot read the native slot. An
      // OTLP collector would receive it as a JSON string attribute instead of
      // structured events, so OTLP must always take the native path.
      tracer._config.DD_TRACE_NATIVE_SPAN_EVENTS = false
      tracer._config.OTEL_TRACES_EXPORTER = 'otlp'
      span._events.push({ name: 'exception', startTime: 4 })

      span.finish()

      sinon.assert.calledOnce(nativeSpans.addSpanEvent)
      assert.strictEqual(nativeSpans.addSpanEvent.getCall(0).args[1], 'exception')
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
