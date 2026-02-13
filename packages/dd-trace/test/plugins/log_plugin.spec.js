'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { assertObjectContains } = require('../../../../integration-tests/helpers')
require('../setup/core')
const Tracer = require('../../src/tracer')
const getConfig = require('../../src/config')

// Stub the internal dd-trace logger so we can assert on warn/error/debug/info calls
const log = {
  debug: sinon.stub(),
  warn: sinon.stub(),
  info: sinon.stub(),
  error: sinon.stub(),
}

// Winston mock — Http is a constructor stub
const MockHttpTransport = sinon.stub()
const mockWinston = { transports: { Http: MockHttpTransport } }

// Bunyan stream constructor stub
const MockBunyanHttpStream = sinon.stub()

// Pino transport factory stub
const mockPinoHttpTransport = sinon.stub()

const LogPlugin = proxyquire('../../src/plugins/log_plugin', {
  '../log': log,
  winston: mockWinston,
  './bunyan_http_stream': MockBunyanHttpStream,
  './pino_http_transport': mockPinoHttpTransport,
})

class TestLog extends LogPlugin {
  static id = 'test'
}

const testLogChannel = channel('apm:test:log')
const winstonChannel = channel('apm:winston:log-capture-add-transport')
const bunyanChannel = channel('ci:log-submission:bunyan:add-stream')
const pinoChannel = channel('ci:log-submission:pino:get-transport-config')

const ddConfig = { env: 'my-env', service: 'my-service', version: '1.2.3' }

const tracer = new Tracer(getConfig({ logInjection: true, enabled: true, ...ddConfig }))

// Plugin used for the existing log-injection tests
const plugin = new TestLog({ _tracer: tracer })
plugin.configure({ logInjection: true, enabled: true })

// Base config for transport injection tests
const transportConfig = {
  logCaptureEnabled: true,
  logCaptureMethod: 'transport',
  logCaptureHost: 'localhost',
  logCapturePort: 8080,
  logCapturePath: '/test-logs',
  enabled: true,
}

