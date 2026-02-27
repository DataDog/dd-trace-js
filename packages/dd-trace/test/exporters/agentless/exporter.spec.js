'use strict'

const assert = require('node:assert/strict')
const { URL } = require('node:url')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')

describe('AgentlessExporter', () => {
  let Exporter
  let exporter
  let writer
  let clock
  let initialHandlersSize

  beforeEach(() => {
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

    clock = sinon.useFakeTimers()
  })

  afterEach(() => {
    clock.restore()
    sinon.restore()
    // Clean up any handlers added by tests
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.clear()
  })

  describe('constructor', () => {
    it('should construct intake URL from site', () => {
      exporter = new Exporter({ site: 'datadoghq.eu', flushInterval: 2000 })

      const expectedUrl = new URL('https://public-trace-http-intake.logs.datadoghq.eu')
      sinon.assert.match(exporter._url.href, expectedUrl.href)
    })

    it('should use provided URL', () => {
      const customUrl = 'https://custom-intake.example.com'
      exporter = new Exporter({ url: customUrl, site: 'datadoghq.com', flushInterval: 2000 })

      sinon.assert.match(exporter._url.href, customUrl)
    })

    it('should default to datadoghq.com site', () => {
      exporter = new Exporter({ flushInterval: 2000 })

      sinon.assert.match(exporter._url.hostname, 'public-trace-http-intake.logs.datadoghq.com')
    })

    it('should register beforeExit handler', () => {
      exporter = new Exporter({ flushInterval: 2000 })

      // Should have added one handler
      sinon.assert.match(
        globalThis[Symbol.for('dd-trace')].beforeExitHandlers.size,
        initialHandlersSize + 1
      )
    })
  })

  describe('export', () => {
    beforeEach(() => {
      exporter = new Exporter({ flushInterval: 2000 })
    })

    it('should append spans to writer', () => {
      const spans = [{ name: 'test' }]
      exporter.export(spans)

      sinon.assert.calledWith(writer.append, spans)
    })

    it('should flush immediately when flushInterval is 0', () => {
      exporter = new Exporter({ flushInterval: 0 })
      const spans = [{ name: 'test' }]

      exporter.export(spans)

      sinon.assert.called(writer.flush)
    })

    it('should schedule flush when flushInterval > 0', () => {
      const spans = [{ name: 'test' }]

      exporter.export(spans)

      sinon.assert.notCalled(writer.flush)

      clock.tick(2000)

      sinon.assert.called(writer.flush)
    })

    it('should not schedule multiple flushes', () => {
      const spans = [{ name: 'test' }]

      exporter.export(spans)
      exporter.export(spans)
      exporter.export(spans)

      clock.tick(2000)

      sinon.assert.calledOnce(writer.flush)
    })

    it('should allow scheduling flush again after previous completes', () => {
      const spans = [{ name: 'test' }]

      exporter.export(spans)
      clock.tick(2000)

      sinon.assert.calledOnce(writer.flush)

      exporter.export(spans)
      clock.tick(2000)

      sinon.assert.calledTwice(writer.flush)
    })
  })

  describe('flush', () => {
    beforeEach(() => {
      exporter = new Exporter({ flushInterval: 2000 })
    })

    it('should flush writer immediately', () => {
      exporter.flush()

      sinon.assert.called(writer.flush)
    })

    it('should cancel pending scheduled flush', () => {
      const spans = [{ name: 'test' }]
      exporter.export(spans)

      exporter.flush()

      sinon.assert.calledOnce(writer.flush)

      clock.tick(2000)

      sinon.assert.calledOnce(writer.flush) // still only called once
    })

    it('should call callback when done', (done) => {
      exporter.flush(done)
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

      exporter = new Exporter({ flushInterval: 2000 })
    })

    it('should update URL on exporter and writer', () => {
      const newUrl = 'https://new-intake.example.com'
      exporter.setUrl(newUrl)

      sinon.assert.called(writer.setUrl)
    })

    it('should update exporter._url property', () => {
      const newUrl = 'https://new-intake.example.com'
      exporter.setUrl(newUrl)

      sinon.assert.match(exporter._url.href, newUrl)
    })

    it('should log error and keep previous URL when URL is invalid', () => {
      const originalUrl = exporter._url.href
      exporter.setUrl('not-a-valid-url')

      sinon.assert.calledOnce(log.error)
      const call = log.error.getCall(0)
      assert.ok(call.args[0].includes('Invalid URL'))
      // Invalid URL is passed as second argument (printf-style)
      assert.strictEqual(call.args[1], 'not-a-valid-url')
      sinon.assert.notCalled(writer.setUrl)
      sinon.assert.match(exporter._url.href, originalUrl)
    })
  })
})
