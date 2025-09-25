'use strict'

const assert = require('assert')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')

describe('OpenTelemetry Logs', () => {
  let originalEnv

  function setupTracer (enabled = true) {
    process.env.DD_LOGS_OTEL_ENABLED = enabled ? 'true' : 'false'
    process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = '1'
    const tracer = require('../../')
    tracer._initialized = false
    tracer.init()
    const { logs } = require('@opentelemetry/api-logs')
    return { logs, loggerProvider: logs.getLoggerProvider() }
  }

  function mockOtlpExport (validator, protocol = 'protobuf') {
    const OtlpHttpLogExporter = require('../../src/opentelemetry/logs/otlp_http_log_exporter')
    sinon.stub(OtlpHttpLogExporter.prototype, '_sendPayload').callsFake((payload, callback) => {
      try {
        const decoded = protocol === 'json'
          ? JSON.parse(payload.toString())
          : require('../../src/opentelemetry/logs/protobuf_loader').getProtobufTypes()._logsService.decode(payload)
        validator(decoded)
        callback({ code: 0 })
      } catch (error) {
        callback({ code: 1, error })
      }
    })
  }

  function mockLogWarn () {
    const log = require('../../src/log')
    const originalWarn = log.warn
    let warningMessage = ''
    log.warn = (msg) => { warningMessage = msg }
    return { restore: () => { log.warn = originalWarn }, getMessage: () => warningMessage }
  }

  function createMockSpan (traceId = '1234567890abcdef1234567890abcdef', spanId = '1234567890abcdef') {
    return { spanContext: () => ({ traceId, spanId, traceFlags: 1, isRemote: false }) }
  }

  beforeEach(() => {
    originalEnv = { ...process.env }
  })

  afterEach(() => {
    process.env = originalEnv
    require('@opentelemetry/api-logs').logs.disable()
    sinon.restore()
  })

  describe('Core Functionality', () => {
    it('exports logs with complete OTLP structure and trace correlation', () => {
      mockOtlpExport((decoded) => {
        const { resource } = decoded.resourceLogs[0]
        const resourceAttrs = {}
        resource.attributes.forEach(attr => { resourceAttrs[attr.key] = attr.value.stringValue })
        assert(resourceAttrs['service.name'])

        const { scope, logRecords } = decoded.resourceLogs[0].scopeLogs[0]
        assert.strictEqual(scope.name, 'test-logger')

        const log = logRecords[0]
        assert.strictEqual(log.severityText, 'INFO')
        assert.strictEqual(log.body.stringValue, 'Test message')
        assert.strictEqual(log.traceId.toString('hex'), '1234567890abcdef1234567890abcdef')
        assert.strictEqual(log.spanId.toString('hex'), '1234567890abcdef')
      })

      const { logs } = setupTracer()
      const { trace, context } = require('@opentelemetry/api')

      logs.getLogger('test-logger').emit({
        severityText: 'INFO',
        body: 'Test message',
        context: trace.setSpan(context.active(), createMockSpan()),
        attributes: { 'test.key': 'test.value' }
      })
    })

    it('exports logs using protobuf protocol', () => {
      mockOtlpExport((decoded) => {
        assert.strictEqual(decoded.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue, 'Protobuf format')
      })

      const { logs } = setupTracer()
      logs.getLogger('test').emit({ severityText: 'INFO', body: 'Protobuf format' })
    })

    it('exports logs using JSON protocol', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'http/json'
      mockOtlpExport((decoded) => {
        assert.strictEqual(decoded.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue, 'JSON format')
      }, 'json')

      const { logs } = setupTracer()
      logs.getLogger('test').emit({ severityText: 'DEBUG', body: 'JSON format' })
    })

    it('handles shutdown gracefully', () => {
      const { loggerProvider } = setupTracer()
      loggerProvider.shutdown()
      assert.strictEqual(loggerProvider._isShutdown, true)
    })
  })

  describe('Configuration', () => {
    it('uses default protobuf protocol when no environment variables set', () => {
      delete process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL
      delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL
      const { loggerProvider } = setupTracer()
      assert.strictEqual(loggerProvider._processor._exporter._transformer._protocol, 'http/protobuf')
    })

    it('prioritizes logs-specific protocol over generic protocol', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'http/json'
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf'
      const { loggerProvider } = setupTracer()
      assert.strictEqual(loggerProvider._processor._exporter._transformer._protocol, 'http/json')
    })

    it('warns and falls back to protobuf when gRPC protocol is set', () => {
      const logMock = mockLogWarn()
      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'grpc'

      const { loggerProvider } = setupTracer()
      assert.strictEqual(loggerProvider._processor._exporter._transformer._protocol, 'http/protobuf')
      assert(logMock.getMessage().includes('OTLP gRPC protocol is not supported'))

      logMock.restore()
    })

    it('configures resource attributes from environment variables', () => {
      process.env.DD_TAGS = 'team:backend,region:us-west-2'
      process.env.OTEL_RESOURCE_ATTRIBUTES = 'service.namespace=api'
      const { loggerProvider } = setupTracer()
      const resourceAttrs = loggerProvider.resource.attributes
      assert.strictEqual(resourceAttrs.team, 'backend')
      assert.strictEqual(resourceAttrs['service.namespace'], 'api')
    })

    it('includes hostname in resource when reportHostname is enabled', () => {
      process.env.DD_TRACE_REPORT_HOSTNAME = 'true'
      const { loggerProvider } = setupTracer()
      assert(typeof loggerProvider.resource.attributes['host.name'] === 'string')
    })

    it('configures custom OTLP endpoint', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://custom:4318/v1/logs'
      const { loggerProvider } = setupTracer()
      assert.strictEqual(loggerProvider._processor._exporter._url, 'http://custom:4318/v1/logs')
    })

    it('configures OTLP headers from logs-specific environment variable', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'api-key=secret,env=prod'
      const { loggerProvider } = setupTracer()
      const exporter = loggerProvider._processor._exporter
      assert.strictEqual(exporter._headers['api-key'], 'secret')
      assert.strictEqual(exporter._headers.env, 'prod')
    })

    it('prioritizes logs-specific headers over generic OTLP headers', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'generic=value,shared=generic'
      process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'logs-specific=value,shared=logs'
      const { loggerProvider } = setupTracer()
      const exporter = loggerProvider._processor._exporter
      assert.strictEqual(exporter._headers['logs-specific'], 'value')
      assert.strictEqual(exporter._headers.shared, 'logs')
      assert.strictEqual(exporter._headers.generic, undefined)
    })
  })

  describe('Telemetry Metrics', () => {
    it('tracks telemetry metrics for exported logs', () => {
      require('../setup/core')
      const telemetryMetrics = {
        manager: { namespace: sinon.stub().returns({ count: sinon.stub().returns({ inc: sinon.spy() }) }) }
      }
      const MockedExporter = proxyquire('../../src/opentelemetry/logs/otlp_http_log_exporter', {
        '../../telemetry/metrics': telemetryMetrics
      })

      const exporter = new MockedExporter('http://localhost:4318/v1/logs', '', 1000, 'http/protobuf', {})
      exporter.export([{ body: 'test', severityNumber: 9, timestamp: Date.now() * 1000000 }], () => {})

      assert(telemetryMetrics.manager.namespace().count().inc.calledWith(1))
    })
  })
})
