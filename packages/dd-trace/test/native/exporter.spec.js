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
      flushInterval: 1000,
    }

    prioritySampler = {
      sample: sinon.stub(),
    }

    nativeSpans = {
      flushChangeQueue: sinon.stub(),
      flushSpans: sinon.stub().resolves('OK'),
      freeSlots: sinon.stub(),
      setAgentUrl: sinon.stub(),
    }

    NativeExporter = proxyquire('../../src/exporters/native', {
      '../../log': {
        warn: sinon.stub(),
        error: sinon.stub(),
      },
    })
  })

  afterEach(() => {
    clock.restore()
  })

  describe('constructor', () => {
    it('should initialize config, pending spans, and register beforeExit', () => {
      // Constructor wires up immutable state — assert all of it in one shot
      // rather than splitting across three near-identical it() blocks. The
      // URL fallback path has its own test below since it has real branching.
      const ddTrace = globalThis[Symbol.for('dd-trace')]
      const beforeCount = ddTrace.beforeExitHandlers.size

      exporter = new NativeExporter(config, prioritySampler, nativeSpans)

      assert.strictEqual(exporter._config, config)
      assert.strictEqual(exporter._prioritySampler, prioritySampler)
      assert.strictEqual(exporter._nativeSpans, nativeSpans)
      assert.deepStrictEqual(exporter._pendingSpans, [])
      // Constructor should add to the shared registry rather than attaching
      // a fresh listener to `process` (which would leak under test reinit).
      assert.strictEqual(ddTrace.beforeExitHandlers.size, beforeCount + 1)
    })

    it('should derive URL from config.url, falling back to hostname:port', () => {
      // Two branches of the URL-derivation logic in one test: the happy path
      // (config.url provided) and the fallback (only hostname/port given).
      const fromUrl = new NativeExporter(config, prioritySampler, nativeSpans)
      assert.ok(fromUrl._url)

      const configWithHostname = {
        hostname: 'agent.example.com',
        port: 8127,
        flushInterval: 1000,
      }
      const fromHostname = new NativeExporter(configWithHostname, prioritySampler, nativeSpans)
      assert.ok(fromHostname._url.toString().includes('agent.example.com'))
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

      // The exporter doesn't call flushChangeQueue directly; the
      // change queue is drained inside flushSpans. Assert the visible
      // public-API call instead.
      sinon.assert.called(nativeSpans.flushSpans)
    })

    it('schedules exactly one flush timer after flushInterval ms regardless of repeated export() calls', () => {
      // Several export() calls within the same flushInterval window should
      // share one timer, not stack up — and no flush should fire until the
      // interval elapses.
      exporter.export([createMockSpan(1n)])
      clock.tick(config.flushInterval / 2)
      exporter.export([createMockSpan(2n)])
      clock.tick(config.flushInterval / 2 - 1)
      exporter.export([createMockSpan(3n)])

      sinon.assert.notCalled(nativeSpans.flushSpans)

      clock.tick(2)

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

    // The success path is one observable sequence — splitting it across 5
    // it() blocks paid for 5x mocha-overhead while testing the same flow.
    // This single test pins all five aspects: flushSpans is called with the
    // extracted slot indices, _pendingSpans drains, the done callback fires
    // with no error, and freeSlots runs once the in-flight send settles.
    it('end-to-end successful flush: calls flushSpans with slot indices, drains pending, frees slots, fires done',
      async () => {
        const span1 = createMockSpan(123n, 11)
        const span2 = createMockSpan(456n, 22)
        exporter.export([span1, span2])

        // done() fires synchronously after flush() kicks off the async send.
        let cbErr = 'unset'
        exporter.flush((err) => { cbErr = err })
        assert.strictEqual(cbErr, undefined)

        // flushSpans called with the extracted slot-index array (u32 slot
        // numbers) — the native pipeline addresses spans by slot.
        sinon.assert.called(nativeSpans.flushSpans)
        const call = nativeSpans.flushSpans.getCall(0)
        assert.deepStrictEqual(call.args[0], [11, 22])
        // Pending spans drain synchronously when the flush is dispatched.
        assert.strictEqual(exporter._pendingSpans.length, 0)

        // freeSlots runs in the .then() handler on the resolved flushSpans
        // promise — drain microtasks before asserting.
        await clock.tickAsync(0)
        sinon.assert.called(nativeSpans.freeSlots)
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

    it('should re-flush pending spans after a flush rejection', async () => {
      // Asymmetric to the success-path drain. Without this, a single
      // transient agent failure would leave spans buffered indefinitely
      // until the next export() call woke the exporter back up.
      let rejectSend
      nativeSpans.flushSpans
        .onFirstCall().callsFake(() => new Promise((_resolve, reject) => { rejectSend = reject }))
        .onSecondCall().resolves('OK')

      exporter.export([createMockSpan(1n)])
      exporter.flush()
      exporter.export([createMockSpan(2n)])
      exporter.flush()
      assert.strictEqual(exporter._pendingSpans.length, 1)

      rejectSend(new Error('Network error'))
      await clock.tickAsync(0)
      await clock.tickAsync(0)

      sinon.assert.calledTwice(nativeSpans.flushSpans)
      assert.strictEqual(exporter._pendingSpans.length, 0)
    })

    it('should not start a new flush while one is in flight', () => {
      // While the first flush()'s send is unresolved, a second flush()
      // call must not call into native again — the spans should accumulate
      // in `_pendingSpans` and drain after the in-flight settles.
      let resolveSend
      nativeSpans.flushSpans.callsFake(() => new Promise(resolve => { resolveSend = resolve }))

      exporter.export([createMockSpan(1n)])
      exporter.flush()
      sinon.assert.calledOnce(nativeSpans.flushSpans)

      // Second batch arrives while the first send is still in flight:
      exporter.export([createMockSpan(2n)])
      exporter.flush()
      sinon.assert.calledOnce(nativeSpans.flushSpans)
      assert.strictEqual(exporter._pendingSpans.length, 1)

      // Settle the in-flight send so afterEach's clock.restore() doesn't
      // leak an unhandled-rejection warning across tests.
      resolveSend('OK')
    })

    it('should re-flush queued spans after in-flight settles', async () => {
      // Spans queued during a send should drain on settle, not stay buffered.
      let resolveSend
      nativeSpans.flushSpans
        .onFirstCall().callsFake(() => new Promise(resolve => { resolveSend = resolve }))
        .onSecondCall().resolves('OK')

      exporter.export([createMockSpan(1n)])
      exporter.flush()
      exporter.export([createMockSpan(2n)])
      exporter.flush()
      assert.strictEqual(exporter._pendingSpans.length, 1)

      resolveSend('OK')
      // Drain the .then chain on the first send and the chained re-flush.
      await clock.tickAsync(0)
      await clock.tickAsync(0)

      sinon.assert.calledTwice(nativeSpans.flushSpans)
      assert.strictEqual(exporter._pendingSpans.length, 0)
    })

    it('should swallow flushSpans rejections (logged, not propagated to done)', async () => {
      // flush() calls done() immediately after kicking off the
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
      toBuffer: () => nativeSpanId,
    }

    const tagStore = Object.create(null)

    const context = {
      _nativeSpanId: nativeSpanId,
      _spanId: spanId,
      _parentId: { toString: () => '0' },
      _isRemote: false,
      // The exporter reads context._slotIndex to build the slot
      // array passed to nativeSpans.flushSpans.
      _slotIndex: slotIndex,
      _trace: {
        started: [],
        finished: [],
        tags: {},
      },
      hasTag (key) {
        return key in tagStore
      },
      setTag (key, value) {
        tagStore[key] = value
      },
      getTag (key) {
        return tagStore[key]
      },
    }

    return {
      context: () => context,
    }
  }
})
