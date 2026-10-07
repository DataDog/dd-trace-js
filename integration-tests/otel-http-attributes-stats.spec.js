'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const http = require('node:http')
const { join } = require('node:path')

const { decode } = require('@msgpack/msgpack')
const { describe, it } = require('mocha')

const { DDSketch } = require('../vendor/dist/@datadog/sketches-js')
const { getProtobufTypes } = require('../packages/dd-trace/src/opentelemetry/otlp/protobuf_loader')

const root = join(__dirname, '..')
const fixture = join(__dirname, 'opentelemetry/http-attributes-stats.js')
const integerKeys = ['http.response.status_code', 'server.port']
const invalidNames = [
  'leading-zero', 'negative-zero', 'whitespace', 'decimal', 'plus', 'exponent', 'unsafe-string',
  'unsafe-number', 'unsafe-negative-string', 'unsafe-negative-number', 'fraction', 'infinite', 'nan',
]
const spanCount = 39

/**
 * @param {Array<{key: string, value: object}>} attributes
 */
function attributeMap (attributes) {
  return Object.fromEntries(attributes.map(({ key, value }) => [key, value]))
}

/**
 * @param {object[]} messages
 * @param {boolean} otlp
 */
function traceSpans (messages, otlp) {
  return messages.flatMap(({ payload }) => otlp
    ? payload.resourceSpans.flatMap(({ scopeSpans }) => scopeSpans.flatMap(({ spans }) => spans))
    : payload.flat())
}

/**
 * @param {object[]} messages
 * @param {boolean} otlp
 */
function statsRows (messages, otlp) {
  return messages.flatMap(({ payload }) => otlp
    ? payload.resourceMetrics.flatMap(({ scopeMetrics }) => scopeMetrics.flatMap(({ metrics }) => metrics.flatMap(
      ({ name, histogram }) => {
        assert.strictEqual(name, 'traces.span.sdk.metrics.duration')
        return histogram.dataPoints
      }
    )))
    : payload.Stats.flatMap(({ Stats }) => Stats))
}

/**
 * @param {boolean} semantics
 * @param {boolean} otlp
 * @param {string} protocol
 */
