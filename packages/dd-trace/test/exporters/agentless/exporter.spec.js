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
    clock = sinon.useFakeTimers()

    writer = {
      append: sinon.stub(),
      flush: sinon.stub().callsFake((cb) => cb && cb()),
      setUrl: sinon.stub(),
      isFull: sinon.stub().returns(false),
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
    it('should flush immediately when flushInterval is 0', () => {
      exporter = new Exporter({ flushInterval: 0 })
      const spans = [{ name: 'test' }]

      exporter.export(spans)

      sinon.assert.calledWith(writer.append, spans)
      sinon.assert.calledOnce(writer.flush)
    })

    it('should schedule a deferred flush when flushInterval is set', () => {
      exporter = new Exporter({ flushInterval: 2000 })
      const spans = [{ name: 'test' }]

      exporter.export(spans)

      sinon.assert.calledWith(writer.append, spans)
      sinon.assert.notCalled(writer.flush)

      clock.tick(2000)

      sinon.assert.calledOnce(writer.flush)
    })

    it('should batch multiple traces into one scheduled flush', () => {
      exporter = new Exporter({ flushInterval: 2000 })
      const spans = [{ name: 'test' }]

      exporter.export(spans)
      exporter.export(spans)
      exporter.export(spans)

      sinon.assert.calledThrice(writer.append)
      sinon.assert.notCalled(writer.flush)

      clock.tick(2000)

      sinon.assert.calledOnce(writer.flush)
    })

    it('should flush immediately when buffer is full regardless of flushInterval', () => {
      writer.isFull = sinon.stub().returns(false)
      exporter = new Exporter({ flushInterval: 2000 })
      const spans = [{ name: 'test' }]

      exporter.export(spans)

      sinon.assert.notCalled(writer.flush)

      // Simulate buffer becoming full on next append
      writer.isFull.returns(true)
      exporter.export(spans)

      sinon.assert.calledOnce(writer.flush)
    })

    it('should clear pending timer when buffer is full', () => {
      writer.isFull = sinon.stub().returns(false)
      exporter = new Exporter({ flushInterval: 2000 })
      const spans = [{ name: 'test' }]

      // First export schedules timer
      exporter.export(spans)
      sinon.assert.notCalled(writer.flush)

      // Buffer becomes full - should flush and clear timer
      writer.isFull.returns(true)
      exporter.export(spans)
      sinon.assert.calledOnce(writer.flush)

      // Timer should have been cleared - no second flush
      clock.tick(2000)
      sinon.assert.calledOnce(writer.flush)
    })

    it('should schedule a new flush after the previous one fires', () => {
      exporter = new Exporter({ flushInterval: 2000 })
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

    it('should flush writer', () => {
      exporter.flush()

      sinon.assert.called(writer.flush)
    })

    it('should call callback when done', (done) => {
      exporter.flush(done)
    })

    it('should clear pending scheduled flush', () => {
      const spans = [{ name: 'test' }]
      exporter.export(spans)

      // Manual flush should clear the pending timer
      exporter.flush()
      sinon.assert.calledOnce(writer.flush)

      // Timer fires but should not trigger a second flush
      clock.tick(2000)
      sinon.assert.calledOnce(writer.flush)
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
