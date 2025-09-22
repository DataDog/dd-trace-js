'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')

// Helper function to create mocked telemetry metrics
function createMockedTelemetryMetrics () {
  return {
    manager: {
      namespace: sinon.stub().returns({
        count: sinon.stub().returns({
          inc: sinon.spy()
        })
      })
    }
  }
}

// Helper function to create OTLP HTTP log exporter with mocked telemetry metrics
function createMockedOtlpHttpLogExporter (telemetryMetrics) {
  return proxyquire('../../src/opentelemetry/logs/otlp_http_log_exporter', {
    '../../telemetry/metrics': telemetryMetrics
  })
}

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

  describe('Basic Functionality', () => {
    // Helper function to setup tracer and get logger
    function setupTracerAndLogger (enabled = true) {
      process.env.DD_LOGS_OTEL_ENABLED = enabled ? 'true' : 'false'
      const tracer = require('../../')
      tracer.init()
      const { logs } = require('@opentelemetry/api-logs')
      return { tracer, logs, loggerProvider: logs.getLoggerProvider(), logger: logs.getLogger('test-logger') }
    }

    it('should initialize OpenTelemetry logs when enabled', () => {
      const { loggerProvider, logger } = setupTracerAndLogger(true)

      expect(loggerProvider).to.exist
      expect(logger).to.exist
      expect(typeof logger.emit).to.equal('function')
      expect(typeof logger.info).to.equal('function')
    })

    it('should emit log records without errors', () => {
      const { logger } = setupTracerAndLogger(true)

      expect(() => {
        logger.emit({
          severityText: 'INFO',
          severityNumber: 9,
          body: 'Test message',
          timestamp: Date.now() * 1000000
        })
      }).to.not.throw()
    })

    it('should handle logger provider shutdown', () => {
      const { loggerProvider } = setupTracerAndLogger(true)

      expect(() => {
        loggerProvider.shutdown()
      }).to.not.throw()
    })

    it('should work when disabled', () => {
      const { logger } = setupTracerAndLogger(false)

      expect(() => {
        logger.emit({
          severityText: 'INFO',
          severityNumber: 9,
          body: 'Test message'
        })
      }).to.not.throw()
    })
  })

  describe('Protocol Configuration', () => {
    // Helper function to test protocol configuration
    function testProtocolConfig (envVars, expectedProtocol, expectedWarning = null) {
      const Config = require('../../src/config')

      // Setup environment variables
      Object.entries(envVars).forEach(([key, value]) => {
        if (value === null) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      })

      let warningMessage = ''
      if (expectedWarning) {
        // eslint-disable-next-line no-console
        const originalWarn = console.warn
        // eslint-disable-next-line no-console
        console.warn = (msg) => { warningMessage = msg }

        const config = new Config()
        expect(config.otelLogsProtocol).to.equal(expectedProtocol)
        expect(warningMessage).to.include(expectedWarning)

        // eslint-disable-next-line no-console
        console.warn = originalWarn
      } else {
        const config = new Config()
        expect(config.otelLogsProtocol).to.equal(expectedProtocol)
      }
    }

    it('should use default protocol when no environment variables are set', () => {
      testProtocolConfig({
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: null,
        OTEL_EXPORTER_OTLP_PROTOCOL: null
      }, 'http/protobuf')
    })

    it('should prioritize logs-specific protocol over generic protocol', () => {
      testProtocolConfig({
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf'
      }, 'http/json')
    })

    it('should fallback to generic protocol when logs protocol not set', () => {
      testProtocolConfig({
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: null,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json'
      }, 'http/json')
    })

    it('should warn and default to http/protobuf when grpc protocol is set', () => {
      testProtocolConfig({
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'grpc'
      }, 'http/protobuf', 'OTLP gRPC protocol is not supported for logs')
    })
  })

  describe('Resource Attributes', () => {
    // Helper function to test resource attribute configuration
    function testResourceConfig (envVars, assertions) {
      const Config = require('../../src/config')

      // Setup environment variables
      Object.entries(envVars).forEach(([key, value]) => {
        if (value === null) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      })

      const config = new Config()
      assertions(config)
    }

    it('should parse DD_TAGS into resource attributes', () => {
      testResourceConfig({
        DD_LOGS_OTEL_ENABLED: 'true',
        DD_TAGS: 'team:backend,region:us-west-2'
      }, (config) => {
        expect(config.tags).to.include({
          team: 'backend',
          region: 'us-west-2'
        })
      })
    })

    it('should parse OTEL_RESOURCE_ATTRIBUTES into resource attributes', () => {
      testResourceConfig({
        DD_LOGS_OTEL_ENABLED: 'true',
        OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=production,service.namespace=api',
        DD_ENV: 'production'
      }, (config) => {
        expect(config.tags).to.include({
          'service.namespace': 'api'
        })
        expect(config.env).to.equal('production')
      })
    })

    it('should set hostname when reportHostname is enabled', () => {
      testResourceConfig({
        DD_LOGS_OTEL_ENABLED: 'true',
        DD_TRACE_REPORT_HOSTNAME: 'true'
      }, (config) => {
        expect(config.hostname).to.exist
        expect(config.hostname).to.be.a('string')
        expect(config.hostname.length).to.be.greaterThan(0)
      })
    })
  })

  describe('Telemetry Metrics', () => {
    // Helper function to test telemetry metrics for a given protocol
    function testTelemetryMetricsForProtocol (protocol, expectedEncoding) {
      require('../setup/core') // For sinon-chai

      const telemetryMetrics = createMockedTelemetryMetrics()
      const OtlpHttpLogExporter = createMockedOtlpHttpLogExporter(telemetryMetrics)

      const exporter = new OtlpHttpLogExporter({ protocol })
      const mockLogRecords = [{
        body: 'Test message',
        severityNumber: 9,
        severityText: 'INFO',
        timestamp: Date.now() * 1000000
      }]

      exporter.export(mockLogRecords, () => {})

      // Verify telemetry metric was called with correct name and tags
      expect(telemetryMetrics.manager.namespace).to.have.been.calledWith('tracers')
      expect(telemetryMetrics.manager.namespace().count).to.have.been.calledWith(
        'otel.log_records', [
          'protocol:http',
        `encoding:${expectedEncoding}`
        ])
      expect(telemetryMetrics.manager.namespace().count().inc).to.have.been.calledWith(1)
    }

    it('should track telemetry metrics for protobuf protocol', () => {
      testTelemetryMetricsForProtocol('http/protobuf', 'protobuf')
    })

    it('should track telemetry metrics for JSON protocol', () => {
      testTelemetryMetricsForProtocol('http/json', 'json')
    })
  })

  describe('OTLP Payload Structure', () => {
    // Common test data for payload structure tests
    const testData = {
      resource: {
        attributes: {
          'service.name': 'test-service',
          'service.version': '1.0.0',
          'deployment.environment': 'test'
        }
      },
      logRecords: [{
        body: 'Test message',
        severityNumber: 9,
        severityText: 'INFO',
        attributes: { 'test.attr': 'test-value' }
      }]
    }

    // Helper function to test payload structure
    function testPayloadStructure (protocol, expectedStructure) {
      const { OtlpTransformer } = require('../../src/opentelemetry/logs')
      const transformer = new OtlpTransformer({ protocol, ...testData })

      let result
      if (protocol === 'http/json') {
        result = JSON.parse(transformer.transformLogRecords(testData.logRecords).toString())
      } else {
        const { getProtobufTypes } = require('../../src/opentelemetry/logs/protobuf_loader')
        result = getProtobufTypes()._logsService.decode(transformer.transformLogRecords(testData.logRecords))
      }

      expectedStructure(result)
    }

    it('should generate correct JSON OTLP payload structure', () => {
      testPayloadStructure('http/json', (result) => {
        expect(result).to.have.property('resourceLogs')
        expect(result.resourceLogs[0]).to.have.property('resource')
        expect(result.resourceLogs[0]).to.have.property('scopeLogs')
      })
    })

    it('should generate correct protobuf OTLP payload structure', () => {
      testPayloadStructure('http/protobuf', (result) => {
        expect(result).to.have.property('resourceLogs')
        expect(result.resourceLogs[0]).to.have.property('resource')
        expect(result.resourceLogs[0]).to.have.property('scopeLogs')
      })
    })
  })

  describe('OTLP Endpoint Configuration', () => {
    it('should use environment value when set', () => {
      const Config = require('../../src/config')

      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://explicit-agent:4318/v1/logs'
      process.env.DD_AGENT_HOST = 'different-agent.example.com'

      const config = new Config()
      expect(config.otelLogsUrl).to.equal('http://explicit-agent:4318/v1/logs')
    })

    it('should use calculated default when no environment variables are set', () => {
      const Config = require('../../src/config')

      delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
      delete process.env.OTEL_EXPORTERS_OTLP_ENDPOINT
      process.env.DD_AGENT_HOST = 'default-agent.example.com'

      const config = new Config()
      expect(config.otelLogsUrl).to.equal('http://default-agent.example.com:4318/v1/logs')
    })

    it('should use fallback default when no environment variables and no DD_AGENT_HOST', () => {
      const Config = require('../../src/config')

      delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
      delete process.env.OTEL_EXPORTERS_OTLP_ENDPOINT
      delete process.env.DD_AGENT_HOST

      const config = new Config()
      expect(config.otelLogsUrl).to.equal('http://127.0.0.1:4318/v1/logs')
    })
  })

  describe('OTLP Headers Configuration', () => {
    it('should parse OTLP headers from comma-separated key=value string', () => {
      const { OtlpHttpLogExporter } = require('../../src/opentelemetry/logs')

      const exporter = new OtlpHttpLogExporter({
        url: 'http://localhost:4318/v1/logs',
        protocol: 'http/protobuf',
        timeout: 1000,
        otelLogsHeaders: 'api-key=key,other-config-value=value'
      })

      expect(exporter._headers).to.include({
        'api-key': 'key',
        'other-config-value': 'value'
      })
    })
  })
})
