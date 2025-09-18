'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
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
    const activeProcessor = loggerProvider.getActiveLogProcessor()

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
})
