'use strict'

const assert = require('node:assert/strict')
const { URL } = require('node:url')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { assertObjectContains } = require('../../../../../integration-tests/helpers')

require('../../setup/core')

describe('AgentlessExporter', () => {
  let Exporter
  let exporter
  let writer
  let initialHandlersSize
  let clock

  beforeEach(() => {
    clock = sinon.useFakeTimers()

    writer = {
      append: sinon.stub(),
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
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.clear()
  })

  describe('constructor', () => {
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
  })
})
