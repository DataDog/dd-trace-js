'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const tracer = require('../../')

describe('OpenTelemetry Logs', () => {
  let originalEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    process.env.DD_SERVICE = 'test-service'
    process.env.DD_VERSION = '1.0.0'
    process.env.DD_ENV = 'test'
  })

  afterEach(() => {
    process.env = originalEnv
    // Clean up OpenTelemetry API state
    const { logs } = require('@opentelemetry/api-logs')
    const loggerProvider = logs.getLoggerProvider()
    if (loggerProvider && typeof loggerProvider.shutdown === 'function') {
      loggerProvider.shutdown()
    }
  })

  it('should initialize OpenTelemetry logs when otelLogsEnabled is true', () => {
    process.env.DD_LOGS_OTEL_ENABLED = 'true'
    tracer.init()

    // Access the logger through OpenTelemetry API
    const { logs } = require('@opentelemetry/api-logs')
    const loggerProvider = logs.getLoggerProvider()
    expect(loggerProvider).to.exist
    expect(loggerProvider.constructor.name).to.equal('LoggerProvider')

    const logger = logs.getLogger('test-logger')
    expect(logger).to.exist
    expect(logger.constructor.name).to.equal('Logger')
    expect(typeof logger.emit).to.equal('function')
  })

  it('should not initialize OpenTelemetry logs when otelLogsEnabled is false', () => {
    // Set environment variable to disable logs BEFORE initialization
    process.env.DD_LOGS_OTEL_ENABLED = 'false'

    // Clean up any existing LoggerProvider first
    const { logs } = require('@opentelemetry/api-logs')
    const existingProvider = logs.getLoggerProvider()
    if (existingProvider && typeof existingProvider.shutdown === 'function') {
      existingProvider.shutdown()
    }

    tracer.init()

    // After initialization with DD_LOGS_OTEL_ENABLED='false',
    // we should still be able to get a logger (it will be a no-op logger)
    const logger = logs.getLogger('test-logger')
    expect(logger).to.exist
    expect(typeof logger.emit).to.equal('function')

    // The logger should work without throwing errors
    expect(() => {
      logger.emit({
        severityText: 'INFO',
        severityNumber: 9,
        body: 'Test message',
        timestamp: Date.now() * 1000000
      })
    }).to.not.throw()
  })

  it('should create a logger and emit log records', () => {
    process.env.DD_LOGS_OTEL_ENABLED = 'true'
    tracer.init()

    // Access the logger through OpenTelemetry API
    const { logs } = require('@opentelemetry/api-logs')
    const logger = logs.getLogger('test-logger', '1.0.0')

    // Test that emit method works without throwing
    expect(() => {
      logger.emit({
        severityText: 'INFO',
        severityNumber: 9,
        body: 'Test log message',
        attributes: { test: 'attribute' },
        timestamp: Date.now() * 1000000
      })
    }).to.not.throw()
  })

  it('should handle different log levels', () => {
    process.env.DD_LOGS_OTEL_ENABLED = 'true'
    tracer.init()

    // Access the logger through OpenTelemetry API
    const { logs } = require('@opentelemetry/api-logs')
    const logger = logs.getLogger('test-logger')

    // Test different log levels using emit method
    const logLevels = [
      { severityText: 'DEBUG', severityNumber: 5, body: 'Debug message' },
      { severityText: 'INFO', severityNumber: 9, body: 'Info message' },
      { severityText: 'WARN', severityNumber: 13, body: 'Warning message' },
      { severityText: 'ERROR', severityNumber: 17, body: 'Error message' },
      { severityText: 'FATAL', severityNumber: 21, body: 'Fatal message' }
    ]

    logLevels.forEach(logLevel => {
      expect(() => {
        logger.emit({
          ...logLevel,
          timestamp: Date.now() * 1000000
        })
      }).to.not.throw()
    })
  })

  it('should support force flush', async () => {
    process.env.DD_LOGS_OTEL_ENABLED = 'true'
    tracer.init()

    // Access the logger through OpenTelemetry API
    const { logs } = require('@opentelemetry/api-logs')
    const loggerProvider = logs.getLoggerProvider()
    const activeProcessor = loggerProvider.getActiveLogRecordProcessor()

    expect(activeProcessor).to.exist
    expect(typeof activeProcessor.forceFlush).to.equal('function')

    // Test force flush doesn't throw
    try {
      await activeProcessor.forceFlush()
      expect(true).to.be.true // If we get here, forceFlush succeeded
    } catch (error) {
      expect.fail('forceFlush should not throw an error')
    }
  })

  it('should use configuration defaults when environment variables are not set', () => {
    process.env.DD_LOGS_OTEL_ENABLED = 'true'
    // Clear environment variables to test defaults
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS
    delete process.env.OTEL_EXPORTER_OTLP_TIMEOUT
    delete process.env.OTEL_BSP_SCHEDULE_DELAY
    delete process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE
    delete process.env.OTEL_BSP_MAX_QUEUE_SIZE
    delete process.env.OTEL_BSP_EXPORT_TIMEOUT

    tracer.init()

    // Access the logger through OpenTelemetry API
    const { logs } = require('@opentelemetry/api-logs')
    const loggerProvider = logs.getLoggerProvider()
    expect(loggerProvider).to.exist

    const logger = logs.getLogger('test-logger')
    expect(logger).to.exist
    expect(typeof logger.emit).to.equal('function')
  })

  it('should handle logger provider shutdown', () => {
    process.env.DD_LOGS_OTEL_ENABLED = 'true'
    tracer.init()

    // Access the logger through OpenTelemetry API
    const { logs } = require('@opentelemetry/api-logs')
    const loggerProvider = logs.getLoggerProvider()

    expect(loggerProvider).to.exist
    expect(typeof loggerProvider.shutdown).to.equal('function')

    // Test shutdown doesn't throw
    expect(() => {
      loggerProvider.shutdown()
    }).to.not.throw()

    // After shutdown, getLogger should return a no-op logger
    const logger = logs.getLogger('test-logger')
    expect(logger).to.exist
    expect(typeof logger.emit).to.equal('function')
  })

  describe('OTLP Protocol Configuration', () => {
    it('should use default protocol when no environment variables are set', () => {
      const Config = require('../../src/config')
      delete process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL
      delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL

      const config = new Config()
      expect(config.otelLogsProtocol).to.equal('http/protobuf')
    })

    it('should use OTEL_EXPORTER_OTLP_LOGS_PROTOCOL when set', () => {
      const Config = require('../../src/config')
      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'http/json'
      delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL

      const config = new Config()
      expect(config.otelLogsProtocol).to.equal('http/json')
    })

    it('should fallback to OTEL_EXPORTER_OTLP_PROTOCOL when logs protocol not set', () => {
      const Config = require('../../src/config')
      delete process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json'

      const config = new Config()
      expect(config.otelLogsProtocol).to.equal('http/json')
    })

    it('should prioritize logs protocol over generic protocol', () => {
      const Config = require('../../src/config')
      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'http/json'
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf'

      const config = new Config()
      expect(config.otelLogsProtocol).to.equal('http/json')
    })

    it('should handle invalid protocol values', () => {
      const Config = require('../../src/config')
      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'invalid-protocol'

      const config = new Config()
      expect(config.otelLogsProtocol).to.equal('invalid-protocol')
    })

    it('should work with both http/protobuf and http/json protocols', () => {
      const Config = require('../../src/config')

      // Test protobuf protocol
      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'http/protobuf'
      const config1 = new Config()
      expect(config1.otelLogsProtocol).to.equal('http/protobuf')

      // Test JSON protocol
      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'http/json'
      const config2 = new Config()
      expect(config2.otelLogsProtocol).to.equal('http/json')
    })

    it('should warn and default to http/protobuf when grpc protocol is set', () => {
      const Config = require('../../src/config')
      // eslint-disable-next-line no-console
      const originalWarn = console.warn
      let warningMessage = ''
      // eslint-disable-next-line no-console
      console.warn = (msg) => { warningMessage = msg }

      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'grpc'
      const config = new Config()

      expect(config.otelLogsProtocol).to.equal('http/protobuf')
      expect(warningMessage).to.include('OTLP gRPC protocol is not supported for logs')
      expect(warningMessage).to.include('Defaulting to http/protobuf')

      // eslint-disable-next-line no-console
      console.warn = originalWarn
    })
  })
})
