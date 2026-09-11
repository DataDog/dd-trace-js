'use strict'

const assert = require('node:assert/strict')
const { URL } = require('node:url')
const { inspect } = require('node:util')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { assertObjectContains } = require('../../../../../integration-tests/helpers')
const BaseWriter = require('../../../src/exporters/common/writer')

require('../../setup/core')

describe('AgentlessExporter', () => {
  let Exporter
  let exporter
  let writer
  let initialHandlersSize
  let clock
  let deliveryTrackingEnabled

  beforeEach(() => {
    const ddTrace = globalThis[Symbol.for('dd-trace')]
    deliveryTrackingEnabled = ddTrace.telemetryDeliveryTrackingEnabled
    ddTrace.telemetryDeliveryTrackingEnabled = false
    clock = sinon.useFakeTimers()

    writer = {
      append: sinon.stub(),
      enableDeliveryTracking: sinon.stub(),
      flush: sinon.stub().callsFake((cb) => cb && cb()),
      setUrl: sinon.stub(),
    }

    const Writer = function () {
      return writer
    }

    Exporter = proxyquire('../../../src/exporters/agentless', {
      './writer': Writer,
    })

    // Track the initial size of beforeExitHandlers to check additions
    initialHandlersSize = globalThis[Symbol.for('dd-trace')].beforeExitHandlers.size
  })

  afterEach(() => {
    clock.restore()
    sinon.restore()
    const ddTrace = globalThis[Symbol.for('dd-trace')]
    ddTrace.beforeExitHandlers.clear()
    if (deliveryTrackingEnabled === undefined) {
      delete ddTrace.telemetryDeliveryTrackingEnabled
    } else {
      ddTrace.telemetryDeliveryTrackingEnabled = deliveryTrackingEnabled
    }
  })

  describe('constructor', () => {
    it('does not enable delivery tracking without an OTel TracerProvider', () => {
      const writerOptions = {}
      /** @param {object} options */
      const Writer = function (options) {
        Object.assign(writerOptions, options)
        return writer
      }
      Exporter = proxyquire('../../../src/exporters/agentless', { './writer': Writer })

      exporter = new Exporter({})

      assert.strictEqual(writerOptions.deliveryTracker, undefined)
    })

    it('enables delivery tracking after construction', () => {
      exporter = new Exporter({})

      exporter.enableDeliveryTracking()
      exporter.enableDeliveryTracking()

      sinon.assert.calledOnceWithExactly(writer.enableDeliveryTracking, sinon.match.object)
    })

    it('keeps serverless delivery tracking without an OTel TracerProvider', () => {
      const deliveryTracker = {}
      const writerOptions = {}
      /** @param {object} options */
      const Writer = function (options) {
        Object.assign(writerOptions, options)
        return writer
      }
      Exporter = proxyquire('../../../src/exporters/agentless', {
        '../../serverless': { createServerlessDeliveryTracker: () => deliveryTracker },
        './writer': Writer,
      })

      exporter = new Exporter({})

      assert.strictEqual(writerOptions.deliveryTracker, deliveryTracker)
    })

    it('should construct intake URL from site', () => {
      exporter = new Exporter({ site: 'datadoghq.eu' })

      const expectedUrl = new URL('https://public-trace-http-intake.logs.datadoghq.eu')
      sinon.assert.match(exporter._url.href, expectedUrl.href)
    })

    it('should send to the https intake and ignore the agent URL (config.url)', () => {
      exporter = new Exporter({ url: 'http://127.0.0.1:8126', site: 'datadoghq.com' })

      assert.strictEqual(exporter._url.href, 'https://public-trace-http-intake.logs.datadoghq.com/')
    })

    it('should default to datadoghq.com site', () => {
      exporter = new Exporter({})

      sinon.assert.match(exporter._url.hostname, 'public-trace-http-intake.logs.datadoghq.com')
    })

    it('should map a regional site to its data-center intake host', () => {
      exporter = new Exporter({ site: 'us3.datadoghq.com' })

      assert.strictEqual(exporter._url.hostname, 'trace.browser-intake-us3-datadoghq.com')
    })

    it('should register beforeExit handler', () => {
      exporter = new Exporter({})

      // Should have added one handler
      sinon.assert.match(
        globalThis[Symbol.for('dd-trace')].beforeExitHandlers.size,
        initialHandlersSize + 1
      )
    })

    it('should handle an invalid site gracefully', () => {
      const log = { error: sinon.spy() }

      Exporter = proxyquire('../../../src/exporters/agentless', {
        './writer': function () { return writer },
        '../../log': log,
      })

      exporter = new Exporter({ site: 'bad host' })

      sinon.assert.calledOnce(log.error)
      assert.strictEqual(exporter._url, null)
    })

    it('should pass metadata from config to writer', () => {
      const writerOptions = {}
      const Writer = function (opts) {
        Object.assign(writerOptions, opts)
        return writer
      }

      Exporter = proxyquire('../../../src/exporters/agentless', {
        '../common/docker': { containerId: 'container-id' },
        './writer': Writer,
      })

      exporter = new Exporter({
        site: 'datadoghq.com',
        env: 'production',
        tags: { 'runtime-id': 'test-uuid' },
      })

      assert.ok(writerOptions.metadata)
      assertObjectContains(writerOptions.metadata, {
        containerId: 'container-id',
        env: 'production',
        runtimeID: 'test-uuid',
      })
    })

    it('should omit container metadata when only an entity ID is available', () => {
      const writerOptions = {}
      /** @param {object} options */
      const Writer = function (options) {
        Object.assign(writerOptions, options)
        return writer
      }

      Exporter = proxyquire('../../../src/exporters/agentless', {
        './writer': Writer,
        '../common/docker': {
          containerId: undefined,
          entityId: 'in-1234',
        },
      })

      exporter = new Exporter({
        site: 'datadoghq.com',
        tags: { 'runtime-id': 'test-uuid' },
      })

      assert.strictEqual(Object.hasOwn(writerOptions.metadata, 'containerID'), false)
    })

    it('should reflect a runtime id updated on config after construction', () => {
      const writerOptions = {}
      const Writer = function (opts) {
        Object.assign(writerOptions, opts)
        return writer
      }

      Exporter = proxyquire('../../../src/exporters/agentless', {
        './writer': Writer,
      })

      const config = {
        site: 'datadoghq.com',
        env: 'production',
        tags: { 'runtime-id': 'test-uuid' },
      }

      exporter = new Exporter(config)

      config.tags['runtime-id'] = 'new-uuid'

      assert.strictEqual(writerOptions.metadata.runtimeID, 'new-uuid')
    })

    it('should reflect an env updated on config after construction', () => {
      const writerOptions = {}
      const Writer = function (opts) {
        Object.assign(writerOptions, opts)
        return writer
      }

      Exporter = proxyquire('../../../src/exporters/agentless', {
        './writer': Writer,
      })

      const config = {
        site: 'datadoghq.com',
        env: 'production',
        tags: { 'runtime-id': 'test-uuid' },
      }

      exporter = new Exporter(config)

      config.env = 'staging'

      assert.strictEqual(writerOptions.metadata.env, 'staging')
    })
  })

  describe('export', () => {
    it('should append spans to writer and schedule flush', () => {
      exporter = new Exporter({ flushInterval: 1000 })
      const spans = [{ name: 'test' }]

      exporter.export(spans)

      sinon.assert.calledWith(writer.append, spans)
      sinon.assert.notCalled(writer.flush)

      clock.tick(1000)

      sinon.assert.calledOnce(writer.flush)
    })

    it('should batch multiple exports into one flush', () => {
      exporter = new Exporter({ flushInterval: 1000 })
      const spans = [{ name: 'test' }]

      exporter.export(spans)
      exporter.export(spans)
      exporter.export(spans)

      sinon.assert.calledThrice(writer.append)
      sinon.assert.notCalled(writer.flush)

      clock.tick(1000)

      sinon.assert.calledOnce(writer.flush)
    })

    it('should re-arm timer after flush for subsequent exports', () => {
      exporter = new Exporter({ flushInterval: 1000 })
      const spans = [{ name: 'test' }]

      // First cycle
      exporter.export(spans)
      clock.tick(1000)
      sinon.assert.calledOnce(writer.flush)

      // Second cycle
      exporter.export(spans)
      sinon.assert.calledOnce(writer.flush) // not yet

      clock.tick(1000)
      sinon.assert.calledTwice(writer.flush)
    })

    it('should flush immediately when flushInterval is 0', () => {
      exporter = new Exporter({ flushInterval: 0 })
      const spans = [{ name: 'test' }]

      exporter.export(spans)

      sinon.assert.calledWith(writer.append, spans)
      sinon.assert.calledOnce(writer.flush)
    })
  })

  describe('flush', () => {
    beforeEach(() => {
      exporter = new Exporter({ flushInterval: 1000 })
    })

    it('should flush writer immediately', () => {
      exporter.flush()

      sinon.assert.called(writer.flush)
    })

    it('should clear pending timer on explicit flush', () => {
      exporter.export([{ name: 'test' }])
      exporter.flush()

      sinon.assert.calledOnce(writer.flush)

      // Timer should be cleared, so ticking should not trigger another flush
      clock.tick(1000)

      sinon.assert.calledOnce(writer.flush)
    })

    it('should call callback when done', (done) => {
      exporter.flush(done)
    })

    it('reports writer failures when requested', () => {
      const error = new Error('writer failed')
      writer.flush.callsFake(done => done(error))
      const done = sinon.spy()

      exporter.flush(done, { reportErrors: true })

      sinon.assert.calledOnceWithExactly(writer.flush, sinon.match.func, { reportErrors: true })
      sinon.assert.calledOnceWithExactly(done, error)
    })

    it('waits for an active delivery before reporting a boundary failure', () => {
      let completeDelivery
      let failPayload = false
      const boundaryError = new Error('boundary failed')
      class ControlledWriter extends BaseWriter {
        /** @param {object} options */
        constructor (options) {
          super(options)
          let count = 0
          this._encoder = {
            count: () => count,
            encode: () => { count++ },
            makePayload: () => {
              if (failPayload) throw boundaryError
              count = 0
              return Buffer.from('payload')
            },
            reset: () => { count = 0 },
          }
        }

        /**
         * @param {Buffer} data
         * @param {number} count
         * @param {(error?: Error) => void} done
         */
        _sendPayload (data, count, done) {
          completeDelivery = done
        }
      }
      Exporter = proxyquire('../../../src/exporters/agentless', {
        './writer': ControlledWriter,
      })
      globalThis[Symbol.for('dd-trace')].telemetryDeliveryTrackingEnabled = true
      exporter = new Exporter({ flushInterval: 1 })
      const done = sinon.spy()

      exporter.export([{ name: 'active' }])
      clock.tick(1)
      exporter.export([{ name: 'boundary' }])
      failPayload = true
      exporter.flush(done, { reportErrors: true })

      sinon.assert.notCalled(done)
      assert.strictEqual(typeof completeDelivery, 'function')
      completeDelivery()
      sinon.assert.calledOnceWithExactly(done, boundaryError)
    })

    it('reports synchronous writer failures when requested', () => {
      const error = new Error('writer failed')
      writer.flush.throws(error)
      const done = sinon.spy()

      exporter.flush(done, { reportErrors: true })

      sinon.assert.calledOnceWithExactly(done, error)
    })

    it('suppresses synchronous writer failures by default', () => {
      writer.flush.throws(new Error('writer failed'))
      const done = sinon.spy()

      exporter.flush(done)

      sinon.assert.calledOnceWithExactly(done, undefined)
    })

    it('normalizes non-error flush failures when requested', () => {
      const error = { toString: () => 'writer failed' }
      writer.flush.callsFake(() => { throw error })
      const done = sinon.spy()

      exporter.flush(done, { reportErrors: true })

      sinon.assert.calledOnce(done)
      assert.ok(done.firstCall.firstArg instanceof Error)
      assert.strictEqual(done.firstCall.firstArg.message, 'writer failed')
    })
  })

  describe('setUrl', () => {
    let log

    beforeEach(() => {
      log = {
        error: sinon.spy(),
        warn: sinon.spy(),
      }

      Exporter = proxyquire('../../../src/exporters/agentless', {
        './writer': function () { return writer },
        '../../log': log,
      })

      exporter = new Exporter({})
    })

    it('should update URL on exporter and writer', () => {
      const newUrl = 'https://new-intake.example.com'
      const result = exporter.setUrl(newUrl)

      assert.strictEqual(result, true)
      sinon.assert.called(writer.setUrl)
    })

    it('should update exporter._url property', () => {
      const newUrl = 'https://new-intake.example.com'
      exporter.setUrl(newUrl)

      sinon.assert.match(exporter._url.href, newUrl)
    })

    it('should return false and log error when URL is invalid', () => {
      const originalUrl = exporter._url.href
      const result = exporter.setUrl('not-a-valid-url')

      assert.strictEqual(result, false)
      sinon.assert.calledOnce(log.error)
      const call = log.error.getCall(0)
      assert.ok(call.args[0].includes('Invalid URL'), `Got: ${inspect(call.args[0])}`)
      // Invalid URL is passed as second argument (printf-style)
      assert.strictEqual(call.args[1], 'not-a-valid-url')
      sinon.assert.notCalled(writer.setUrl)
      sinon.assert.match(exporter._url.href, originalUrl)
    })
  })
})
