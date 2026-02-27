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
  })

  afterEach(() => {
    sinon.restore()
    // Clean up any handlers added by tests
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.clear()
  })

  describe('constructor', () => {
    it('should construct intake URL from site', () => {
      exporter = new Exporter({ site: 'datadoghq.eu' })

      const expectedUrl = new URL('https://public-trace-http-intake.logs.datadoghq.eu')
      sinon.assert.match(exporter._url.href, expectedUrl.href)
    })

    it('should use provided URL', () => {
      const customUrl = 'https://custom-intake.example.com'
      exporter = new Exporter({ url: customUrl, site: 'datadoghq.com' })

      sinon.assert.match(exporter._url.href, customUrl)
    })

    it('should default to datadoghq.com site', () => {
      exporter = new Exporter({})

      sinon.assert.match(exporter._url.hostname, 'public-trace-http-intake.logs.datadoghq.com')
    })

    it('should register beforeExit handler', () => {
      exporter = new Exporter({})

      // Should have added one handler
      sinon.assert.match(
        globalThis[Symbol.for('dd-trace')].beforeExitHandlers.size,
        initialHandlersSize + 1
      )
    })

    it('should handle invalid URL gracefully', () => {
      const log = { error: sinon.spy() }

      Exporter = proxyquire('../../../src/exporters/agentless', {
        './writer': function () { return writer },
        '../../log': log,
      })

      exporter = new Exporter({ url: 'not-a-valid-url' })

      sinon.assert.calledOnce(log.error)
      assert.strictEqual(exporter._url, null)
    })
  })

  describe('export', () => {
    beforeEach(() => {
      exporter = new Exporter({})
    })

    it('should append spans to writer and flush immediately', () => {
      const spans = [{ name: 'test' }]
      exporter.export(spans)

      sinon.assert.calledWith(writer.append, spans)
      sinon.assert.calledOnce(writer.flush)
    })

    it('should flush after each export', () => {
      const spans = [{ name: 'test' }]

      exporter.export(spans)
      exporter.export(spans)
      exporter.export(spans)

      sinon.assert.calledThrice(writer.flush)
    })
  })

  describe('flush', () => {
    beforeEach(() => {
      exporter = new Exporter({})
    })

    it('should flush writer', () => {
      exporter.flush()

      sinon.assert.called(writer.flush)
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
      assert.ok(call.args[0].includes('Invalid URL'))
      // Invalid URL is passed as second argument (printf-style)
      assert.strictEqual(call.args[1], 'not-a-valid-url')
      sinon.assert.notCalled(writer.setUrl)
      sinon.assert.match(exporter._url.href, originalUrl)
    })
  })
})
