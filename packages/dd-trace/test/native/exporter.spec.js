'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

describe('NativeExporter', () => {
  let NativeExporter
  let exporter
  let config
  let prioritySampler
  let nativeSpans
  let clock

  beforeEach(() => {
    clock = sinon.useFakeTimers()

    config = {
      url: 'http://localhost:8126',
      flushInterval: 1000
    }

    prioritySampler = {
      sample: sinon.stub()
    }

    nativeSpans = {
      flushChangeQueue: sinon.stub(),
      flushSpans: sinon.stub().resolves('OK'),
      freeSlots: sinon.stub(),
      setAgentUrl: sinon.stub()
    }

    NativeExporter = proxyquire('../../src/exporters/native', {
      '../../log': {
        warn: sinon.stub(),
        error: sinon.stub()
      }
    })
  })

  afterEach(() => {
    clock.restore()
  })

  describe('constructor', () => {
    it('should initialize with config', () => {
      exporter = new NativeExporter(config, prioritySampler, nativeSpans)

      assert.strictEqual(exporter._config, config)
      assert.strictEqual(exporter._prioritySampler, prioritySampler)
      assert.strictEqual(exporter._nativeSpans, nativeSpans)
    })

    it('should initialize pending spans array', () => {
      exporter = new NativeExporter(config, prioritySampler, nativeSpans)

      assert.deepStrictEqual(exporter._pendingSpans, [])
    })

    it('should set URL from config', () => {
      exporter = new NativeExporter(config, prioritySampler, nativeSpans)

      assert.ok(exporter._url)
    })

    it('should use hostname and port if URL not provided', () => {
      const configWithHostname = {
        hostname: 'agent.example.com',
        port: 8127,
        flushInterval: 1000
      }

      exporter = new NativeExporter(configWithHostname, prioritySampler, nativeSpans)

      assert.ok(exporter._url.toString().includes('agent.example.com'))
    })
  })

  describe('export', () => {
    beforeEach(() => {
      exporter = new NativeExporter(config, prioritySampler, nativeSpans)
    })

    it('should collect spans for batch export', () => {
      const span1 = createMockSpan(1n)
      const span2 = createMockSpan(2n)

      exporter.export([span1, span2])

      assert.strictEqual(exporter._pendingSpans.length, 2)
    })

    it('should flush immediately when flushInterval is 0', () => {
      exporter = new NativeExporter({ ...config, flushInterval: 0 }, prioritySampler, nativeSpans)

      const span = createMockSpan(1n)
      exporter.export([span])

      // The rebased exporter doesn't call flushChangeQueue directly; the
      // change queue is drained inside flushSpans. Assert the visible
      // public-API call instead.
      sinon.assert.called(nativeSpans.flushSpans)
    })

    it('should schedule flush after flushInterval', () => {
      const span = createMockSpan(1n)
      exporter.export([span])

      sinon.assert.notCalled(nativeSpans.flushSpans)

      clock.tick(config.flushInterval + 1)

      sinon.assert.called(nativeSpans.flushSpans)
    })

    it('should not schedule multiple timers', () => {
      const span1 = createMockSpan(1n)
      const span2 = createMockSpan(2n)

      exporter.export([span1])
      exporter.export([span2])

      clock.tick(config.flushInterval + 1)

      // Should only flush once
      sinon.assert.calledOnce(nativeSpans.flushSpans)
    })
  })

  describe('flush', () => {
    beforeEach(() => {
      exporter = new NativeExporter(config, prioritySampler, nativeSpans)
    })

    it('should do nothing if no pending spans', (done) => {
      exporter.flush(() => {
        sinon.assert.notCalled(nativeSpans.flushSpans)
        done()
      })
    })

    it('should call flushSpans on the native side when flushing', (done) => {
      // The change queue is now drained inside flushSpans, not by an
      // explicit pre-call from the exporter. Assert that flushSpans was
      // called — the change-queue drain is its responsibility.
      const span = createMockSpan(1n)
      exporter.export([span])

      exporter.flush(() => {
        sinon.assert.called(nativeSpans.flushSpans)
        done()
      })
    })

    it('should sync trace tags to first span', (done) => {
      const span = createMockSpan(1n)
      // Make this span a local root by setting parentId to null
      span.context()._parentId = null
      span.context()._trace.tags = { '_dd.p.tid': 'abc123' }
      exporter.export([span])

      exporter.flush(() => {
        // Trace tags should be synced to span tags
        assert.ok(span.context().getTag('_dd.p.tid'))
        done()
      })
    })

    it('should extract slot indices for native flush', (done) => {
      const span1 = createMockSpan(123n, 11)
      const span2 = createMockSpan(456n, 22)
      exporter.export([span1, span2])

      exporter.flush(() => {
        // flushSpans is called with an array of u32 slot indices (numbers).
        // The pre-rebase API used spanId Buffers; the rebased pipeline
        // addresses spans by their allocated slot.
        sinon.assert.calledWith(
          nativeSpans.flushSpans,
          sinon.match.array,
          sinon.match.any
        )
        const call = nativeSpans.flushSpans.getCall(0)
        assert.deepStrictEqual(call.args[0], [11, 22])
        done()
      })
    })

    it('should determine first is local root correctly for root span', (done) => {
      const span = createMockSpan(1n)
      span.context()._parentId = null
      exporter.export([span])

      exporter.flush(() => {
        sinon.assert.calledWith(
          nativeSpans.flushSpans,
          sinon.match.any,
          true // firstIsLocalRoot
        )
        done()
      })
    })

    it('should clear pending spans after flush', (done) => {
      const span = createMockSpan(1n)
      exporter.export([span])

      exporter.flush(() => {
        assert.strictEqual(exporter._pendingSpans.length, 0)
        done()
      })
    })

    it('should call done callback on success', (done) => {
      const span = createMockSpan(1n)
      exporter.export([span])

      exporter.flush((err) => {
        assert.strictEqual(err, undefined)
        done()
      })
    })

    it('should swallow flushSpans rejections (logged, not propagated to done)', async () => {
      // The rebased flush() calls done() immediately after kicking off the
      // async send, then log.error()s any rejection. Errors no longer
      // surface through the done callback. Verify both: done is invoked
      // without an argument, and freeSlots eventually runs in the catch
      // handler (proves the rejection was actually observed).
      nativeSpans.flushSpans.rejects(new Error('Network error'))

      const span = createMockSpan(1n)
      exporter.export([span])

      let cbErr = 'unset'
      exporter.flush((err) => { cbErr = err })
      assert.strictEqual(cbErr, undefined)

      // Drain pending microtasks so the rejection handler runs. With
      // sinon.useFakeTimers() Promise microtasks still settle when we yield
      // to the host promise queue via tickAsync.
      await clock.tickAsync(0)

      sinon.assert.called(nativeSpans.freeSlots)
    })
  })

  describe('setUrl', () => {
    beforeEach(() => {
      exporter = new NativeExporter(config, prioritySampler, nativeSpans)
    })

    it('should update the URL', () => {
      const originalUrl = exporter._url.toString()
      exporter.setUrl('http://new-agent:9999')

      assert.notStrictEqual(exporter._url.toString(), originalUrl)
    })
  })


  // Helper function to create mock spans
  function createMockSpan (nativeSpanIdValue, slotIndex = 0) {
    // Create an 8-byte buffer for the span ID (big-endian)
    const nativeSpanId = Buffer.alloc(8)
    nativeSpanId.writeBigUInt64BE(BigInt(nativeSpanIdValue))

    const spanId = {
      toString: () => String(nativeSpanIdValue),
      toBigInt: () => BigInt(nativeSpanIdValue),
      toBuffer: () => nativeSpanId
    }

    const context = {
      _nativeSpanId: nativeSpanId,
      _spanId: spanId,
      _parentId: { toString: () => '0' },
      _isRemote: false,
      // The rebased exporter reads context._slotIndex to build the slot
      // array passed to nativeSpans.flushSpans.
      _slotIndex: slotIndex,
      _trace: {
        started: [],
        finished: [],
        tags: {}
      },
      _tags: {},
      hasTag: function (key) {
        return key in this._tags
      },
      setTag: function (key, value) {
        this._tags[key] = value
      },
      getTag: function (key) {
        return this._tags[key]
      }
    }

    return {
      context: () => context
    }
  }
})