describe('LogPlugin', () => {
  describe('log injection', () => {
    it('always adds service, version, and env', () => {
      const data = { message: {} }
      testLogChannel.publish(data)
      const { message } = data

      assert.deepStrictEqual(message.dd, ddConfig)
      assert.ok(!('trace_id' in message.dd))
      assert.ok(!('span_id' in message.dd))
    })

    it('should include trace_id and span_id when a span is active', () => {
      const span = tracer.startSpan('test')

      tracer.scope().activate(span, () => {
        const data = { message: {} }
        testLogChannel.publish(data)
        const { message } = data

        assertObjectContains(message.dd, ddConfig)
        assert.strictEqual(message.dd.trace_id, span.context().toTraceId(true))
        assert.strictEqual(message.dd.span_id, span.context().toSpanId())
      })
    })
  })

  describe('configure', () => {
    it('enables when logInjection is true', () => {
      const p = new TestLog({ _tracer: tracer })
      p.configure({ logInjection: true, enabled: true })
      assert.strictEqual(p._enabled, true)
      p.configure({ enabled: false })
    })

    it('enables when ciVisAgentlessLogSubmissionEnabled is true', () => {
      const p = new TestLog({ _tracer: tracer })
      p.configure({ ciVisAgentlessLogSubmissionEnabled: true, enabled: true })
      assert.strictEqual(p._enabled, true)
      p.configure({ enabled: false })
    })

    it('enables when logCaptureEnabled and logCaptureMethod is transport', () => {
      const p = new TestLog({ _tracer: tracer })
      p.configure({ logCaptureEnabled: true, logCaptureMethod: 'transport', enabled: true })
      assert.strictEqual(p._enabled, true)
      p.configure({ enabled: false })
    })

    it('disables when logCaptureEnabled but logCaptureMethod is not transport', () => {
      const p = new TestLog({ _tracer: tracer })
      p.configure({ logCaptureEnabled: true, logCaptureMethod: 'agentless', enabled: true })
      assert.strictEqual(p._enabled, false)
      p.configure({ enabled: false })
    })

    it('disables when none of the enabling conditions are true', () => {
      const p = new TestLog({ _tracer: tracer })
      p.configure({ enabled: true })
      assert.strictEqual(p._enabled, false)
      p.configure({ enabled: false })
    })
  })

  describe('Winston transport injection', () => {
    let transportPlugin

    beforeEach(() => {
      sinon.resetHistory()
      MockHttpTransport.resetBehavior()
      MockHttpTransport.returns({})
      transportPlugin = new TestLog({ _tracer: tracer })
      transportPlugin.configure(transportConfig)
    })

    afterEach(() => {
      transportPlugin.configure({ enabled: false })
    })

    it('injects HTTP transport into a Winston logger', () => {
      const logger = { add: sinon.stub() }
      winstonChannel.publish(logger)
      assert.strictEqual(logger.add.callCount, 1)
    })

    it('does not inject transport twice for the same logger', () => {
      const logger = { add: sinon.stub() }
      winstonChannel.publish(logger)
      winstonChannel.publish(logger)
      assert.strictEqual(logger.add.callCount, 1)
    })

    it('can inject into multiple different loggers independently', () => {
      const logger1 = { add: sinon.stub() }
      const logger2 = { add: sinon.stub() }
      winstonChannel.publish(logger1)
      winstonChannel.publish(logger2)
      assert.strictEqual(logger1.add.callCount, 1)
      assert.strictEqual(logger2.add.callCount, 1)
    })

    it('warns and skips when logCaptureHost is missing', () => {
      transportPlugin.configure({ ...transportConfig, logCaptureHost: undefined })
      const logger = { add: sinon.stub() }
      winstonChannel.publish(logger)
      assert.strictEqual(logger.add.callCount, 0)
      assert.ok(log.warn.called)
    })

    it('warns and skips when logCapturePort is missing', () => {
      transportPlugin.configure({ ...transportConfig, logCapturePort: undefined })
      const logger = { add: sinon.stub() }
      winstonChannel.publish(logger)
      assert.strictEqual(logger.add.callCount, 0)
      assert.ok(log.warn.called)
    })

    it('warns and skips when winston has no Http transport', () => {
      const saved = mockWinston.transports.Http
      delete mockWinston.transports.Http
      try {
        const logger = { add: sinon.stub() }
        winstonChannel.publish(logger)
        assert.strictEqual(logger.add.callCount, 0)
        assert.ok(log.warn.called)
      } finally {
        mockWinston.transports.Http = saved
      }
    })

    it('passes correct options to the Http transport constructor', () => {
      const logger = { add: sinon.stub() }
      winstonChannel.publish(logger)
      assert.ok(MockHttpTransport.calledOnce)
      const [opts] = MockHttpTransport.firstCall.args
      assert.strictEqual(opts.host, 'localhost')
      assert.strictEqual(opts.port, 8080)
      assert.strictEqual(opts.path, '/test-logs')
      assert.strictEqual(opts.ssl, false)
    })

    it('uses /logs as default path when logCapturePath is not set', () => {
      transportPlugin.configure({ ...transportConfig, logCapturePath: undefined })
      const logger = { add: sinon.stub() }
      winstonChannel.publish(logger)
      const [opts] = MockHttpTransport.firstCall.args
      assert.strictEqual(opts.path, '/logs')
    })

    it('sets ssl: true when protocol is https:', () => {
      transportPlugin.configure({ ...transportConfig, logCaptureProtocol: 'https:' })
      const logger = { add: sinon.stub() }
      winstonChannel.publish(logger)
      const [opts] = MockHttpTransport.firstCall.args
      assert.strictEqual(opts.ssl, true)
    })

    it('logs error and does not throw when injection fails', () => {
      MockHttpTransport.throws(new Error('transport error'))
      const logger = { add: sinon.stub() }
      winstonChannel.publish(logger) // Must not throw
      assert.ok(log.error.called)
    })
  })

  describe('Bunyan stream injection', () => {
    let transportPlugin

    beforeEach(() => {
      sinon.resetHistory()
      MockBunyanHttpStream.resetBehavior()
      transportPlugin = new TestLog({ _tracer: tracer })
      transportPlugin.configure(transportConfig)
    })

    afterEach(() => {
      transportPlugin.configure({ enabled: false })
    })

    it('injects HTTP stream into a Bunyan logger', () => {
      const logger = { addStream: sinon.stub() }
      bunyanChannel.publish(logger)
      assert.strictEqual(logger.addStream.callCount, 1)
    })

    it('does not inject stream twice for the same logger', () => {
      const logger = { addStream: sinon.stub() }
      bunyanChannel.publish(logger)
      bunyanChannel.publish(logger)
      assert.strictEqual(logger.addStream.callCount, 1)
    })

    it('can inject into multiple different loggers independently', () => {
      const logger1 = { addStream: sinon.stub() }
      const logger2 = { addStream: sinon.stub() }
      bunyanChannel.publish(logger1)
      bunyanChannel.publish(logger2)
      assert.strictEqual(logger1.addStream.callCount, 1)
      assert.strictEqual(logger2.addStream.callCount, 1)
    })

    it('warns and skips when logCaptureHost is missing', () => {
      transportPlugin.configure({ ...transportConfig, logCaptureHost: undefined })
      const logger = { addStream: sinon.stub() }
      bunyanChannel.publish(logger)
      assert.strictEqual(logger.addStream.callCount, 0)
      assert.ok(log.warn.called)
    })

    it('warns and skips when logCapturePort is missing', () => {
      transportPlugin.configure({ ...transportConfig, logCapturePort: undefined })
      const logger = { addStream: sinon.stub() }
      bunyanChannel.publish(logger)
      assert.strictEqual(logger.addStream.callCount, 0)
      assert.ok(log.warn.called)
    })

    it('calls addStream with type raw and level trace', () => {
      const logger = { addStream: sinon.stub() }
      bunyanChannel.publish(logger)
      const [streamOpts] = logger.addStream.firstCall.args
      assert.strictEqual(streamOpts.type, 'raw')
      assert.strictEqual(streamOpts.level, 'trace')
    })

    it('passes correct options to the BunyanHttpStream constructor', () => {
      const logger = { addStream: sinon.stub() }
      bunyanChannel.publish(logger)
      assert.ok(MockBunyanHttpStream.calledOnce)
      const [opts] = MockBunyanHttpStream.firstCall.args
      assert.strictEqual(opts.host, 'localhost')
      assert.strictEqual(opts.port, 8080)
      assert.strictEqual(opts.path, '/test-logs')
    })

    it('uses /logs as default path when logCapturePath is not set', () => {
      transportPlugin.configure({ ...transportConfig, logCapturePath: undefined })
      const logger = { addStream: sinon.stub() }
      bunyanChannel.publish(logger)
      const [opts] = MockBunyanHttpStream.firstCall.args
      assert.strictEqual(opts.path, '/logs')
    })

    it('logs error and does not throw when injection fails', () => {
      MockBunyanHttpStream.throws(new Error('stream error'))
      const logger = { addStream: sinon.stub() }
      bunyanChannel.publish(logger) // Must not throw
      assert.ok(log.error.called)
    })
  })

  describe('Pino transport injection', () => {
    let transportPlugin

    beforeEach(() => {
      sinon.resetHistory()
      mockPinoHttpTransport.resetBehavior()
      mockPinoHttpTransport.returns({})
      transportPlugin = new TestLog({ _tracer: tracer })
      transportPlugin.configure(transportConfig)
    })

    afterEach(() => {
      transportPlugin.configure({ enabled: false })
    })

    it('sets transport on the config payload', () => {
      const pinoTransport = {}
      mockPinoHttpTransport.returns(pinoTransport)
      const payload = {}
      pinoChannel.publish(payload)
      assert.strictEqual(payload.transport, pinoTransport)
    })

    it('creates the transport only once across multiple pino() calls', () => {
      const pinoTransport = {}
      mockPinoHttpTransport.returns(pinoTransport)

      const payload1 = {}
      const payload2 = {}
      pinoChannel.publish(payload1)
      pinoChannel.publish(payload2)

      assert.strictEqual(mockPinoHttpTransport.callCount, 1, 'factory should be called only once')
      assert.strictEqual(payload1.transport, pinoTransport)
      assert.strictEqual(payload2.transport, pinoTransport)
    })

    it('warns and leaves transport undefined when logCaptureHost is missing', () => {
      transportPlugin.configure({ ...transportConfig, logCaptureHost: undefined })
      const payload = {}
      pinoChannel.publish(payload)
      assert.strictEqual(payload.transport, undefined)
      assert.ok(log.warn.called)
    })

    it('warns and leaves transport undefined when logCapturePort is missing', () => {
      transportPlugin.configure({ ...transportConfig, logCapturePort: undefined })
      const payload = {}
      pinoChannel.publish(payload)
      assert.strictEqual(payload.transport, undefined)
      assert.ok(log.warn.called)
    })

    it('passes correct options to the pinoHttpTransport factory', () => {
      const payload = {}
      pinoChannel.publish(payload)
      assert.ok(mockPinoHttpTransport.calledOnce)
      const [opts] = mockPinoHttpTransport.firstCall.args
      assert.strictEqual(opts.host, 'localhost')
      assert.strictEqual(opts.port, 8080)
      assert.strictEqual(opts.path, '/test-logs')
    })

    it('uses /logs as default path when logCapturePath is not set', () => {
      transportPlugin.configure({ ...transportConfig, logCapturePath: undefined })
      const payload = {}
      pinoChannel.publish(payload)
      const [opts] = mockPinoHttpTransport.firstCall.args
      assert.strictEqual(opts.path, '/logs')
    })

    it('logs error and does not throw when transport creation fails', () => {
      mockPinoHttpTransport.throws(new Error('pino failed'))
      const payload = {}
      pinoChannel.publish(payload) // Must not throw
      assert.ok(log.error.called)
    })
  })
})
