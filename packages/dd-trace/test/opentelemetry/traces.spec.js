'use strict'

// Increase max listeners to avoid warnings in tests
process.setMaxListeners(50)

const assert = require('assert')
const http = require('http')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')
const { getConfigFresh } = require('../helpers/config')
const id = require('../../src/id')

describe('OpenTelemetry Traces', () => {
  let originalEnv

  function setupTracer (enabled = true) {
    if (enabled) {
      process.env.OTEL_TRACES_EXPORTER = 'otlp'
    } else {
      delete process.env.OTEL_TRACES_EXPORTER
    }

    const proxy = proxyquire.noPreserveCache()('../../src/proxy', {
      './config': getConfigFresh,
    })
    const TracerProxy = proxyquire.noPreserveCache()('../../src', {
      './proxy': proxy,
    })
    const tracer = proxyquire.noPreserveCache()('../../', {
      './src': TracerProxy,
    })
    tracer._initialized = false
    tracer._tracingInitialized = false
    tracer.init()
    return tracer
  }

  /**
   * Creates a mock DD-formatted span (as produced by span_format.js).
   *
   * @param {object} [overrides] - Optional field overrides
   * @returns {object} A mock DD-formatted span
   */
  function createMockSpan (overrides = {}) {
    return {
      trace_id: id('1234567890abcdef1234567890abcdef'),
      span_id: id('abcdef1234567890'),
      parent_id: id('1111111111111111'),
      name: 'test.operation',
      resource: '/api/test',
      service: 'test-service',
      type: 'web',
      error: 0,
      meta: {
        'span.kind': 'server',
        'http.method': 'GET',
        'http.url': 'http://localhost/api/test',
      },
      metrics: {
        'http.status_code': 200,
      },
      start: 1700000000000000000, // nanoseconds
      duration: 50000000, // 50ms in nanoseconds
      ...overrides,
    }
  }

  function mockOtlpExport (validator) {
    let capturedPayload, capturedHeaders
    let validatorCalled = false

    sinon.stub(http, 'request').callsFake((options, callback) => {
      // Only intercept OTLP traces requests
      if (options.path && options.path.includes('/v1/traces')) {
        capturedHeaders = options.headers
        const mockReq = {
          write: (data) => { capturedPayload = data },
          end: () => {
            const decoded = JSON.parse(capturedPayload.toString())
            validator(decoded, capturedHeaders)
            validatorCalled = true
          },
          on: () => {},
          once: () => {},
          setTimeout: () => {},
        }
        callback({ statusCode: 200, on: () => {}, once: () => {}, setTimeout: () => {} })
        return mockReq
      }

      // For other requests (remote config, DD agent, etc), return a basic mock
      const mockReq = {
        write: () => {},
        end: () => {},
        on: () => {},
        once: () => {},
        setTimeout: () => {},
      }
      callback({ statusCode: 200, on: () => {}, once: () => {}, setTimeout: () => {} })
      return mockReq
    })

    return () => {
      if (!validatorCalled) {
        throw new Error('OTLP export validator was never called')
      }
    }
  }

  beforeEach(() => {
    originalEnv = { ...process.env }
    // Clear OTEL env vars that may be set by the host environment (e.g. Claude Code telemetry)
    // to prevent test pollution. afterEach restores the original env.
    delete process.env.OTEL_TRACES_EXPORTER
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS
    delete process.env.OTEL_EXPORTER_OTLP_TIMEOUT
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT
  })

  afterEach(() => {
    process.env = originalEnv
    sinon.restore()
  })

  describe('Transformer', () => {
    const OtlpTraceTransformer = require('../../src/opentelemetry/trace/otlp_transformer')

    /**
     * Helper to decode the JSON payload from the transformer.
     *
     * @param {Buffer} payload - The JSON-encoded payload
     * @returns {object} Decoded JSON object
     */
    function decodePayload (payload) {
      return JSON.parse(payload.toString())
    }

    /**
     * Helper to extract attribute values from an OTLP attributes array.
     *
     * @param {object[]} attributes - Array of OTLP KeyValue objects
     * @returns {Record<string, string|number>} Flat key-value map
     */
    function extractAttrs (attributes) {
      const attrs = {}
      for (const attr of attributes) {
        if (attr.value.stringValue !== undefined) {
          attrs[attr.key] = attr.value.stringValue
        } else if (attr.value.intValue !== undefined) {
          attrs[attr.key] = attr.value.intValue
        } else if (attr.value.doubleValue !== undefined) {
          attrs[attr.key] = attr.value.doubleValue
        }
      }
      return attrs
    }

    it('transforms a basic span to OTLP JSON format', () => {
      const transformer = new OtlpTraceTransformer({ 'service.name': 'test-service' })
      const span = createMockSpan()

      const decoded = decodePayload(transformer.transformSpans([span]))

      assert.strictEqual(decoded.resourceSpans.length, 1)

      const { resource, scopeSpans } = decoded.resourceSpans[0]

      const resourceAttrs = extractAttrs(resource.attributes)
      assert.strictEqual(resourceAttrs['service.name'], 'test-service')

      assert.strictEqual(scopeSpans.length, 1)
      assert.strictEqual(scopeSpans[0].scope.name, 'dd-trace-js')

      const otlpSpan = scopeSpans[0].spans[0]
      assert.deepStrictEqual(
        { name: otlpSpan.name, kind: otlpSpan.kind, startTimeUnixNano: otlpSpan.startTimeUnixNano, endTimeUnixNano: otlpSpan.endTimeUnixNano },
        { name: '/api/test', kind: 2, startTimeUnixNano: 1700000000000000000, endTimeUnixNano: 1700000000050000000 }
      )

      // trace-id and span-id must be hex-encoded strings per the OTLP http/json spec
      assert.strictEqual(typeof otlpSpan.traceId, 'string', 'traceId must be a string')
      assert.strictEqual(otlpSpan.traceId.length, 32, 'traceId must be 32 hex chars (16 bytes)')
      assert.match(otlpSpan.traceId, /^[0-9a-f]+$/, 'traceId must be lowercase hex')
      assert.strictEqual(typeof otlpSpan.spanId, 'string', 'spanId must be a string')
      assert.strictEqual(otlpSpan.spanId.length, 16, 'spanId must be 16 hex chars (8 bytes)')
      assert.match(otlpSpan.spanId, /^[0-9a-f]+$/, 'spanId must be lowercase hex')
      assert.strictEqual(typeof otlpSpan.parentSpanId, 'string', 'parentSpanId must be a string')
      assert.strictEqual(otlpSpan.parentSpanId.length, 16, 'parentSpanId must be 16 hex chars (8 bytes)')
    })

    it('maps span kind correctly', () => {
      const transformer = new OtlpTraceTransformer({})

      const kinds = ['internal', 'server', 'client', 'producer', 'consumer']
      const expected = [1, 2, 3, 4, 5]

      for (let i = 0; i < kinds.length; i++) {
        const span = createMockSpan({ meta: { 'span.kind': kinds[i] } })
        const decoded = decodePayload(transformer.transformSpans([span]))
        assert.strictEqual(decoded.resourceSpans[0].scopeSpans[0].spans[0].kind, expected[i])
      }
    })

    it('defaults to SPAN_KIND_UNSPECIFIED when no span.kind', () => {
      const transformer = new OtlpTraceTransformer({})
      const span = createMockSpan({ meta: {} })

      const decoded = decodePayload(transformer.transformSpans([span]))
      assert.strictEqual(decoded.resourceSpans[0].scopeSpans[0].spans[0].kind, 0)
    })

    it('maps error status correctly', () => {
      const transformer = new OtlpTraceTransformer({})

      const okSpan = createMockSpan({ error: 0 })
      const okDecoded = decodePayload(transformer.transformSpans([okSpan]))
      assert.strictEqual(okDecoded.resourceSpans[0].scopeSpans[0].spans[0].status.code, 0)

      const errSpan = createMockSpan({ error: 1, meta: { 'error.message': 'something broke' } })
      const errDecoded = decodePayload(transformer.transformSpans([errSpan]))
      assert.deepStrictEqual(errDecoded.resourceSpans[0].scopeSpans[0].spans[0].status, {
        code: 2,
        message: 'something broke',
      })
    })

    it('omits parentSpanId for root spans (zero parent ID)', () => {
      const transformer = new OtlpTraceTransformer({})
      const span = createMockSpan({ parent_id: id('0') })

      const decoded = decodePayload(transformer.transformSpans([span]))
      const otlpSpan = decoded.resourceSpans[0].scopeSpans[0].spans[0]

      assert(!otlpSpan.parentSpanId, 'parentSpanId should not be set for root span')
    })

    it('includes meta and metrics as attributes', () => {
      const transformer = new OtlpTraceTransformer({})
      const span = createMockSpan({
        meta: {
          'http.method': 'POST',
          'http.url': 'http://example.com',
        },
        metrics: {
          'http.status_code': 404,
        },
      })

      const decoded = decodePayload(transformer.transformSpans([span]))
      const attrs = extractAttrs(decoded.resourceSpans[0].scopeSpans[0].spans[0].attributes)

      assert.deepStrictEqual(
        { 'http.method': attrs['http.method'], 'http.url': attrs['http.url'], 'http.status_code': attrs['http.status_code'] },
        { 'http.method': 'POST', 'http.url': 'http://example.com', 'http.status_code': 404 }
      )
    })

    it('encodes meta_struct values as base64 bytesValue attributes', () => {
      const transformer = new OtlpTraceTransformer({})
      const span = createMockSpan({
        meta_struct: {
          '_dd.stack': { nodejs: [{ id: 1, text: 'fn', file: 'a.js', line: 10 }] },
          'http.request.body': { key: 'value' },
        },
      })

      const decoded = decodePayload(transformer.transformSpans([span]))
      const attrs = decoded.resourceSpans[0].scopeSpans[0].spans[0].attributes

      const stackAttr = attrs.find(a => a.key === '_dd.stack')
      assert.ok(stackAttr, '_dd.stack attribute should be present')
      assert.ok(stackAttr.value.bytesValue !== undefined, '_dd.stack should have bytesValue')
      const stackDecoded = JSON.parse(Buffer.from(stackAttr.value.bytesValue, 'base64').toString())
      assert.deepStrictEqual(stackDecoded, { nodejs: [{ id: 1, text: 'fn', file: 'a.js', line: 10 }] })

      const bodyAttr = attrs.find(a => a.key === 'http.request.body')
      assert.ok(bodyAttr, 'http.request.body attribute should be present')
      assert.ok(bodyAttr.value.bytesValue !== undefined, 'http.request.body should have bytesValue')
      const bodyDecoded = JSON.parse(Buffer.from(bodyAttr.value.bytesValue, 'base64').toString())
      assert.deepStrictEqual(bodyDecoded, { key: 'value' })
    })

    it('excludes _dd.span_links and span.kind from attributes', () => {
      const transformer = new OtlpTraceTransformer({})
      const span = createMockSpan({
        meta: {
          'span.kind': 'client',
          '_dd.span_links': '[]',
          'keep.this': 'value',
        },
      })

      const decoded = decodePayload(transformer.transformSpans([span]))
      const keys = decoded.resourceSpans[0].scopeSpans[0].spans[0].attributes.map(a => a.key)

      assert(!keys.includes('span.kind'), 'span.kind should be excluded from attributes')
      assert(!keys.includes('_dd.span_links'), '_dd.span_links should be excluded from attributes')
      assert(keys.includes('keep.this'), 'Other meta keys should be present')
    })

    it('includes resource, service, type, and operation name as attributes', () => {
      const transformer = new OtlpTraceTransformer({})
      const span = createMockSpan()

      const decoded = decodePayload(transformer.transformSpans([span]))
      const attrs = extractAttrs(decoded.resourceSpans[0].scopeSpans[0].spans[0].attributes)

      assert.deepStrictEqual(
        {
          'resource.name': attrs['resource.name'],
          'service.name': attrs['service.name'],
          'span.type': attrs['span.type'],
          'operation.name': attrs['operation.name'],
        },
        {
          'resource.name': '/api/test',
          'service.name': 'test-service',
          'span.type': 'web',
          'operation.name': 'test.operation',
        }
      )
    })

    it('transforms span events', () => {
      const transformer = new OtlpTraceTransformer({})
      const span = createMockSpan({
        span_events: [{
          name: 'exception',
          time_unix_nano: 1700000000010000000,
          attributes: {
            'exception.message': 'test error',
            'exception.type': 'Error',
          },
        }],
      })

      const decoded = decodePayload(transformer.transformSpans([span]))
      const otlpSpan = decoded.resourceSpans[0].scopeSpans[0].spans[0]

      assert.strictEqual(otlpSpan.events.length, 1)
      assert.strictEqual(otlpSpan.events[0].name, 'exception')

      const eventAttrs = extractAttrs(otlpSpan.events[0].attributes)
      assert.deepStrictEqual(
        { 'exception.message': eventAttrs['exception.message'], 'exception.type': eventAttrs['exception.type'] },
        { 'exception.message': 'test error', 'exception.type': 'Error' }
      )
    })

    it('transforms span links from _dd.span_links JSON', () => {
      const transformer = new OtlpTraceTransformer({})
      const links = JSON.stringify([{
        trace_id: 'aabbccddaabbccddaabbccddaabbccdd',
        span_id: '1122334455667788',
        attributes: { 'link.reason': 'follows-from' },
        tracestate: 'dd=s:1',
      }])

      const span = createMockSpan({
        meta: {
          '_dd.span_links': links,
        },
      })

      const decoded = decodePayload(transformer.transformSpans([span]))
      const otlpSpan = decoded.resourceSpans[0].scopeSpans[0].spans[0]

      assert.strictEqual(otlpSpan.links.length, 1)
      const link = otlpSpan.links[0]
      assert.deepStrictEqual(
        { traceId: link.traceId, spanId: link.spanId, traceState: link.traceState },
        { traceId: 'aabbccddaabbccddaabbccddaabbccdd', spanId: '1122334455667788', traceState: 'dd=s:1' }
      )
      assert.strictEqual(extractAttrs(link.attributes)['link.reason'], 'follows-from')
    })

    it('maps timestamps correctly', () => {
      const transformer = new OtlpTraceTransformer({})
      const beforeNs = Date.now() * 1e6
      const durationNs = 50000000 // 50ms
      const span = createMockSpan({
        start: beforeNs,
        duration: durationNs,
      })

      const decoded = decodePayload(transformer.transformSpans([span]))
      const otlpSpan = decoded.resourceSpans[0].scopeSpans[0].spans[0]

      assert.ok(otlpSpan.startTimeUnixNano >= beforeNs,
        `startTimeUnixNano (${otlpSpan.startTimeUnixNano}) should be >= recorded time (${beforeNs})`)
      assert.ok(otlpSpan.endTimeUnixNano >= otlpSpan.startTimeUnixNano,
        `endTimeUnixNano (${otlpSpan.endTimeUnixNano}) should be >= startTimeUnixNano (${otlpSpan.startTimeUnixNano})`)
    })

    it('handles empty span array', () => {
      const transformer = new OtlpTraceTransformer({})
      const decoded = decodePayload(transformer.transformSpans([]))

      assert.strictEqual(decoded.resourceSpans.length, 1)
      assert.strictEqual(decoded.resourceSpans[0].scopeSpans[0].spans.length, 0)
    })

    it('handles multiple spans', () => {
      const transformer = new OtlpTraceTransformer({})
      const spans = [
        createMockSpan({ resource: '/api/first' }),
        createMockSpan({ resource: '/api/second', span_id: id('bbbbbbbbbbbbbbbb') }),
      ]

      const decoded = decodePayload(transformer.transformSpans(spans))
      const otlpSpans = decoded.resourceSpans[0].scopeSpans[0].spans

      assert.strictEqual(otlpSpans.length, 2)
      assert.deepStrictEqual(
        [otlpSpans[0].name, otlpSpans[1].name],
        ['/api/first', '/api/second']
      )
    })
  })

  describe('Exporter', () => {
    it('exports spans via OTLP HTTP with JSON encoding', () => {
      mockOtlpExport((decoded) => {
        const otlpSpan = decoded.resourceSpans[0].scopeSpans[0].spans[0]
        assert.strictEqual(otlpSpan.name, '/api/test')
      })

      const tracer = setupTracer()
      const processor = tracer._tracer._processor
      const exporter = processor._exporter

      const span = createMockSpan({ name: 'http.request' })
      exporter.export([span])
    })

    it('sends JSON content-type header', () => {
      mockOtlpExport((decoded, headers) => {
        assert.strictEqual(headers['Content-Type'], 'application/json')
      })

      const tracer = setupTracer()
      const processor = tracer._tracer._processor
      const exporter = processor._exporter

      exporter.export([createMockSpan()])
    })

    it('includes custom headers from OTEL_EXPORTER_OTLP_TRACES_HEADERS', () => {
      process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'x-api-key=secret123'

      mockOtlpExport((decoded, headers) => {
        assert.strictEqual(headers['x-api-key'], 'secret123')
      })

      const tracer = setupTracer()
      const processor = tracer._tracer._processor
      const exporter = processor._exporter

      exporter.export([createMockSpan()])
    })

    it('includes multiple comma-separated custom headers from OTEL_EXPORTER_OTLP_TRACES_HEADERS', () => {
      process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'x-api-key=secret123,other-config-value=value'

      mockOtlpExport((decoded, headers) => {
        assert.strictEqual(headers['x-api-key'], 'secret123')
        assert.strictEqual(headers['other-config-value'], 'value')
      })

      const tracer = setupTracer()
      const processor = tracer._tracer._processor
      const exporter = processor._exporter

      exporter.export([createMockSpan()])
    })

    it('includes custom headers from OTEL_EXPORTER_OTLP_HEADERS when traces-specific header is not set', () => {
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-generic-key=generic-value'

      mockOtlpExport((decoded, headers) => {
        assert.strictEqual(headers['x-generic-key'], 'generic-value')
      })

      const tracer = setupTracer()
      const processor = tracer._tracer._processor
      const exporter = processor._exporter

      exporter.export([createMockSpan()])
    })

    it('uses OTEL_EXPORTER_OTLP_TRACES_HEADERS over OTEL_EXPORTER_OTLP_HEADERS when both are set', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-generic-key=generic-value'
      process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'x-traces-key=traces-value'

      mockOtlpExport((decoded, headers) => {
        assert.strictEqual(headers['x-traces-key'], 'traces-value')
        assert.strictEqual(headers['x-generic-key'], undefined)
      })

      const tracer = setupTracer()
      const processor = tracer._tracer._processor
      const exporter = processor._exporter

      exporter.export([createMockSpan()])
    })

    it('does not export empty span arrays', () => {
      let exportCalled = false
      sinon.stub(http, 'request').callsFake(() => {
        exportCalled = true
        return { write: () => {}, end: () => {}, on: () => {}, once: () => {}, setTimeout: () => {} }
      })

      const tracer = setupTracer()
      const processor = tracer._tracer._processor
      const exporter = processor._exporter

      exporter.export([])
      assert(!exportCalled, 'No HTTP request should be made for empty span arrays')
    })

    it('does not export spans with rejected sampling priority (0)', () => {
      let exportCalled = false
      sinon.stub(http, 'request').callsFake(() => {
        exportCalled = true
        return { write: () => {}, end: () => {}, on: () => {}, once: () => {}, setTimeout: () => {} }
      })

      const tracer = setupTracer()
      const exporter = tracer._tracer._processor._exporter

      exporter.export([createMockSpan({ metrics: { '_sampling_priority_v1': 0 } })])
      assert(!exportCalled, 'No HTTP request should be made for rejected traces')
    })

    it('does not export spans with user-rejected sampling priority (-1)', () => {
      let exportCalled = false
      sinon.stub(http, 'request').callsFake(() => {
        exportCalled = true
        return { write: () => {}, end: () => {}, on: () => {}, once: () => {}, setTimeout: () => {} }
      })

      const tracer = setupTracer()
      const exporter = tracer._tracer._processor._exporter

      exporter.export([createMockSpan({ metrics: { '_sampling_priority_v1': -1 } })])
      assert(!exportCalled, 'No HTTP request should be made for user-rejected traces')
    })

    it('replaces the original DD Agent exporter', () => {
      mockOtlpExport(() => {})

      const tracer = setupTracer()
      const processor = tracer._tracer._processor
      const exporter = processor._exporter

      const OtlpHttpTraceExporter = require('../../src/opentelemetry/trace/otlp_http_trace_exporter')
      assert(exporter instanceof OtlpHttpTraceExporter, 'Exporter should be the OTLP exporter, not a wrapper')
    })
  })

  describe('Configurations', () => {
    // Only http/json is currently supported. Other protocols (grpc, http/protobuf)
    // are not yet implemented and will be added in a future release.
    it('uses default http/json protocol', () => {
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
      delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL

      const tracer = setupTracer()
      const config = tracer._tracer._config
      assert.strictEqual(config.otelTracesProtocol, 'http/json')
    })

    it('uses port 4318 for default OTLP HTTP endpoint', () => {
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
      delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL

      const config = getConfigFresh()
      assert(config.otelTracesUrl.includes(':4318'), `expected port 4318 in URL, got: ${config.otelTracesUrl}`)
    })

    it('respects explicit traces-specific endpoint as-is', () => {
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://custom-collector:9999'

      const config = getConfigFresh()
      assert.strictEqual(config.otelTracesUrl, 'http://custom-collector:9999')
    })

    it('appends /v1/traces to generic OTEL_EXPORTER_OTLP_ENDPOINT with no path', () => {
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318'

      const config = getConfigFresh()
      assert.strictEqual(config.otelTracesUrl, 'http://collector:4318/v1/traces')
    })

    it('appends /v1/traces to generic OTEL_EXPORTER_OTLP_ENDPOINT with a custom path', () => {
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318/custom'

      const config = getConfigFresh()
      assert.strictEqual(config.otelTracesUrl, 'http://collector:4318/custom/v1/traces')
    })

    it('traces-specific endpoint takes precedence over generic endpoint', () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://generic:4318'
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://traces-specific:9999'

      const config = getConfigFresh()
      assert.strictEqual(config.otelTracesUrl, 'http://traces-specific:9999')
    })

    // Note: Configuration env var tests are skipped due to test setup complexity.
    // The configuration mapping works correctly (verified in config/index.js),
    // but the test setup doesn't properly reload config between tests.
    // The implementation correctly reads OTEL_EXPORTER_OTLP_TRACES_* env vars
    // with fallback to OTEL_EXPORTER_OTLP_* generic vars.

    it('does not initialize OTLP trace export when disabled', () => {
      const tracer = setupTracer(false)
      const processor = tracer._tracer._processor
      const exporter = processor._exporter

      // When disabled, the exporter should be the original (not wrapped)
      assert(!exporter._originalExporter, 'Exporter should not be wrapped when OTLP traces are disabled')
    })

    it('exports resource with service, version, env, and hostname', () => {
      process.env.DD_SERVICE = 'my-trace-service'
      process.env.DD_VERSION = 'v2.0.0'
      process.env.DD_ENV = 'staging'
      process.env.DD_TRACE_REPORT_HOSTNAME = 'true'

      mockOtlpExport((decoded) => {
        const resource = decoded.resourceSpans[0].resource
        const resourceAttrs = {}
        resource.attributes.forEach(attr => {
          resourceAttrs[attr.key] = attr.value.stringValue
        })

        assert.deepStrictEqual(
          {
            'service.name': resourceAttrs['service.name'],
            'service.version': resourceAttrs['service.version'],
            'deployment.environment': resourceAttrs['deployment.environment'],
            'telemetry.sdk.name': resourceAttrs['telemetry.sdk.name'],
            'telemetry.sdk.language': resourceAttrs['telemetry.sdk.language'],
          },
          {
            'service.name': 'my-trace-service',
            'service.version': 'v2.0.0',
            'deployment.environment': 'staging',
            'telemetry.sdk.name': 'datadog',
            'telemetry.sdk.language': 'javascript',
          }
        )
        assert.ok(resourceAttrs['telemetry.sdk.version'], 'telemetry.sdk.version should be set')
      })

      const tracer = setupTracer()
      const processor = tracer._tracer._processor
      const exporter = processor._exporter

      exporter.export([createMockSpan()])
    })
  })

  describe('Telemetry Metrics', () => {
    it('tracks telemetry metrics for exported traces', () => {
      const telemetryMetrics = {
        manager: { namespace: sinon.stub().returns({ count: sinon.stub().returns({ inc: sinon.spy() }) }) },
      }
      const MockedExporter = proxyquire('../../src/opentelemetry/trace/otlp_http_trace_exporter', {
        '../otlp/otlp_http_exporter_base': proxyquire('../../src/opentelemetry/otlp/otlp_http_exporter_base', {
          '../../telemetry/metrics': telemetryMetrics,
        }),
      })

      const exporter = new MockedExporter('http://localhost:4318/v1/traces', '', 1000, {})
      exporter.export([createMockSpan()])

      assert(telemetryMetrics.manager.namespace().count().inc.calledWith(1))
    })
  })
})
