'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const http = require('node:http')
const { join } = require('node:path')
const { promisify } = require('node:util')

const { describe, it } = require('mocha')

const execFileAsync = promisify(execFile)
const root = join(__dirname, '..')

/**
 * @param {Record<string, string>} env
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<object>}
 */
async function initialize (env, options = {}) {
  const { stdout } = await execFileAsync(process.execPath, ['-e', `
    const tracer = require('./').init(${JSON.stringify(options)})
    const config = tracer._tracer._config
    const real = !!tracer._tracingInitialized
    process.stdout.write(JSON.stringify({
      real,
      semantics: config?.DD_TRACE_OTEL_SEMANTICS_ENABLED,
      exporter: real ? tracer._tracer._exporter.constructor.name : undefined,
      endpoint: config?.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      schema: config?.spanAttributeSchema,
      peerService: config?.spanComputePeerService,
      otlp: real ? require('./packages/dd-trace/src/startup-log').tracerInfo().otlp_traces_export_enabled : false,
    }))
  `], {
    cwd: root,
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      DD_INJECT_FORCE: 'true',
      DD_REMOTE_CONFIGURATION_ENABLED: 'false',
      DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
      DD_CRASHTRACKING_ENABLED: 'false',
      ...env,
    },
  })
  return JSON.parse(stdout)
}

describe('OTel HTTP transport process entry', function () {
  this.timeout(15_000)

  it('forces OTLP over none and the agent protocol', async () => {
    const result = await initialize({
      DD_TRACE_OTEL_SEMANTICS_ENABLED: 'true',
      OTEL_TRACES_EXPORTER: 'none',
      DD_TRACE_AGENT_PROTOCOL_VERSION: '0.5',
      DD_TRACE_SPAN_ATTRIBUTE_SCHEMA: 'v1',
      DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED: 'true',
    })
    assert.deepStrictEqual(result, {
      real: true,
      semantics: true,
      exporter: 'OtlpHttpTraceExporter',
      endpoint: 'http://127.0.0.1:4318/v1/traces',
      schema: 'v0',
      peerService: false,
      otlp: true,
    })
  })

  for (const env of [
    { DD_TRACE_ENABLED: 'false', DD_TRACE_OTEL_SEMANTICS_ENABLED: 'true' },
    { OTEL_TRACES_EXPORTER: 'none' },
    { OTEL_TRACES_EXPORTER: 'none', DD_TRACE_OTEL_SEMANTICS_ENABLED: 'false' },
    {
      OTEL_TRACES_EXPORTER: 'none',
      DD_TRACE_OTEL_SEMANTICS_ENABLED: 'true',
      DD_TRACE_EXPERIMENTAL_EXPORTER: 'electron',
    },
    {
      OTEL_TRACES_EXPORTER: 'none',
      DD_TRACE_OTEL_SEMANTICS_ENABLED: 'true',
      AWS_LAMBDA_FUNCTION_NAME: 'transport-test',
    },
    {
      OTEL_TRACES_EXPORTER: 'none',
      DD_TRACE_OTEL_SEMANTICS_ENABLED: 'true',
      AWS_LAMBDA_FUNCTION_NAME: 'transport-test',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'ftp://invalid',
    },
  ]) {
    it(`keeps no-op tracing with ${JSON.stringify(env)}`, async () => {
      assert.deepStrictEqual(await initialize(env), { real: false, otlp: false })
    })
  }

  for (const endpointKey of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']) {
    it(`enables Lambda OTLP with ${endpointKey}`, async () => {
      const result = await initialize({
        AWS_LAMBDA_FUNCTION_NAME: 'transport-test',
        DD_TRACE_OTEL_SEMANTICS_ENABLED: 'true',
        OTEL_TRACES_EXPORTER: 'none',
        [endpointKey]: 'http://127.0.0.1:4318/custom',
      })
      assert.strictEqual(result.real, true)
      assert.strictEqual(result.semantics, true)
      assert.strictEqual(result.exporter, 'OtlpHttpTraceExporter')
      assert.strictEqual(result.endpoint, endpointKey === 'OTEL_EXPORTER_OTLP_ENDPOINT'
        ? 'http://127.0.0.1:4318/custom/v1/traces'
        : 'http://127.0.0.1:4318/custom')
      assert.strictEqual(result.otlp, true)
    })
  }

  it('keeps explicit OTLP independent of semantics', async () => {
    const result = await initialize({ OTEL_TRACES_EXPORTER: 'otlp' })
    assert.strictEqual(result.semantics, false)
    assert.strictEqual(result.exporter, 'OtlpHttpTraceExporter')
    assert.strictEqual(result.otlp, true)
  })

  it('keeps explicit tracing enabled with Electron and exporter none', async () => {
    const result = await initialize({
      DD_TRACE_ENABLED: 'true',
      DD_TRACE_OTEL_SEMANTICS_ENABLED: 'true',
      OTEL_TRACES_EXPORTER: 'none',
      DD_TRACE_EXPERIMENTAL_EXPORTER: 'electron',
    })
    assert.strictEqual(result.real, true)
    assert.strictEqual(result.exporter, 'ElectronExporter')
    assert.strictEqual(result.semantics, false)
    assert.strictEqual(result.otlp, false)
  })

  it('honors programmatic Electron and schema settings before platform exclusion', async () => {
    const result = await initialize({
      DD_TRACE_OTEL_SEMANTICS_ENABLED: 'true',
      OTEL_TRACES_EXPORTER: 'otlp',
      DD_TRACE_SPAN_ATTRIBUTE_SCHEMA: 'v0',
    }, { experimental: { exporter: 'electron' }, spanAttributeSchema: 'v1', spanComputePeerService: true })
    assert.strictEqual(result.exporter, 'ElectronExporter')
    assert.strictEqual(result.semantics, false)
    assert.strictEqual(result.schema, 'v1')
    assert.strictEqual(result.peerService, true)
    assert.strictEqual(result.otlp, false)
  })

  it('keeps the Test Optimization worker exporter and Datadog semantics', async () => {
    const result = await initialize({ DD_TRACE_OTEL_SEMANTICS_ENABLED: 'true', OTEL_TRACES_EXPORTER: 'otlp' }, {
      isCiVisibility: true, experimental: { exporter: 'jest_worker' },
    })
    assert.strictEqual(result.real, true)
    assert.strictEqual(result.exporter, 'TestWorkerCiVisibilityExporter')
    assert.strictEqual(result.semantics, false)
    assert.strictEqual(result.otlp, false)
  })
})

