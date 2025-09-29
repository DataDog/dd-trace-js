'use strict'

// Increase max listeners to avoid warnings in tests
process.setMaxListeners(50)

const assert = require('assert')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')
require('../setup/core')
const { _logsService } = require('../../src/opentelemetry/logs/protobuf_loader').getProtobufTypes()

describe('OpenTelemetry Logs', () => {
  let originalEnv

  function setupTracer (enabled = true, maxExportBatchSize = '1') {
    process.env.DD_LOGS_OTEL_ENABLED = enabled ? 'true' : 'false'
    process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = maxExportBatchSize // Force immediate export
    const tracer = require('../../')
    tracer._initialized = false
    tracer.init()
    const { logs } = require('@opentelemetry/api-logs')
    return { logs, loggerProvider: logs.getLoggerProvider() }
  }

  function mockOtlpExport (validator, protocol = 'protobuf') {
    const http = require('http')
    let capturedPayload, capturedHeaders
    let validatorCalled = false

    sinon.stub(http, 'request').callsFake((options, callback) => {
      capturedHeaders = options.headers
      const mockReq = {
        write: (data) => { capturedPayload = data },
        end: () => {
          const decoded = protocol === 'json'
            ? JSON.parse(capturedPayload.toString())
            : _logsService.decode(capturedPayload)
          validator(decoded, capturedHeaders)
          validatorCalled = true
        },
        on: () => {}
      }
      callback({ statusCode: 200, on: () => {} })
      return mockReq
    })

    // Return function to check if validator was called
    return () => {
      if (!validatorCalled) {
        throw new Error('OTLP export validator was never called - batch may not have flushed')
      }
    }
  }

  function mockLogWarn () {
    const log = require('../../src/log')
    const originalWarn = log.warn
    let warningMessage = ''
    log.warn = (msg) => { warningMessage = msg }
    return { restore: () => { log.warn = originalWarn }, getMessage: () => warningMessage }
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
      mockOtlpExport((decoded, capturedHeaders) => {
        const { resource } = decoded.resourceLogs[0]
        const resourceAttrs = {}
        resource.attributes.forEach(attr => { resourceAttrs[attr.key] = attr.value.stringValue })
        assert(resourceAttrs['service.name'])

        // Validate we have 2 separate scope logs (one per instrumentation library)
        const { scopeLogs } = decoded.resourceLogs[0]
        assert.strictEqual(scopeLogs.length, 1)

        const scope = scopeLogs[0]
        assert.strictEqual(scope.scope.name, 'test-logger')
        assert.strictEqual(scope.scope.version, '1.0.0')
        assert.strictEqual(scope.schemaUrl, 'https://opentelemetry.io/schemas/1.27.0')
        assert.strictEqual(scope.logRecords.length, 2)

        const log1 = scope.logRecords[0]
        assert.strictEqual(log1.severityText, 'INFO')
        assert.strictEqual(log1.body.stringValue, 'Test message')
        assert.strictEqual(log1.traceId.toString('hex'), '1234567890abcdef1234567890abcdef')
        assert.strictEqual(log1.spanId.toString('hex'), '1234567890abcdef')

        const log2 = scope.logRecords[1]
        assert.strictEqual(log2.severityText, 'ERROR')
        assert.strictEqual(log2.severityNumber, 17)
        assert.strictEqual(log2.body.stringValue, 'Test error message')
        assert.strictEqual(log2.traceId.toString('hex'), '1234567890abcdef1234567890abcdef')
        assert.strictEqual(log2.spanId.toString('hex'), '1234567890abcdef')
      })
      const { logs } = setupTracer(true, '2')
      const { trace, context } = require('@opentelemetry/api')

      const spanContext = {
        traceId: '1234567890abcdef1234567890abcdef',
        spanId: '1234567890abcdef',
        traceFlags: 1,
      }
      context.with(trace.setSpan(context.active(), trace.wrapSpanContext(spanContext)), () => {
        const logger = logs.getLogger('test-logger', '1.0.0', { schemaUrl: 'https://opentelemetry.io/schemas/1.27.0' })

        logger.emit({
          severityText: 'INFO',
          body: 'Test message',
          attributes: { 'test.key': 'test.value' }
        })
        logger.emit({
          severityText: 'ERROR',
          severityNumber: 17,
          instrumentationScope: { name: 'test-logger', version: '1.0.0' },
          body: 'Test error message',
          attributes: { 'error.array': [1, 2, 3] }
        })
      })
    })

    it('exports logs using protobuf protocol', () => {
      mockOtlpExport((decoded, capturedHeaders) => {
        assert.strictEqual(decoded.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue, 'Protobuf format')
      })

      const { logs } = setupTracer()
      logs.getLogger('test').emit({ severityText: 'INFO', body: 'Protobuf format' })
    })

    it('exports logs using JSON protocol', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'http/json'
      mockOtlpExport((decoded, capturedHeaders) => {
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
      mockOtlpExport((decoded, capturedHeaders) => {
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
      process.env.DD_TRACE_OTEL_ENABLED = 'true'

      mockOtlpExport((decoded, capturedHeaders) => {
        // Validate payload body
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
              schemaUrl: '',
              logRecords: [{
                body: { stringValue: 'HTTP test message' },
                severityText: 'ERROR',
                severityNumber: 'SEVERITY_NUMBER_ERROR',
                attributes: [{ key: 'test.attr', value: { stringValue: 'value' } }],
                timeUnixNano: actual.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano,
                observedTimeUnixNano: actual.resourceLogs[0].scopeLogs[0].logRecords[0].observedTimeUnixNano,
                flags: 1,
                traceId: 'AAAAAAAAAAAAAAAAAAAAAQ==',
                spanId: 'AAAAAAAAAAI='
              }]
            }]
          }]
        }

        assert.deepStrictEqual(actual, expected)

        // Validate key headers (ignore dynamic Content-Length)
        assert.strictEqual(capturedHeaders['Content-Type'], 'application/x-protobuf')
        assert.strictEqual(capturedHeaders['x-api-key'], 'test123')
      })

      const { logs } = setupTracer()
      const { trace, context } = require('@opentelemetry/api')

      const spanContext = {
        traceId: '00000000000000000000000000000001',
        spanId: '0000000000000002',
        traceFlags: 1,
      }
      logs.getLogger('test-service', '1.0.0').emit({
        observedTimestamp: Date.now() * 1000000,
        severityText: 'ERROR',
        severityNumber: 17,
        body: 'HTTP test message',
        attributes: { 'test.attr': 'value' },
        context: trace.setSpan(context.active(), trace.wrapSpanContext(spanContext))
      })
    })

    it('groups logs by instrumentation library in separate scope payloads', () => {
      mockOtlpExport((decoded, capturedHeaders) => {
        const { resourceLogs } = decoded
        assert.strictEqual(resourceLogs.length, 1)

        const { scopeLogs } = resourceLogs[0]
        assert.strictEqual(scopeLogs.length, 2) // Should have 2 separate scope logs

        // First scope: logger1@1.0.0
        const scope1 = scopeLogs[0]
        assert.strictEqual(scope1.scope.name, 'logger1')
        assert.strictEqual(scope1.scope.version, '1.0.0')
        assert.strictEqual(scope1.logRecords.length, 1)
        assert.strictEqual(scope1.logRecords[0].severityText, 'INFO')
        assert.strictEqual(scope1.logRecords[0].body.stringValue, 'Message from logger1')

        // Second scope: logger2@2.0.0
        const scope2 = scopeLogs[1]
        assert.strictEqual(scope2.scope.name, 'logger2')
        assert.strictEqual(scope2.scope.version, '2.0.0')
        assert.strictEqual(scope2.logRecords.length, 1)
        assert.strictEqual(scope2.logRecords[0].severityText, 'ERROR')
        assert.strictEqual(scope2.logRecords[0].body.stringValue, 'Message from logger2')
      })

      const { logs } = setupTracer(true, '2')
      const { trace, context } = require('@opentelemetry/api')

      const spanContext = {
        traceId: '1234567890abcdef1234567890abcdef',
        spanId: '1234567890abcdef',
        traceFlags: 1,
      }
      context.with(trace.setSpan(context.active(), trace.wrapSpanContext(spanContext)), () => {
        const logger1 = logs.getLogger('logger1', '1.0.0')
        const logger2 = logs.getLogger('logger2', '2.0.0')

        logger1.emit({
          severityText: 'INFO',
          body: 'Message from logger1',
          attributes: { logger: 'logger1' }
        })

        logger2.emit({
          severityText: 'ERROR',
          body: 'Message from logger2',
          attributes: { logger: 'logger2' }
        })
      })
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

    it('configures protocol from environment variable', () => {
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json'
      const { loggerProvider } = setupTracer()
      assert.strictEqual(loggerProvider.processor.exporter.transformer.protocol, 'http/json')
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

    it('configures OTLP endpoint from environment variable', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://custom:4318/v1/logs'
      const { loggerProvider } = setupTracer()
      assert.strictEqual(loggerProvider.processor.exporter.url, 'http://custom:4318/v1/logs')
    })

    it('prioritizes logs-specific endpoint over generic endpoint', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://custom:4318/v1/logs'
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://generic:4318/v1/logs'
      const { loggerProvider } = setupTracer()
      assert.strictEqual(loggerProvider.processor.exporter.url, 'http://custom:4318/v1/logs')
    })

    it('configures OTLP headers from environment variable', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'api-key=secret,env=prod'
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

    it('configures OTLP timeout from environment variable', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_TIMEOUT = '1000'
      const { loggerProvider } = setupTracer()
      assert.strictEqual(loggerProvider.processor.exporter.timeout, 1000)
    })

    it('prioritizes logs-specific timeout over generic timeout', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_TIMEOUT = '1000'
      process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '2000'
      const { loggerProvider } = setupTracer()
      assert.strictEqual(loggerProvider.processor.exporter.timeout, 1000)
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
