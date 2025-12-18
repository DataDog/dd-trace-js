'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
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
      flushSpans: sinon.stub().resolves('OK')
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

      sinon.assert.called(nativeSpans.flushChangeQueue)
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

    it('should flush change queue before exporting', (done) => {
      const span = createMockSpan(1n)
      exporter.export([span])

      exporter.flush(() => {
        sinon.assert.called(nativeSpans.flushChangeQueue)
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
        assert.ok(span.context()._tags['_dd.p.tid'])
        done()
      })
    })

    it('should extract span IDs for native flush', (done) => {
      const span1 = createMockSpan(123n)
      const span2 = createMockSpan(456n)
      exporter.export([span1, span2])

      exporter.flush(() => {
        sinon.assert.calledWith(
          nativeSpans.flushSpans,
          [123n, 456n],
          sinon.match.any
        )
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

    it('should call done callback with error on failure', (done) => {
      nativeSpans.flushSpans.rejects(new Error('Network error'))

      const span = createMockSpan(1n)
      exporter.export([span])

      exporter.flush((err) => {
        assert.ok(err)
        assert.strictEqual(err.message, 'Network error')
        done()
      })
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
  function createMockSpan (nativeSpanId) {
    const spanId = {
      toString: () => String(nativeSpanId),
      toBigInt: () => nativeSpanId
    }

    const context = {
      _nativeSpanId: nativeSpanId,
      _spanId: spanId,
      _parentId: { toString: () => '0' },
      _isRemote: false,
      _trace: {
        started: [],
        finished: [],
        tags: {}
      },
      _tags: {}
    }

    return {
      context: () => context
    }
  }
})