describe('native HTTP OTLP wire transport', function () {
  this.timeout(15_000)

  for (const endpointKey of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']) {
    it(`exports instrumented HTTP as OTLP JSON using ${endpointKey}`, async () => {
      const payloads = []
      const collector = http.createServer((request, response) => {
        const chunks = []
        request.on('data', chunk => chunks.push(chunk))
        request.on('end', () => {
          payloads.push({ path: request.url, headers: request.headers, payload: JSON.parse(Buffer.concat(chunks)) })
          response.end('{}')
        })
      })
      await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve))
      const { port } = collector.address()
      try {
        await execFileAsync(process.execPath, [join(__dirname, 'opentelemetry/native-http.js')], {
          cwd: root,
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            DD_INJECT_FORCE: 'true',
            DD_TRACE_OTEL_SEMANTICS_ENABLED: 'true',
            OTEL_TRACES_EXPORTER: 'none',
            DD_TRACE_AGENT_PROTOCOL_VERSION: '0.5',
            DD_REMOTE_CONFIGURATION_ENABLED: 'false',
            DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
            DD_CRASHTRACKING_ENABLED: 'false',
            DD_TRACE_DISABLED_INSTRUMENTATIONS: 'net,dns',
            [endpointKey]: `http://127.0.0.1:${port}/custom`,
          },
        })
        // The extracted server context and local client context flush independently.
        assert.strictEqual(payloads.length, 2)
        const spans = []
        for (const { path, headers, payload } of payloads) {
          assert.strictEqual(path, endpointKey === 'OTEL_EXPORTER_OTLP_ENDPOINT' ? '/custom/v1/traces' : '/custom')
          assert.strictEqual(headers['content-type'], 'application/json')
          for (const { resource, scopeSpans } of payload.resourceSpans) {
            const resourceAttributes = Object.fromEntries(resource.attributes.map(({ key, value }) => [key, value]))
            assert.deepStrictEqual(resourceAttributes['datadog.sdk.semantics'], { stringValue: 'otel' })
            spans.push(...scopeSpans.flatMap(({ spans }) => spans))
          }
        }
        assert.strictEqual(spans.length, 2)
        const client = spans.find(span => span.kind === 3)
        const server = spans.find(span => span.kind === 2)
        assert.ok(client)
        assert.ok(server)
        assert.notStrictEqual(server.spanId, client.spanId)
        assert.strictEqual(server.traceId, client.traceId)
        assert.strictEqual(server.parentSpanId, client.spanId)
        for (const span of spans) {
          assert.match(span.traceId, /^[\da-f]{32}$/i)
          assert.doesNotMatch(span.traceId, /^0+$/)
          assert.match(span.spanId, /^[\da-f]{16}$/i)
          assert.doesNotMatch(span.spanId, /^0+$/)
          const attributes = Object.fromEntries(span.attributes.map(({ key, value }) => [key, value]))
          assert.deepStrictEqual(attributes['http.request.method'], { stringValue: 'GET' })
          assert.deepStrictEqual(attributes['http.response.status_code'], { intValue: 201 })
          assert.strictEqual(attributes['http.status_code'], undefined)
          assert.strictEqual(attributes['resource.name'], undefined)
          assert.strictEqual(attributes['operation.name'], undefined)
          const priority = attributes._sampling_priority_v1?.intValue
          if (priority === undefined) {
            assert.strictEqual(Object.hasOwn(span, 'flags'), false)
          } else {
            assert.strictEqual(span.flags, Number(priority >= 1))
          }
        }
      } finally {
        collector.closeAllConnections()
        await new Promise(resolve => collector.close(resolve))
      }
    })
  }
})
