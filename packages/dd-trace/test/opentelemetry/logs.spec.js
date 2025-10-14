'use strict'

// Increase max listeners to avoid warnings in tests
process.setMaxListeners(50)

require('../setup/core')
const assert = require('assert')
const os = require('os')
const http = require('http')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const { logs } = require('@opentelemetry/api-logs')
const { trace, context } = require('@opentelemetry/api')
const { protoLogsService } = require('../../src/opentelemetry/otlp/protobuf_loader').getProtobufTypes()

describe('OpenTelemetry Logs', () => {
  let originalEnv

  function setupTracer (enabled = true, maxExportBatchSize = '1') {
    process.env.DD_LOGS_OTEL_ENABLED = enabled ? 'true' : 'false'
    process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = maxExportBatchSize // Force immediate export
    const tracer = require('../../')
    tracer._initialized = false
    tracer.init()
    return { tracer, logs, loggerProvider: logs.getLoggerProvider() }
  }

  function mockOtlpExport (validator, protocol = 'protobuf') {
    let capturedPayload, capturedHeaders
    let validatorCalled = false

    sinon.stub(http, 'request').callsFake((options, callback) => {
      // Only intercept OTLP logs requests
      if (options.path && options.path.includes('/v1/logs')) {
        capturedHeaders = options.headers
        const mockReq = {
          write: (data) => { capturedPayload = data },
          end: () => {
            const decoded = protocol === 'json'
              ? JSON.parse(capturedPayload.toString())
              : protoLogsService.decode(capturedPayload)
            validator(decoded, capturedHeaders)
            validatorCalled = true
          },
          on: () => {},
          once: () => {},
          setTimeout: () => {}
        }
        callback({ statusCode: 200, on: () => {}, setTimeout: () => {} })
        return mockReq
      }

      // For other requests (remote config, etc), return a basic mock
      const mockReq = {
        write: () => {},
        end: () => {},
        on: () => {},
        once: () => {},
        setTimeout: () => {}
      }
      callback({ statusCode: 200, on: () => {}, setTimeout: () => {} })
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

    const provider = logs.getLoggerProvider()
    if (provider.shutdown) {
      provider.shutdown()
    }
    logs.disable()
    sinon.restore()
  })

  describe('Logs Export', () => {
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
      setupTracer(true, '2')

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
      logs.getLogger({ name: 'test' }).emit({ severityText: 'INFO', body: 'Protobuf format' })
    })

    it('exports logs using JSON protocol', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'http/json'
      mockOtlpExport((decoded, capturedHeaders) => {
        assert.strictEqual(decoded.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue, 'JSON format')
      }, 'json')

      const { logs } = setupTracer()
      logs.getLogger('test').emit({ severityText: 'DEBUG', body: 'JSON format' })
    })

    it('returns no-op logger after shutdown', (done) => {
      const validator = mockOtlpExport((decoded) => {
        // Should only export the log emitted before shutdown
        assert.strictEqual(decoded.resourceLogs[0].scopeLogs[0].logRecords.length, 1)
        assert.strictEqual(decoded.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue, 'before shutdown')
      })

      const { logs, loggerProvider } = setupTracer(true, '2')
      const logger1 = logs.getLogger('test-logger')

      // Emit before shutdown - should work
      logger1.emit({ body: 'before shutdown', attributes: {} })

      // Shutdown the provider
      loggerProvider.forceFlush()
      loggerProvider.shutdown()
      assert.strictEqual(loggerProvider.isShutdown, true)
      // Existing loggers should not send logs after shutdown
      logger1.emit({ body: 'after shutdown same logger' })

      // Get a new logger after shutdown - should be no-op
      loggerProvider.register()
      const logger2 = logs.getLogger('test-logger-2')
      logger2.emit({ body: 'after shutdown new logger' })
      loggerProvider.forceFlush()

      // Wait a bit and verify only the first log was exported
      setTimeout(() => {
        validator()
        done()
      }, 50)
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

      setupTracer()

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

      setupTracer(true, '2')

      const spanContext = {
        traceId: '1234567890abcdef1234567890abcdef',
        spanId: '1234567890abcdef',
        traceFlags: 1,
      }
      context.with(trace.setSpan(context.active(), trace.wrapSpanContext(spanContext)), () => {
        const logger1 = logs.getLogger({ name: 'logger1', version: '1.0.0' })
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

    it('handles invalid severity number by defaulting to INFO', (done) => {
      mockOtlpExport((decoded) => {
        const logRecord = decoded.resourceLogs[0].scopeLogs[0].logRecords[0]
        // Invalid severity number should default to INFO (9)
        assert.strictEqual(logRecord.severityNumber, 9)
        done()
      })

      const { logs } = setupTracer()
      const logger = logs.getLogger('test-logger')

      // Emit with an invalid severity number (999)
      logger.emit({
        severityNumber: 999,
        body: 'Test message with invalid severity'
      })
    })

    it('transforms different body types correctly', (done) => {
      mockOtlpExport((decoded) => {
        const logRecords = decoded.resourceLogs[0].scopeLogs[0].logRecords

        // String body
        assert.strictEqual(logRecords[0].body.stringValue, 'string message')

        // Integer body (protobuf returns Long objects for int64)
        const intValue = logRecords[1].body.intValue
        assert.strictEqual(typeof intValue === 'object' ? intValue.toNumber() : intValue, 42)

        // Double/float body
        assert(logRecords[2].body.doubleValue !== undefined)
        assert(Math.abs(logRecords[2].body.doubleValue - 3.14159) < 0.00001)

        // Boolean body
        assert.strictEqual(logRecords[3].body.boolValue, true)

        // Object body - tests Object.entries().map() transformation
        assert(logRecords[4].body.kvlistValue)
        assert.strictEqual(logRecords[4].body.kvlistValue.values.length, 2)
        assert.strictEqual(logRecords[4].body.kvlistValue.values[0].key, 'foo')
        assert.strictEqual(logRecords[4].body.kvlistValue.values[0].value.stringValue, 'bar')
        assert.strictEqual(logRecords[4].body.kvlistValue.values[1].key, 'baz')
        const bazValue = logRecords[4].body.kvlistValue.values[1].value.intValue
        assert.strictEqual(typeof bazValue === 'object' ? bazValue.toNumber() : bazValue, 123)

        // Default case (symbol) - should convert to string
        assert.strictEqual(logRecords[5].body.stringValue, 'Symbol(test)')

        done()
      })

      const { logs } = setupTracer(true, '6')
      const logger = logs.getLogger('test-logger')

      // Emit logs with different body types
      logger.emit({ body: 'string message' })
      logger.emit({ body: 42 })
      logger.emit({ body: 3.14159 })
      logger.emit({ body: true })
      logger.emit({ body: { foo: 'bar', baz: 123 } })
      logger.emit({ body: Symbol('test') })
    })

    it('sends logs after batch timeout expires', (done) => {
      mockOtlpExport((decoded) => {
        const logRecord = decoded.resourceLogs[0].scopeLogs[0].logRecords[0]
        assert.strictEqual(logRecord.body.stringValue, 'timeout test')
        done()
      })

      process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = '10'
      process.env.OTEL_BSP_SCHEDULE_DELAY = '100' // 100ms timeout

      const { logs } = setupTracer()
      const logger = logs.getLogger('test-logger')

      logger.emit({ body: 'timeout test' })

      // Wait 100ms to ensure timer fires
      setTimeout(() => {}, 100)
    })

    it('exports resource with service, version, env, and hostname', (done) => {
      mockOtlpExport((decoded) => {
        const resource = decoded.resourceLogs[0].resource
        const resourceAttrs = {}
        resource.attributes.forEach(attr => { resourceAttrs[attr.key] = attr.value.stringValue })

        assert.strictEqual(resourceAttrs['service.name'], 'my-service')
        assert.strictEqual(resourceAttrs['service.version'], 'v1.2.3')
        assert.strictEqual(resourceAttrs['deployment.environment'], 'production')
        assert.strictEqual(resourceAttrs['host.name'], os.hostname())
        done()
      })

      process.env.DD_SERVICE = 'my-service'
      process.env.DD_VERSION = 'v1.2.3'
      process.env.DD_ENV = 'production'
      process.env.DD_TRACE_REPORT_HOSTNAME = 'true'

      const { logs } = setupTracer()
      const logger = logs.getLogger('test-logger')
      logger.emit({ body: 'test' })
    })

    it('handles multiple register() calls', () => {
      const { logs, loggerProvider } = setupTracer()

      // Calling register again should not throw
      loggerProvider.register()

      // Provider should still work
      assert.strictEqual(logs.getLoggerProvider(), loggerProvider)
      logs.getLogger('test').emit({ body: 'test' })
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
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://custom:4321/v1/logs'
      const { loggerProvider } = setupTracer()
      assert.strictEqual(loggerProvider.processor.exporter.options.path, '/v1/logs')
      assert.strictEqual(loggerProvider.processor.exporter.options.hostname, 'custom')
      assert.strictEqual(loggerProvider.processor.exporter.options.port, '4321')
    })

    it('prioritizes logs-specific endpoint over generic endpoint', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://custom:4318/v1/logs'
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://generic:4318/v1/logs'
      const { loggerProvider } = setupTracer()
      assert.strictEqual(loggerProvider.processor.exporter.options.path, '/v1/logs')
      assert.strictEqual(loggerProvider.processor.exporter.options.hostname, 'custom')
      assert.strictEqual(loggerProvider.processor.exporter.options.port, '4318')
    })

    it('appends /v1/logs to endpoint if not provided', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://custom:4318'
      const { loggerProvider } = setupTracer()
      assert.strictEqual(loggerProvider.processor.exporter.options.path, '/v1/logs')
    })

    it('configures OTLP headers from environment variable', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'api-key=secret,env=prod'
      const { loggerProvider } = setupTracer()
      const exporter = loggerProvider.processor.exporter
      assert.strictEqual(exporter.options.headers['api-key'], 'secret')
      assert.strictEqual(exporter.options.headers.env, 'prod')
    })

    it('prioritizes logs-specific headers over generic OTLP headers', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'generic=value,shared=generic'
      process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'logs-specific=value,shared=logs'
      const { loggerProvider } = setupTracer()
      const exporter = loggerProvider.processor.exporter
      assert.strictEqual(exporter.options.headers['logs-specific'], 'value')
      assert.strictEqual(exporter.options.headers.shared, 'logs')
      assert.strictEqual(exporter.options.headers.generic, undefined)
    })

    it('configures OTLP timeout from environment variable', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_TIMEOUT = '1000'
      const { loggerProvider } = setupTracer()
      assert.strictEqual(loggerProvider.processor.exporter.options.timeout, 1000)
    })

    it('prioritizes logs-specific timeout over generic timeout', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_TIMEOUT = '1000'
      process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '2000'
      const { loggerProvider } = setupTracer()
      assert.strictEqual(loggerProvider.processor.exporter.options.timeout, 1000)
    })

    it('does not initialize when OTEL logs are disabled', () => {
      const { loggerProvider } = setupTracer(false)
      const { LoggerProvider } = require('../../src/opentelemetry/logs')

      // Should return no-op provider when disabled, not our custom LoggerProvider
      assert.strictEqual(loggerProvider instanceof LoggerProvider, false)
    })

    it('disables log injection when OTEL logs are enabled', () => {
      const { tracer, loggerProvider } = setupTracer()

      assert(loggerProvider)
      assert.strictEqual(tracer._tracer._config.logInjection, false)
    })

    it('disables log injection even when DD_LOGS_INJECTION is explicitly set to true', () => {
      // OTEL logs and DD log injection are mutually exclusive
      process.env.DD_LOGS_INJECTION = 'true'
      const { tracer, loggerProvider } = setupTracer()

      assert(loggerProvider)
      assert.strictEqual(tracer._tracer._config.logInjection, false)
    })
  })

  describe('Telemetry Metrics', () => {
    it('tracks telemetry metrics for exported logs', () => {
      setupTracer()
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