async function receive (semantics, otlp, protocol) {
  const traces = []
  const stats = []
  const paths = []
  let resolveDelivery, rejectDelivery
  const delivered = new Promise((resolve, reject) => {
    resolveDelivery = resolve
    rejectDelivery = reject
  })
  const timeout = setTimeout(() => rejectDelivery(new Error('HTTP trace/stats delivery timed out')), 30_000)
  const collector = http.createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.once('error', rejectDelivery)
    request.once('end', () => {
      paths.push(request.url)
      try {
        const body = Buffer.concat(chunks)
        let payload
        if (request.url === '/v0.4/traces' || request.url === '/v0.6/stats') {
          assert.strictEqual(request.headers['content-type'], 'application/msgpack')
          payload = decode(body, { useBigInt64: true })
        } else if (request.url === '/v1/traces' || request.url === '/v1/metrics') {
          if (request.url === '/v1/metrics' && protocol === 'http/protobuf') {
            assert.strictEqual(request.headers['content-type'], 'application/x-protobuf')
            const { protoMetricsService } = getProtobufTypes()
            payload = protoMetricsService.toObject(protoMetricsService.decode(body), { longs: Number })
          } else {
            assert.strictEqual(request.headers['content-type'], 'application/json')
            payload = JSON.parse(body)
          }
        }
        response.end(request.url === '/info' ? '{"endpoints":[]}' : '{}')
        if (request.url.endsWith('/traces')) traces.push({ payload })
        if (request.url.endsWith('/stats') || request.url.endsWith('/metrics')) stats.push({ payload })
        if (traceSpans(traces, otlp).length >= spanCount && statsRows(stats, otlp).reduce(
          (hits, row) => hits + Number(otlp ? row.count : row.Hits), 0
        ) >= spanCount) resolveDelivery()
      } catch (error) {
        if (!response.writableEnded) response.end('{}')
        rejectDelivery(error)
      }
    })
  })
  await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve))
  const { port } = collector.address()
  const child = spawn(process.execPath, [fixture], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      PATH: process.env.PATH,
      DD_INJECT_FORCE: 'true',
      DD_SERVICE: 'wire-service',
      DD_ENV: 'wire-test',
      DD_VERSION: 'wire-version',
      DD_TRACE_OTEL_SEMANTICS_ENABLED: String(semantics),
      DD_TRACE_AGENT_URL: `http://127.0.0.1:${port}`,
      ...(otlp ? {} : { DD_TRACE_AGENT_PROTOCOL_VERSION: '0.4' }),
      DD_TRACE_STATS_COMPUTATION_ENABLED: 'true',
      DD_TRACE_SAMPLE_RATE: '1',
      DD_TRACE_DISABLED_INSTRUMENTATIONS: 'net,dns',
      DD_REMOTE_CONFIGURATION_ENABLED: 'false',
      DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
      DD_CRASHTRACKING_ENABLED: 'false',
      DD_RUNTIME_METRICS_ENABLED: 'false',
      OTEL_TRACES_EXPORTER: otlp ? 'otlp' : '',
      OTEL_TRACES_SPAN_METRICS_ENABLED: String(otlp),
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${port}/v1/metrics`,
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: protocol,
    },
  })
  child.stdout.resume()
  child.stderr.resume()
  const exited = new Promise((resolve, reject) => {
    child.once('error', error => reject(new Error(`HTTP wire child failed: ${error.code}`)))
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`HTTP wire child exit: code=${code}, signal=${signal}`))
    })
  })
  const ready = new Promise(resolve => child.once('message', resolve))
  try {
    const [, { port: applicationPort }] = await Promise.race([
      Promise.all([delivered, ready]),
      exited.then(() => { throw new Error('HTTP wire child exited before delivery') }),
    ])
    child.send('delivered')
    await exited
    return { traces, stats, paths, applicationPort, protocol }
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await exited.catch(() => {})
    }
    collector.closeAllConnections()
    await new Promise(resolve => collector.close(resolve))
  }
}

/**
 * @param {boolean} semantics
 */
function expectedSpans (semantics) {
  const expected = []
  for (const [method, status] of [['GET', 404], ['GET', 503], ['PURGE', 201]]) {
    for (const kind of ['client', 'server']) {
      expected.push({
        resource: `${semantics && method === 'PURGE' ? 'HTTP' : method} /${status}`,
        service: `wire-${kind}`,
        kind,
        method: semantics && method === 'PURGE' ? '_OTHER' : method,
        status,
        endpoint: kind === 'client' ? `/${status}` : status === 503 ? '/native-route' : '/native-endpoint',
        error: kind === 'server' ? Number(status >= 500) : Number(semantics ? status >= 400 : status === 404),
        native: true,
      })
    }
  }
  for (const [resource, status, legacy, method, endpoint, error, kind] of [
    ['legacy-malformed', 500, '500oops', 'GET', '', Number(semantics), 'client'],
    ['legacy-exponent', 1, '1e2', 'GET', '', 0, 'client'],
    ['invalid-legacy', 204, 'bogus', 'GET', '', 0, 'client'],
    ['invalid-legacy-metric', 205, 'bogus', 'GET', '', 0, 'client'],
    ['falsy-legacy', 204, '', 'GET', '', 0, 'client'],
    ['derived-wins', 203, '203', 'GET', '', 0, 'client'],
    ['invalid-derived-port', undefined, undefined, 'GET', '', 0, 'client'],
    ['meta-wins', 204, undefined, '', '', 0, 'client'],
    ['metric-fallback', 205, undefined, '', '', 0, 'client'],
    ['invalid-metric', 204, undefined, '', '', 0, 'client'],
    ['both-invalid', undefined, undefined, '', '', 0, 'client'],
    [semantics ? 'HTTP /endpoint' : 'BREW /endpoint', 503, '503', semantics ? '_OTHER' : 'BREW', '/endpoint',
      Number(semantics), 'server'],
    ['GET /route', 503, '503', 'GET', '/route', 1, 'server'],
    ['GET /exception-404', 404, '404', 'GET', '', 1, 'server'],
    ['canonical-max', Number.MAX_SAFE_INTEGER, undefined, '', '', 0, 'client'],
    ['canonical-min', Number.MIN_SAFE_INTEGER, undefined, '', '', 0, 'client'],
    ['canonical-zero', 0, undefined, '', '', 0, 'client'],
    ['canonical-negative', -1, undefined, '', '', 0, 'client'],
    ...invalidNames.map(name => [`invalid-${name}`, undefined, undefined, '', '', 0, 'client']),
  ]) {
    expected.push({ resource, service: 'wire-service', kind, method, status, legacy, endpoint, error })
  }
  if (!semantics) {
    const bridgeValues = ['0204', '-0', ' 204', '204.0', '+204', '1e2', '9007199254740992',
      String(Number.MAX_SAFE_INTEGER + 1), '-9007199254740992', String(Number.MIN_SAFE_INTEGER - 1),
      '204.5', 'Infinity', 'NaN']
    for (const span of expected) {
      // The bridge mirrors canonical status onto the legacy tag only in disabled mode.
      if (span.resource.startsWith('canonical-')) span.legacy = String(span.status)
      const index = invalidNames.indexOf(span.resource.slice('invalid-'.length))
      if (index !== -1) span.legacy = bridgeValues[index]
    }
  }
  return expected
}

/**
 * @param {object} result
 * @param {boolean} semantics
 * @param {boolean} otlp
 */
function assertTraces (result, semantics, otlp) {
  const spans = traceSpans(result.traces, otlp)
  assert.strictEqual(spans.length, spanCount)
  assert.strictEqual(new Set(spans.map(span => String(otlp ? span.spanId : span.span_id))).size, spanCount)
  for (const span of spans) {
    if (otlp) {
      assert.match(span.traceId, /^[\da-f]{32}$/i)
      assert.doesNotMatch(span.traceId, /^0+$/)
      assert.match(span.spanId, /^[\da-f]{16}$/i)
      assert.doesNotMatch(span.spanId, /^0+$/)
      assert.ok(span.endTimeUnixNano > span.startTimeUnixNano)
      if (semantics) {
        // Count before reducing to a map: duplicate meta/metric keys must not be hidden.
        for (const key of integerKeys) {
          const entries = span.attributes.filter(attribute => attribute.key === key)
          assert.ok(entries.length <= 1, `${span.name}: duplicate ${key}`)
          for (const { value } of entries) {
            assert.deepStrictEqual(Object.keys(value), ['intValue'])
            assert.ok(Number.isSafeInteger(value.intValue))
          }
        }
      }
    } else {
      assert.strictEqual(typeof span.trace_id, 'bigint')
      assert.strictEqual(typeof span.span_id, 'bigint')
      assert.ok(span.trace_id > 0n)
      assert.ok(span.span_id > 0n)
      assert.ok(span.duration > 0)
    }
  }
  for (const expected of expectedSpans(semantics)) {
    const matches = spans.filter(span => (otlp ? span.name : span.resource) === expected.resource &&
      (otlp ? span.kind === (expected.kind === 'client' ? 3 : 2) : span.service === expected.service))
    assert.strictEqual(matches.length, 1, `${expected.service}: ${expected.resource}`)
    const span = matches[0]
    const attributes = otlp ? attributeMap(span.attributes) : span.meta
    assert.strictEqual(otlp ? Number(span.status?.code === 2) : span.error, expected.error, expected.resource)
    if (!semantics && expected.legacy !== undefined) {
      assert.deepStrictEqual(attributes['http.status_code'],
        otlp ? { stringValue: expected.legacy } : expected.legacy)
    }
    if (semantics && expected.method) {
      assert.deepStrictEqual(attributes['http.request.method'],
        otlp ? { stringValue: expected.method } : expected.method)
      assert.strictEqual(attributes['http.method'], undefined)
      assert.strictEqual(attributes['http.status_code'], undefined)
    }
    if (semantics && expected.status !== undefined) {
      if (otlp) {
        assert.deepStrictEqual(attributes['http.response.status_code'], { intValue: expected.status })
      } else if (expected.native || expected.legacy !== undefined) {
        assert.strictEqual(span.meta['http.response.status_code'], String(expected.status))
        assert.strictEqual(span.metrics['http.response.status_code'], undefined)
      }
    }
    if (expected.native && semantics) {
      assert.deepStrictEqual(attributes['server.port'], otlp
        ? { intValue: result.applicationPort }
        : String(result.applicationPort))
      if (!otlp) assert.strictEqual(span.metrics['server.port'], undefined)
    }
    if (expected.resource === 'GET /route' || expected.resource === 'GET /exception-404') {
      assert.deepStrictEqual(attributes['error.type'], otlp ? { stringValue: 'RangeError' } : 'RangeError')
    }
  }
  for (const status of [404, 503, 201]) {
    const resource = `${semantics && status === 201 ? 'HTTP' : status === 201 ? 'PURGE' : 'GET'} /${status}`
    const pair = spans.filter(span => (otlp ? span.name : span.resource) === resource)
    const client = pair.find(span => otlp ? span.kind === 3 : span.service === 'wire-client')
    const server = pair.find(span => otlp ? span.kind === 2 : span.service === 'wire-server')
    assert.strictEqual(otlp ? server.traceId : server.trace_id, otlp ? client.traceId : client.trace_id)
    assert.strictEqual(otlp ? server.parentSpanId : server.parent_id, otlp ? client.spanId : client.span_id)
  }
  const partition = spans.filter(span => (otlp ? span.name : span.resource) === 'GET /partition')
  assert.strictEqual(partition.length, 2)
  assert.deepStrictEqual(partition.map(span => otlp ? Number(span.status?.code === 2) : span.error).sort(), [0, 1])
  if (semantics && !otlp) {
    for (const [name, port] of [['derived-wins', 8080], ['invalid-derived-port', 81]]) {
      const span = spans.find(span => span.resource === name)
      assert.strictEqual(span.meta['server.port'], String(port))
      assert.strictEqual(span.metrics['server.port'], undefined)
    }
  }
  if (otlp) {
    for (const { payload } of result.traces) {
      for (const { resource } of payload.resourceSpans) {
        const attributes = attributeMap(resource.attributes)
        assert.deepStrictEqual(attributes['service.name'], { stringValue: 'wire-service' })
      }
    }
    const find = name => spans.find(span => span.name === name)
    if (semantics) {
      for (const [name, port] of [['derived-wins', 8080], ['invalid-derived-port', 81], ['meta-wins', 81],
        ['metric-fallback', 82], ['invalid-metric', 81], ['canonical-max', Number.MAX_SAFE_INTEGER],
        ['canonical-min', Number.MIN_SAFE_INTEGER], ['canonical-zero', 0], ['canonical-negative', -1]]) {
        assert.deepStrictEqual(attributeMap(find(name).attributes)['server.port'], { intValue: port })
      }
      for (const name of ['both-invalid', ...invalidNames.map(name => `invalid-${name}`)]) {
        const attributes = attributeMap(find(name).attributes)
        for (const key of integerKeys) assert.strictEqual(attributes[key], undefined, `${name}: ${key}`)
      }
    } else {
      for (const key of integerKeys) {
        const entries = find('meta-wins').attributes.filter(attribute => attribute.key === key)
        assert.strictEqual(entries.length, 2, `disabled preserves duplicate ${key}`)
        assert.deepStrictEqual(entries.map(({ value }) => Object.keys(value)[0]), ['stringValue', 'intValue'])
      }
    }
  }
}

/**
 * @param {object} result
 * @param {boolean} semantics
 * @param {boolean} otlp
 */
function assertStats (result, semantics, otlp) {
  const rows = statsRows(result.stats, otlp)
  if (otlp) {
    for (const { payload } of result.stats) {
      for (const { resource } of payload.resourceMetrics) {
        assert.deepStrictEqual(attributeMap(resource.attributes)['service.name'], { stringValue: 'wire-service' })
      }
    }
  }
  assert.strictEqual(rows.reduce((hits, row) => hits + Number(otlp ? row.count : row.Hits), 0), spanCount)
  for (const expected of expectedSpans(semantics)) {
    const matches = rows.filter(row => {
      const attributes = otlp ? attributeMap(row.attributes) : undefined
      return (otlp ? attributes['span.name'].stringValue : row.Resource) === expected.resource &&
        (otlp ? attributes['service.name'].stringValue : row.Service) === expected.service
    })
    assert.strictEqual(matches.length, 1, `stats ${expected.service}: ${expected.resource}`)
    const row = matches[0]
    let status = expected.status ?? 0
    if (!semantics && expected.legacy) status = Number(expected.legacy)
    if (otlp) {
      const attributes = attributeMap(row.attributes)
      assert.deepStrictEqual(attributes['span.kind'], { stringValue: `SPAN_KIND_${expected.kind.toUpperCase()}` })
      const operation = expected.native
        ? expected.kind === 'client' ? 'http.request' : 'web.request'
        : expected.resource === 'HTTP /endpoint' ? 'BREW /endpoint' : expected.resource
      assert.deepStrictEqual(attributes['datadog.operation.name'], { stringValue: operation })
      assert.deepStrictEqual(attributes['status.code'], {
        stringValue: expected.error ? 'STATUS_CODE_ERROR' : 'STATUS_CODE_OK',
      })
      assert.strictEqual(Number(row.count), 1)
      assert.ok(row.sum > 0)
      assert.ok(row.min > 0)
      assert.ok(row.max >= row.min)
      assert.strictEqual(row.bucketCounts.length, row.explicitBounds.length + 1)
      assert.strictEqual(row.bucketCounts.reduce((sum, count) => sum + Number(count), 0), Number(row.count))
      const statusAttribute = attributes['http.response.status_code']
      if (!Number.isFinite(status)) {
        assert.deepStrictEqual(Object.keys(statusAttribute), ['doubleValue'])
        if (result.protocol === 'http/json') assert.strictEqual(statusAttribute.doubleValue, null)
        else assert.ok(Object.is(statusAttribute.doubleValue, status))
      } else if (!status && !(!semantics && expected.legacy)) {
        assert.strictEqual(statusAttribute, undefined, expected.resource)
      } else {
        const field = Number.isInteger(status) ? 'intValue' : 'doubleValue'
        assert.deepStrictEqual(statusAttribute, { [field]: status === 0 ? 0 : status }, expected.resource)
      }
      assert.deepStrictEqual(attributes['http.request.method'],
        expected.method ? { stringValue: expected.method } : undefined)
      assert.deepStrictEqual(attributes['http.route'],
        expected.endpoint ? { stringValue: expected.endpoint } : undefined)
    } else {
      assert.strictEqual(row.HTTPStatusCode, status >>> 0, expected.resource)
      const span = traceSpans(result.traces, false).find(span =>
        span.resource === expected.resource && span.service === expected.service)
      assert.strictEqual(row.Name, span.name)
      assert.strictEqual(row.Duration, BigInt(span.duration))
      assert.strictEqual(row.HTTPMethod, expected.method)
      assert.strictEqual(row.HTTPEndpoint, expected.endpoint)
      assert.strictEqual(Number(row.Hits), 1)
      assert.strictEqual(Number(row.Errors), expected.error)
      assert.ok(Number(row.Duration) > 0)
      assert.strictEqual(DDSketch.fromProto(Buffer.from(row.OkSummary)).count, 1 - expected.error)
      assert.strictEqual(DDSketch.fromProto(Buffer.from(row.ErrorSummary)).count, expected.error)
    }
  }
  const partition = rows.filter(row => (otlp
    ? attributeMap(row.attributes)['span.name'].stringValue
    : row.Resource) === 'GET /partition')
  if (otlp) {
    assert.strictEqual(partition.length, 2)
    assert.deepStrictEqual(partition.map(row => attributeMap(row.attributes)['status.code'].stringValue).sort(),
      ['STATUS_CODE_ERROR', 'STATUS_CODE_OK'])
    for (const row of partition) {
      assert.strictEqual(Number(row.count), 1)
      assert.ok(row.sum > 0)
      assert.strictEqual(row.bucketCounts.reduce((sum, count) => sum + Number(count), 0), 1)
    }
  } else {
    // The two spans can straddle a time-bucket boundary; validate their combined observations.
    assert.ok(partition.length >= 1 && partition.length <= 2)
    assert.strictEqual(partition.reduce((sum, row) => sum + Number(row.Hits), 0), 2)
    assert.strictEqual(partition.reduce((sum, row) => sum + Number(row.Errors), 0), 1)
    for (const row of partition) assert.ok(Number(row.Duration) > 0)
    const spans = traceSpans(result.traces, false).filter(span => span.resource === 'GET /partition')
    assert.strictEqual(partition.reduce((sum, row) => sum + row.Duration, 0n),
      spans.reduce((sum, span) => sum + BigInt(span.duration), 0n))
    assert.strictEqual(partition.reduce((sum, row) =>
      sum + DDSketch.fromProto(Buffer.from(row.OkSummary)).count, 0), 1)
    assert.strictEqual(partition.reduce((sum, row) =>
      sum + DDSketch.fromProto(Buffer.from(row.ErrorSummary)).count, 0), 1)
  }
}

describe('HTTP attributes and stats on real wire', function () {
  this.timeout(60_000)

  for (const semantics of [false, true]) {
    for (const [otlp, protocol] of [[false, 'http/json'], [true, 'http/json'], [true, 'http/protobuf']]) {
      it(`preserves matching traces/stats with semantics ${semantics} and ${otlp ? `OTLP ${protocol}` : 'native'}`,
        async () => {
          const result = await receive(semantics, otlp, protocol)
          assertTraces(result, semantics, otlp)
          assertStats(result, semantics, otlp)
          const tracePath = otlp ? '/v1/traces' : '/v0.4/traces'
          const statsPath = otlp ? '/v1/metrics' : '/v0.6/stats'
          assert.ok(result.paths.includes(tracePath))
          assert.ok(result.paths.includes(statsPath))
          for (const path of result.paths) {
            assert.ok(['/info', '/dogstatsd/v2/proxy', tracePath, statsPath].includes(path), path)
          }
        })
    }
  }
})
