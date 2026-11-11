'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noPreserveCache()

require('../setup/core')
const lazyDatastreams = require('../../src/datastreams')
const log = require('../../src/log')
const RealDatadogTracer = require('../../src/tracer')
const { enable: enableTracingRemoteConfig } = require('../../src/config/remote_config')

const writer = { flush: sinon.stub() }
const { DataStreamsProcessor } = proxyquire('../../src/datastreams/processor', {
  './writer': { DataStreamsWriter: sinon.stub().returns(writer) },
})
const DatadogTracer = proxyquire('../../src/tracer', {
  './datastreams': { ...lazyDatastreams, DataStreamsProcessor },
})

const edgeTags = ['direction:out', 'type:kafka', 'topic:t']
const baseConfig = {
  hostname: '127.0.0.1',
  port: 8126,
  url: new URL('http://127.0.0.1:8126'),
  env: 'test',
  service: 'service1',
  flushInterval: 1000,
}

describe('Data Streams Monitoring runtime toggle', () => {
  let clock

  beforeEach(() => {
    // Fake only timers so countTimers() is not inflated by nextTick/microtask jobs.
    clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    writer.flush.resetHistory()
  })

  afterEach(() => {
    clock.restore()
  })

  describe('DataStreamsProcessor', () => {
    it('records nothing and flushes nothing while inactive', () => {
      const processor = new DataStreamsProcessor({ ...baseConfig, dsmEnabled: false })

      assert.strictEqual(processor.setCheckpoint(edgeTags, null, null), undefined)
      processor.setOffset({ topic: 't', partition: 0, type: 'kafka_commit', offset: 1 })
      processor.trackTransaction('id', 'checkpoint')
      clock.tick(5000)

      assert.strictEqual(processor.timer, undefined)
      sinon.assert.notCalled(writer.flush)
    })

    it('records and flushes periodically after start', () => {
      const processor = new DataStreamsProcessor({ ...baseConfig, dsmEnabled: false })

      processor.start()
      const ctx = processor.setCheckpoint(edgeTags, null, null)
      clock.tick(1000)

      assert.notStrictEqual(ctx, undefined)
      sinon.assert.calledOnce(writer.flush)
      processor.stop()
    })

    it('flushes what was recorded on stop and records nothing afterwards', () => {
      const processor = new DataStreamsProcessor({ ...baseConfig, dsmEnabled: true })
      processor.setCheckpoint(edgeTags, null, null)

      processor.stop()

      sinon.assert.calledOnce(writer.flush)
      assert.strictEqual(processor.timer, undefined)
      assert.strictEqual(processor.setCheckpoint(edgeTags, null, null), undefined)
      clock.tick(5000)
      sinon.assert.calledOnce(writer.flush)
    })

    it('records again after a stop and start cycle', () => {
      const processor = new DataStreamsProcessor({ ...baseConfig, dsmEnabled: true })

      processor.stop()
      processor.start()
      const ctx = processor.setCheckpoint(edgeTags, null, null)
      clock.tick(1000)

      assert.notStrictEqual(ctx, undefined)
      sinon.assert.calledOnce(writer.flush)
      processor.stop()
    })

    it('does not arm a second timer on repeated start or stop twice', () => {
      const processor = new DataStreamsProcessor({ ...baseConfig, dsmEnabled: false })

      processor.start()
      const timer = processor.timer
      processor.start()
      assert.strictEqual(processor.timer, timer)
      assert.strictEqual(clock.countTimers(), 1)

      processor.stop()
      processor.stop()
      assert.strictEqual(clock.countTimers(), 0)
    })

    it('does not arm a timer for flush-on-write when started', () => {
      const processor = new DataStreamsProcessor({ ...baseConfig, dsmEnabled: false, flushInterval: 0 })

      processor.start()
      processor.setCheckpoint(edgeTags, null, null)

      assert.strictEqual(processor.timer, undefined)
      sinon.assert.calledOnce(writer.flush)
    })

    it('exposes start and stop through the lazy class', () => {
      const processor = new lazyDatastreams.DataStreamsProcessor({ ...baseConfig, dsmEnabled: false })

      processor.start()
      assert.strictEqual(processor.enabled, true)
      processor.stop()
      assert.strictEqual(processor.enabled, false)
    })
  })

  describe('DatadogTracer.configure', () => {
    let config
    let tracer

    function createTracer (dsmEnabled) {
      process.env.DD_DATA_STREAMS_ENABLED = String(dsmEnabled)
      const createConfig = proxyquire('../../src/config', {})
      config = createConfig({ service: 'service' })
      config.flushInterval = 1000
      tracer = new DatadogTracer(config)
      tracer._prioritySampler.configure = sinon.stub()
    }

    function remoteConfigure (value) {
      config.setRemoteConfig(value === undefined ? null : { DD_DATA_STREAMS_ENABLED: String(value) })
      tracer.configure(config)
    }

    afterEach(() => {
      sinon.restore()
      tracer?._dataStreamsProcessor.stop()
      delete process.env.DD_DATA_STREAMS_ENABLED
    })

    it('enables DSM from off when remote config enables it', () => {
      createTracer(false)
      assert.strictEqual(tracer.setCheckpoint(edgeTags, null), undefined)

      remoteConfigure(true)

      assert.notStrictEqual(tracer.setCheckpoint(edgeTags, null), undefined)
    })

    it('disables DSM and flushes when remote config disables it', () => {
      createTracer(true)
      tracer.setCheckpoint(edgeTags, null)

      remoteConfigure(false)

      sinon.assert.calledOnce(writer.flush)
      assert.strictEqual(tracer.setCheckpoint(edgeTags, null), undefined)
    })

    it('falls back to the env value when the remote config key is removed', () => {
      createTracer(true)

      remoteConfigure(false)
      assert.strictEqual(tracer._dataStreamsProcessor.enabled, false)

      remoteConfigure(undefined)
      assert.strictEqual(tracer._dataStreamsProcessor.enabled, true)
    })

    it('supports a full enable, disable, enable cycle', () => {
      createTracer(false)

      remoteConfigure(true)
      remoteConfigure(false)
      remoteConfigure(true)

      assert.notStrictEqual(tracer.setCheckpoint(edgeTags, null), undefined)
      assert.strictEqual(clock.countTimers(), 1)
    })

    it('does not touch the processor when dsmEnabled is unchanged', () => {
      createTracer(false)
      const start = sinon.spy(tracer._dataStreamsProcessor, 'start')
      const stop = sinon.spy(tracer._dataStreamsProcessor, 'stop')

      tracer.configure(config)

      sinon.assert.notCalled(start)
      sinon.assert.notCalled(stop)
    })

    it('does not throw when starting the processor fails', () => {
      createTracer(false)
      sinon.stub(tracer._dataStreamsProcessor, 'start').throws(new Error('boom'))
      const logError = sinon.stub(log, 'error')

      remoteConfigure(true)

      sinon.assert.calledOnceWithMatch(logError, 'Error %s Data Streams Monitoring', 'starting')
    })

    it('does not throw when stopping the processor fails', () => {
      createTracer(true)
      sinon.stub(tracer._dataStreamsProcessor, 'stop').throws(new Error('boom'))
      const logError = sinon.stub(log, 'error')

      remoteConfigure(false)

      sinon.assert.calledOnceWithMatch(logError, 'Error %s Data Streams Monitoring', 'stopping')
    })

    it('toggles the processor from a delivered APM_TRACING sdk_config payload', () => {
      createTracer(false)
      const handlers = new Map()
      const rc = {
        updateCapabilities: sinon.spy(),
        subscribeProducts: sinon.spy(),
        setBatchHandler: (products, handler) => handlers.set(products[0], handler),
      }
      // Same wiring as proxy.js: the handler updates config, then the tracer is reconfigured.
      enableTracingRemoteConfig(rc, config, () => tracer.configure(config))
      const handleApmTracing = handlers.get('APM_TRACING')
      const deliver = (id, sdkConfig, action = 'toApply') => {
        const item = { id, path: `datadog/1/APM_TRACING/${id}`, file: { sdk_config: { config: sdkConfig } } }
        handleApmTracing({
          toApply: action === 'toApply' ? [item] : [],
          toModify: [],
          toUnapply: action === 'toUnapply' ? [item] : [],
          ack: () => {},
          error: () => {},
        })
      }

      deliver('dsm', { DD_DATA_STREAMS_ENABLED: 'true' })
      assert.notStrictEqual(tracer.setCheckpoint(edgeTags, null), undefined)

      deliver('dsm', { DD_DATA_STREAMS_ENABLED: 'false' }, 'toUnapply')
      assert.strictEqual(tracer.setCheckpoint(edgeTags, null), undefined)
    })
  })

  describe('production lazy DataStreamsProcessor', () => {
    let tracer
    let config
    let flush

    beforeEach(() => {
      process.env.DD_DATA_STREAMS_ENABLED = 'true'
      const createConfig = proxyquire('../../src/config', {})
      config = createConfig({ service: 'service' })
      config.flushInterval = 1000
      // Required here: proxyquire.noPreserveCache above can evict the module cache at load time.
      const { DataStreamsWriter } = require('../../src/datastreams/writer')
      flush = sinon.stub(DataStreamsWriter.prototype, 'flush')
      tracer = new RealDatadogTracer(config)
      tracer._prioritySampler.configure = sinon.stub()
    })

    afterEach(() => {
      tracer?._dataStreamsProcessor.stop()
      sinon.restore()
      delete process.env.DD_DATA_STREAMS_ENABLED
    })

    it('stops with a flush and restarts its timer through the lazy wrapper', () => {
      tracer.setCheckpoint(edgeTags, null)
      assert.strictEqual(clock.countTimers(), 1)

      config.setRemoteConfig({ DD_DATA_STREAMS_ENABLED: 'false' })
      tracer.configure(config)

      assert.strictEqual(clock.countTimers(), 0)
      sinon.assert.calledOnce(flush)

      config.setRemoteConfig(null)
      tracer.configure(config)

      assert.strictEqual(clock.countTimers(), 1)
      assert.notStrictEqual(tracer.setCheckpoint(edgeTags, null), undefined)
    })
  })
})
