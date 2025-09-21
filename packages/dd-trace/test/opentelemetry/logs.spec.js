'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('tap').mocha

describe('OpenTelemetry Logs', () => {
  let originalEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
  })

  afterEach(() => {
    process.env = originalEnv
    // Clean up OpenTelemetry API state by shutting down the current logger provider
    const { logs } = require('@opentelemetry/api-logs')
    const loggerProvider = logs.getLoggerProvider()
    if (loggerProvider && typeof loggerProvider.shutdown === 'function') {
      loggerProvider.shutdown()
    }
  })

  it('should initialize OpenTelemetry logs when otelLogsEnabled is true', () => {
    process.env.DD_LOGS_OTEL_ENABLED = 'true'
    const tracer = require('../../')
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

    const tracer = require('../../')
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
    const tracer = require('../../')
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
    const tracer = require('../../')
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
    const tracer = require('../../')
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

    const tracer = require('../../')
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
    const tracer = require('../../')
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

  describe('Resource Attributes', () => {
    it('should set resource attributes from DD_TAGS', () => {
      const Config = require('../../src/config')
      process.env.DD_LOGS_OTEL_ENABLED = 'true'
      process.env.DD_TAGS = 'team:backend,region:us-west-2'

      const config = new Config()

      expect(config.tags).to.include({
        team: 'backend',
        region: 'us-west-2'
      })
    })

    it('should set resource attributes from OTEL_RESOURCE_ATTRIBUTES', () => {
      const Config = require('../../src/config')
      process.env.DD_LOGS_OTEL_ENABLED = 'true'
      process.env.OTEL_RESOURCE_ATTRIBUTES = 'deployment.environment=production,service.namespace=api'
      // Override DD_ENV to avoid conflict
      process.env.DD_ENV = 'production'

      const config = new Config()

      // Check that service.namespace is in tags (from OTEL_RESOURCE_ATTRIBUTES)
      expect(config.tags).to.include({
        'service.namespace': 'api'
      })

      // Check that env is set correctly (which maps to deployment.environment in proxy.js)
      expect(config.env).to.equal('production')
    })

    it('should set hostname when reportHostname is enabled', () => {
      const Config = require('../../src/config')
      process.env.DD_LOGS_OTEL_ENABLED = 'true'
      process.env.DD_TRACE_REPORT_HOSTNAME = 'true'

      const config = new Config()

      expect(config.hostname).to.exist
      expect(config.hostname).to.be.a('string')
    })
  })

  describe('OTLP Payload Structure', () => {
    const { OtlpTransformer } = require('../../src/opentelemetry/logs')
    const { getProtobufTypes } = require('../../src/opentelemetry/logs/protobuf_loader')

    const testData = {
      resource: {
        attributes: {
          'service.name': 'test-service',
          'service.version': '1.0.0',
          'deployment.environment': 'test',
          team: 'backend',
          region: 'us-west-2'
        }
      },
      logRecords: [{
        body: 'Test message',
        severityNumber: 9,
        severityText: 'INFO',
        attributes: { 'test.attr': 'test-value' }
      }]
    }

    // Shared verification function
    const verifyPayload = (payload) => {
      expect(payload).to.have.property('resourceLogs')
      expect(payload.resourceLogs[0]).to.have.property('resource')
      expect(payload.resourceLogs[0]).to.have.property('scopeLogs')

      const resource = payload.resourceLogs[0].resource
      expect(resource).to.have.property('attributes')
      expect(resource).to.have.property('droppedAttributesCount', 0)

      const resourceAttrs = resource.attributes.reduce((acc, attr) => {
        acc[attr.key] = attr.value.stringValue
        return acc
      }, {})
      expect(resourceAttrs).to.include({
        'service.name': 'test-service',
        'service.version': '1.0.0',
        'deployment.environment': 'test',
        team: 'backend',
        region: 'us-west-2'
      })

      const scope = payload.resourceLogs[0].scopeLogs[0].scope
      expect(scope).to.have.property('name', 'dd-trace-js')
      expect(scope).to.have.property('version', '1.0.0')
      expect(scope).to.have.property('droppedAttributesCount', 0)

      const logRecord = payload.resourceLogs[0].scopeLogs[0].logRecords[0]
      expect(logRecord).to.have.property('body')
      expect(logRecord.body).to.have.property('stringValue', 'Test message')
      expect(logRecord).to.have.property('severityNumber', 9)
      expect(logRecord).to.have.property('severityText', 'INFO')
      // droppedAttributesCount may not be present in decoded protobuf
      if (logRecord.droppedAttributesCount !== undefined) {
        expect(logRecord.droppedAttributesCount).to.equal(0)
      }

      const logAttrs = logRecord.attributes.reduce((acc, attr) => {
        acc[attr.key] = attr.value.stringValue
        return acc
      }, {})
      expect(logAttrs).to.include({ 'test.attr': 'test-value' })
    }

    it('should generate correct JSON payload structure', () => {
      const transformer = new OtlpTransformer({ protocol: 'http/json', ...testData })
      const result = JSON.parse(transformer.transformLogRecords(testData.logRecords).toString())
      verifyPayload(result)
    })

    it('should generate correct protobuf payload structure', () => {
      const transformer = new OtlpTransformer({ protocol: 'http/protobuf', ...testData })
      const result = getProtobufTypes()._logsService.decode(transformer.transformLogRecords(testData.logRecords))
      verifyPayload(result)
    })
  })
})
