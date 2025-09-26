'use strict'

// Increase max listeners to avoid warnings in tests
process.setMaxListeners(50)

const assert = require('assert')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')
require('../setup/core')

describe('OpenTelemetry Logs', () => {
  let originalEnv

  function setupTracer (enabled = true) {
    process.env.DD_LOGS_OTEL_ENABLED = enabled ? 'true' : 'false'
    const tracer = require('../../')
    tracer._initialized = false
    tracer.init()
    const { logs } = require('@opentelemetry/api-logs')
    return { logs, loggerProvider: logs.getLoggerProvider() }
  }

  function mockOtlpExport (validator, protocol = 'protobuf') {
    const OtlpHttpLogExporter = require('../../src/opentelemetry/logs/otlp_http_log_exporter')
    const { _logsService } = require('../../src/opentelemetry/logs/protobuf_loader').getProtobufTypes()
    sinon.stub(OtlpHttpLogExporter.prototype, '_sendPayload').callsFake((payload, callback) => {
      try {
        const decoded = protocol === 'json'
          ? JSON.parse(payload.toString())
          : _logsService.decode(payload)
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
    it('exports logs with complete OTLP structure, trace correlation, and instrumentation info', () => {
      mockOtlpExport((decoded) => {
        const { resource } = decoded.resourceLogs[0]
        const resourceAttrs = {}
        resource.attributes.forEach(attr => { resourceAttrs[attr.key] = attr.value.stringValue })
        assert(resourceAttrs['service.name'])

        const { scope, logRecords } = decoded.resourceLogs[0].scopeLogs[0]
        assert.strictEqual(scope.name, 'test-logger')
        assert.strictEqual(scope.version, '1.0.0')

        const log = logRecords[0]
        assert.strictEqual(log.severityText, 'INFO')
        assert.strictEqual(log.body.stringValue, 'Test message')
        assert.strictEqual(log.traceId.toString('hex'), '1234567890abcdef1234567890abcdef')
        assert.strictEqual(log.spanId.toString('hex'), '1234567890abcdef')
      })

      const { logs } = setupTracer()
      const { trace, context } = require('@opentelemetry/api')

      logs.getLogger('test-logger', '1.0.0').emit({
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
      assert.strictEqual(loggerProvider.isShutdown, true)
    })

    it('supports instrumentationScope for compatibility', () => {
      mockOtlpExport((decoded) => {
        const log = decoded.resourceLogs[0].scopeLogs[0].logRecords[0]
        assert.strictEqual(log.body.stringValue, 'Scope test')
      })

      const { logs } = setupTracer()
      logs.getLogger('test-logger').emit({
        body: 'Scope test',
        instrumentationScope: { name: 'custom-scope', version: '2.0.0' }
      })
    })

    it('sends payload with expected format', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'x-api-key=test123'
      process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = '1'
      process.env.DD_SERVICE = 'test-service'
      process.env.DD_VERSION = 'testversion'
      process.env.DD_ENV = 'testenv'
      process.env.DD_TAGS = 'testtag:testvalue'

      const http = require('http')
      let capturedPayload, capturedHeaders

      sinon.stub(http, 'request').callsFake((options, callback) => {
        capturedHeaders = options.headers
        const mockReq = {
          write: (data) => { capturedPayload = data },
          end: () => {},
          on: () => {}
        }
        callback({ statusCode: 200, on: () => {} })
        return mockReq
      })

      const { logs } = setupTracer()
      const { trace, context } = require('@opentelemetry/api')

      logs.getLogger('test-service', '1.0.0').emit({
        severityText: 'ERROR',
        severityNumber: 17,
        body: 'HTTP test message',
        attributes: { 'test.attr': 'value' },
        context: trace.setSpan(context.active(), createMockSpan()),
      })

      // Validate complete OTLP payload structure as JSON
      const { getProtobufTypes } = require('../../src/opentelemetry/logs/protobuf_loader')
      const { _logsService } = getProtobufTypes()
      const decoded = _logsService.decode(capturedPayload)
      const actual = JSON.parse(JSON.stringify(decoded.toJSON()))

      const attrs = actual.resourceLogs[0].resource.attributes
      const runtimeId = attrs.find(a => a.key === 'runtime-id').value.stringValue
      const clientId = attrs.find(a => a.key === '_dd.rc.client_id').value.stringValue

      const expected = {
        resourceLogs: [{
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'test-service' } },
              { key: 'service.version', value: { stringValue: 'testversion' } },
              { key: 'deployment.environment', value: { stringValue: 'testenv' } },
              { key: 'testtag', value: { stringValue: 'testvalue' } },
              { key: 'runtime-id', value: { stringValue: runtimeId } },
              { key: '_dd.rc.client_id', value: { stringValue: clientId } }
            ],
            droppedAttributesCount: 0
          },
          scopeLogs: [{
            scope: {
              name: 'test-service',
              version: '1.0.0',
              droppedAttributesCount: 0
            },
            logRecords: [{
              body: { stringValue: 'HTTP test message' },
              severityText: 'ERROR',
              severityNumber: 'SEVERITY_NUMBER_ERROR',
              attributes: [{ key: 'test.attr', value: { stringValue: 'value' } }],
              timeUnixNano: actual.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano,
              observedTimeUnixNano: actual.resourceLogs[0].scopeLogs[0].logRecords[0].observedTimeUnixNano,
              flags: 0,
              spanId: Buffer.from('1234567890abcdef', 'hex').toString('base64'),
              traceId: Buffer.from('1234567890abcdef1234567890abcdef', 'hex').toString('base64')
            }]
          }]
        }]
      }

      assert.deepStrictEqual(actual, expected)
      // Validate complete headers structure
      const expectedHeaders = {
        'Content-Length': capturedHeaders['Content-Length'],
        'Content-Type': 'application/x-protobuf',
        'x-api-key': 'test123'
      }
      assert.deepStrictEqual(capturedHeaders, expectedHeaders)
    })
  })

  describe('Configurations', () => {
    it('uses default protobuf protocol', () => {
      delete process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL
      delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL
      const { loggerProvider } = setupTracer()
      assert(loggerProvider.processor)
      assert.strictEqual(loggerProvider.processor.exporter.transformer.protocol, 'http/protobuf')
    })

    it('prioritizes logs-specific protocol over generic protocol', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'http/json'
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf'
      const { loggerProvider } = setupTracer()
      assert.strictEqual(loggerProvider.processor.exporter.transformer.protocol, 'http/json')
    })

    it('warns and falls back to protobuf when gRPC protocol is set', () => {
      const logMock = mockLogWarn()
      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'grpc'

      const { loggerProvider } = setupTracer()
      assert.strictEqual(loggerProvider.processor.exporter.transformer.protocol, 'http/protobuf')
      assert(logMock.getMessage().includes('OTLP gRPC protocol is not supported'))

      logMock.restore()
    })

    it('configures custom OTLP endpoint', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://custom:4318/v1/logs'
      const { loggerProvider } = setupTracer()
      assert.strictEqual(loggerProvider.processor.exporter.url, 'http://custom:4318/v1/logs')
    })

    it('configures OTLP headers from logs-specific environment variable', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'api-key=secret,env=prod'
      const { loggerProvider } = setupTracer()
      const exporter = loggerProvider.processor.exporter
      assert.strictEqual(exporter.headers['api-key'], 'secret')
      assert.strictEqual(exporter.headers.env, 'prod')
    })

    it('prioritizes logs-specific headers over generic OTLP headers', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'generic=value,shared=generic'
      process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'logs-specific=value,shared=logs'
      const { loggerProvider } = setupTracer()
      const exporter = loggerProvider.processor.exporter
      assert.strictEqual(exporter.headers['logs-specific'], 'value')
      assert.strictEqual(exporter.headers.shared, 'logs')
      assert.strictEqual(exporter.headers.generic, undefined)
    })
  })

  describe('Telemetry Metrics', () => {
    it('tracks telemetry metrics for exported logs', () => {
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
