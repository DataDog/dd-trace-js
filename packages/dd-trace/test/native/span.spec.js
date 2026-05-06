'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

require('../setup/core')

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
        }
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
      SetTraceOrigin: 12
    }

    tracer = {
      _config: {
        tags: {}
      },
      _service: 'test-service'
    }

    processor = {
      process: sinon.stub()
    }

    prioritySampler = {
      sample: sinon.stub()
    }

    // The rebased NativeSpansInterface allocates slot indices and uses
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
      OpCode
    }

    // Create a mock NativeSpanContext that tracks tags. The rebased real
    // class adds syncInitialTags / syncToNativeOnly / syncOneTagToNative /
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
        tags: {}
      }
      this._tags = { ...(props.tags || {}) }
      this._name = undefined
      this._hostname = undefined
      this._isFinished = false
      this._syncNameToNative = sinon.stub()
      this._setNameLocal = (name) => { this._name = name }
      // The rebased span code batches initial-tag application via
      // syncInitialTags; mirror it into _tags so getTags() reflects what
      // setTag-callers would have written.
      this.syncInitialTags = (tags) => {
        Object.assign(this._tags, tags)
      }
      this.syncToNativeOnly = sinon.stub()
      this.syncOneTagToNative = sinon.stub()

      // Tag accessor methods (matching real NativeSpanContext)
      this.setTag = (key, value) => {
        this._tags[key] = value
      }
      this.getTag = (key) => {
        return this._tags[key]
      }
      this.hasTag = (key) => {
        return key in this._tags
      }
      this.deleteTag = (key) => {
        delete this._tags[key]
      }
      this.getTags = () => {
        return this._tags
      }
    }

    // Mock all dependencies with noCallThru to avoid resolving real modules
    NativeDatadogSpan = proxyquire('../../src/native/span', {
      perf_hooks: {
        performance: { now }
      },
      '../id': id,
      './index': { OpCode },
      './span_context': NativeSpanContext,
      '../opentracing/span': class MockDatadogSpan {},
      '../opentracing/span_context': class MockDatadogSpanContext {},
      '../tagger': {
        add: (tags, keyValuePairs) => {
          for (const [key, value] of Object.entries(keyValuePairs)) {
            tags[key] = value
          }
        }
      },
      '../runtime_metrics': { count: sinon.stub(), increment: sinon.stub() },
      '../log': { debug: sinon.stub(), error: sinon.stub(), warn: sinon.stub() },
      '../../../../datadog-core': { storage: () => ({ getHandle: sinon.stub() }) },
      '../telemetry/metrics': {
        manager: {
          namespace: () => ({
            count: sinon.stub().returns({ inc: sinon.stub() }),
            increment: sinon.stub()
          })
        }
      },
      'dc-polyfill': { channel: sinon.stub().returns({ publish: sinon.stub(), hasSubscribers: false }) },
      util: require('util'),
      '../config/helper': { getValueFromEnvSources: sinon.stub().returns(undefined) },
      '../util': { isTrue: () => false }
    })
  })

  afterEach(() => {
    Date.now.restore()
  })

  describe('constructor', () => {
    it('should create a span with default context', () => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation'
      }, false, nativeSpans)

      assert.ok(span.context())
      assert.strictEqual(span._name, 'test-operation')
    })

    it('should add itself to the trace started spans', () => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation'
      }, false, nativeSpans)

      assert.ok(span.context()._trace.started.includes(span))
    })

    it('should issue a combined queueCreateSpan op to native', () => {
      // The rebased span code merges the old Create + SetName + SetStart
      // sequence into a single queueCreateSpan call (one WASM round-trip).
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation'
      }, false, nativeSpans)

      sinon.assert.calledOnce(nativeSpans.queueCreateSpan)
      const args = nativeSpans.queueCreateSpan.getCall(0).args
      // queueCreateSpan(slotIndex, spanId, traceId, parentId, name, startMs)
      assert.strictEqual(typeof args[0], 'number') // slotIndex
      assert.strictEqual(args[4], 'test-operation') // name
      assert.strictEqual(typeof args[5], 'number') // startMs
    })

    it('should NOT also issue a separate SetName via _syncNameToNative on init', () => {
      // CreateSpan already carries the name; the constructor uses
      // _setNameLocal to skip a redundant SetName WASM op. This test pins
      // that optimization so we don't regress the WASM call count.
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation'
      }, false, nativeSpans)

      sinon.assert.notCalled(span.context()._syncNameToNative)
      assert.strictEqual(span.context()._name, 'test-operation')
    })

    it('should use provided start time', () => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation',
        startTime: 1500000000100
      }, false, nativeSpans)

      assert.strictEqual(span._startTime, 1500000000100)
    })

    it('should initialize with parent context', () => {
      const parentId = id()
      const parentContext = {
        _traceId: parentId,
        _spanId: parentId,
        _sampling: { priority: 1 },
        _baggageItems: { foo: 'bar' },
        _trace: {
          started: [],
          finished: [],
          tags: {},
          ticks: 100,
          startTime: 1500000000000
        }
      }

      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'child-operation',
        parent: parentContext
      }, false, nativeSpans)

      assert.strictEqual(span.context()._traceId, parentId)
      assert.deepStrictEqual(span.context()._baggageItems, { foo: 'bar' })
    })

    it('should handle span links', () => {
      const linkContext = {
        _ddContext: {
          toTraceId: () => '123',
          toSpanId: () => '456'
        }
      }

      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation',
        links: [{ context: linkContext, attributes: { key: 'value' } }]
      }, false, nativeSpans)

      assert.strictEqual(span._links.length, 1)
    })
  })

  describe('context', () => {
    it('should return the span context', () => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation'
      }, false, nativeSpans)

      const context = span.context()
      assert.ok(context)
      assert.ok(context._nativeSpanId !== undefined)
    })
  })

  describe('tracer', () => {
    it('should return the parent tracer', () => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation'
      }, false, nativeSpans)

      assert.strictEqual(span.tracer(), tracer)
    })
  })

  describe('setOperationName', () => {
    it('should update operation name and sync to native', () => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'original-name'
      }, false, nativeSpans)

      span.setOperationName('new-name')

      assert.strictEqual(span.context()._name, 'new-name')
      sinon.assert.calledWith(span.context()._syncNameToNative, 'new-name')
    })

    it('should return the span for chaining', () => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation'
      }, false, nativeSpans)

      const result = span.setOperationName('new-name')
      assert.strictEqual(result, span)
    })
  })

  describe('setBaggageItem / getBaggageItem', () => {
    beforeEach(() => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation'
      }, false, nativeSpans)
    })

    it('should set and get baggage items', () => {
      span.setBaggageItem('key', 'value')
      assert.strictEqual(span.getBaggageItem('key'), 'value')
    })

    it('should return the span for chaining on set', () => {
      const result = span.setBaggageItem('key', 'value')
      assert.strictEqual(result, span)
    })
  })

  describe('getAllBaggageItems', () => {
    it('should return JSON string of all baggage items', () => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation'
      }, false, nativeSpans)

      span.setBaggageItem('key1', 'value1')
      span.setBaggageItem('key2', 'value2')

      const result = JSON.parse(span.getAllBaggageItems())
      assert.deepStrictEqual(result, { key1: 'value1', key2: 'value2' })
    })
  })

  describe('removeBaggageItem / removeAllBaggageItems', () => {
    beforeEach(() => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation'
      }, false, nativeSpans)
      span.setBaggageItem('key1', 'value1')
      span.setBaggageItem('key2', 'value2')
    })

    it('should remove a specific baggage item', () => {
      span.removeBaggageItem('key1')
      assert.strictEqual(span.getBaggageItem('key1'), undefined)
      assert.strictEqual(span.getBaggageItem('key2'), 'value2')
    })

    it('should remove all baggage items', () => {
      span.removeAllBaggageItems()
      assert.deepStrictEqual(JSON.parse(span.getAllBaggageItems()), {})
    })
  })

  describe('setTag / addTags', () => {
    beforeEach(() => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation'
      }, false, nativeSpans)
    })

    it('should set a tag', () => {
      span.setTag('key', 'value')
      assert.strictEqual(span.context().getTags().key, 'value')
    })

    it('should return the span for chaining', () => {
      const result = span.setTag('key', 'value')
      assert.strictEqual(result, span)
    })

    it('should add multiple tags', () => {
      span.addTags({ key1: 'value1', key2: 'value2' })
      assert.strictEqual(span.context().getTags().key1, 'value1')
      assert.strictEqual(span.context().getTags().key2, 'value2')
    })
  })

  describe('addLink', () => {
    beforeEach(() => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation'
      }, false, nativeSpans)
    })

    it('should add a span link', () => {
      const linkContext = {
        toTraceId: () => '123',
        toSpanId: () => '456'
      }

      span.addLink({ context: linkContext, attributes: { key: 'value' } })

      assert.strictEqual(span._links.length, 1)
      assert.strictEqual(span._links[0].attributes.key, 'value')
    })
  })

  describe('addEvent', () => {
    beforeEach(() => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation'
      }, false, nativeSpans)
    })

    it('should add a span event', () => {
      span.addEvent('test-event', { key: 'value' })

      assert.strictEqual(span._events.length, 1)
      assert.strictEqual(span._events[0].name, 'test-event')
      assert.deepStrictEqual(span._events[0].attributes, { key: 'value' })
    })

    it('should use provided start time', () => {
      span.addEvent('test-event', {}, 1500000000500)

      assert.strictEqual(span._events[0].startTime, 1500000000500)
    })
  })

  describe('finish', () => {
    beforeEach(() => {
      now.onFirstCall().returns(100)
      now.onSecondCall().returns(100)

      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation'
      }, false, nativeSpans)

      now.resetHistory()
      now.returns(500)
    })

    it('should calculate duration', () => {
      span.finish()

      assert.ok(span._duration !== undefined)
    })

    it('should queue SetDuration operation to native', () => {
      span.finish()

      // The rebased finish() encodes duration with the 'ns' tag (ms->ns
      // conversion), not the old 'i64' BigInt tag.
      sinon.assert.calledWith(
        nativeSpans.queueOp,
        OpCode.SetDuration,
        sinon.match.any,
        ['ns', sinon.match.number]
      )
    })

    it('should add span to trace finished array', () => {
      span.finish()

      assert.ok(span.context()._trace.finished.includes(span))
    })

    it('should mark context as finished', () => {
      span.finish()

      assert.strictEqual(span.context()._isFinished, true)
    })

    it('should call processor.process', () => {
      span.finish()

      sinon.assert.calledWith(processor.process, span)
    })

    it('should use provided finish time', () => {
      span.finish(1500000000600)

      // Duration should be based on provided finish time
      assert.ok(span._duration !== undefined)
    })

    it('should not finish twice', () => {
      span.finish()
      processor.process.resetHistory()
      span.finish()

      sinon.assert.notCalled(processor.process)
    })
  })

  describe('span links serialization', () => {
    beforeEach(() => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation'
      }, false, nativeSpans)
    })

    it('should serialize links to _dd.span_links meta tag on finish', () => {
      const linkContext = {
        toTraceId: () => '123',
        toSpanId: () => '456',
        _sampling: { priority: 1 }
      }

      span.addLink({ context: linkContext, attributes: { key: 'value' } })
      span.finish()

      assert.ok(span.context().getTags()['_dd.span_links'])
      const links = JSON.parse(span.context().getTags()['_dd.span_links'])
      assert.strictEqual(links.length, 1)
      assert.strictEqual(links[0].trace_id, '123')
      assert.strictEqual(links[0].span_id, '456')
    })
  })

  describe('span events serialization', () => {
    beforeEach(() => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation'
      }, false, nativeSpans)
    })

    it('should serialize events to _dd.span_events meta tag on finish', () => {
      span.addEvent('test-event', { key: 'value' }, 1500000000100)
      span.finish()

      assert.ok(span.context().getTags()['_dd.span_events'])
      const events = JSON.parse(span.context().getTags()['_dd.span_events'])
      assert.strictEqual(events.length, 1)
      assert.strictEqual(events[0].name, 'test-event')
    })
  })

  describe('toString', () => {
    it('should return a string representation', () => {
      span = new NativeDatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'test-operation'
      }, false, nativeSpans)

      const str = span.toString()
      assert.ok(str.startsWith('NativeSpan'))
      assert.ok(str.includes('test-operation') || str.includes('traceId'))
    })
  })
})
