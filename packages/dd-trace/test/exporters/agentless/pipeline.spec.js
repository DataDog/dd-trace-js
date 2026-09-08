'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { URL } = require('node:url')
const zlib = require('node:zlib')

const { createAgentlessExporter } = require('@datadog/libdatadog')
const { after, before, describe, it } = require('mocha')

const { NODE_MAJOR, NODE_MINOR } = require('../../../../../version')
require('../../setup/core')

const agent = require('../../plugins/agent')
const id = require('../../../src/id')
const { TOP_LEVEL_KEY } = require('../../../src/constants')
const AgentlessWriter = require('../../../src/exporters/agentless/writer')
const { SpanStatsProcessor } = require('../../../src/span_stats')

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const zstdSupported = NODE_MAJOR >= 24 ||
  (NODE_MAJOR === 23 && NODE_MINOR >= 8) ||
  (NODE_MAJOR === 22 && NODE_MINOR >= 15)
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const zstdDecompressSync = zstdSupported ? zlib.zstdDecompressSync : undefined

describe('AgentlessWriter data pipeline', () => {
  let server
  let intakeUrl
  let resolveRequest
  let request

  /**
   * @param {number} count
   * @returns {Promise<object[]>}
   */
  function receiveRequests (count) {
    const requests = []
    return new Promise(resolve => {
      resolveRequest = received => {
        requests.push(received)
        if (requests.length === count) resolve(requests)
      }
    })
  }

  before(done => {
    process.env.DD_API_KEY = 'test-api-key'
    server = http.createServer((incoming, response) => {
      const chunks = []
      incoming.on('data', chunk => chunks.push(chunk))
      incoming.on('end', () => {
        resolveRequest({
          headers: incoming.headers,
          path: incoming.url,
          payload: Buffer.concat(chunks),
        })
        response.end()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      intakeUrl = new URL(`http://127.0.0.1:${port}`)
      done()
    })
  })

  after(async () => {
    delete process.env.DD_API_KEY
    await agent.close()
    await new Promise(resolve => server.close(resolve))
  })

  it('encodes v0.4 and exports agentless JSON through the pipeline', async () => {
    request = receiveRequests(1)
    const writer = new AgentlessWriter({
      url: intakeUrl,
      metadata: {
        env: 'test-env',
        hostname: 'test-host',
        runtimeID: 'test-runtime-id',
        entityId: 'in-1234',
      },
    })

    writer.append([{
      duration: 1,
      error: 0,
      meta: {},
      metrics: { [TOP_LEVEL_KEY]: 1 },
      name: 'operation',
      parent_id: id('0'),
      resource: 'resource',
      service: 'service',
      span_id: id('2'),
      start: 1,
      trace_id: id('1'),
    }])

    await new Promise(resolve => writer.flush(resolve))
    const [received] = await request

    assert.strictEqual(received.path, '/api/v2/spans')
    assert.strictEqual(received.headers['dd-api-key'], 'test-api-key')
    assert.strictEqual(received.headers['content-type'], 'application/json')
    assert.strictEqual(received.headers['content-encoding'], 'zstd')
    assert.strictEqual(received.headers['datadog-client-computed-top-level'], 'true')
    assert.strictEqual(received.headers['datadog-entity-id'], 'in-1234')
    assert.deepStrictEqual(received.payload.subarray(0, ZSTD_MAGIC.length), ZSTD_MAGIC)

    if (zstdDecompressSync) {
      const payload = JSON.parse(zstdDecompressSync(received.payload).toString())
      const trace = payload.traces[0]
      const span = trace.spans[0]

      assert.strictEqual(trace.runtimeID, 'test-runtime-id')
      assert.strictEqual(span.name, 'operation')
      assert.strictEqual(span.resource, 'resource')
      assert.strictEqual(span.service, 'service')
      assert.ok(span.meta, JSON.stringify(span))
      assert.strictEqual(span.meta['_dd.compute_stats'], '1')
      assert.strictEqual(span.metrics._trace_root, 1)
    }
  })

  it('exports traces and client stats through one data pipeline', async function () {
    const statsEndpoint = new URL('/api/v0.2/stats', intakeUrl).href
    const exporter = createAgentlessExporter({
      endpoint: new URL('/api/v2/spans', intakeUrl).href,
      statsEndpoint,
      apiKey: 'test-api-key',
      tracerVersion: 'test',
      languageVersion: process.version,
      languageInterpreter: 'v8',
    })
    const statsSupported = typeof exporter.sendStats === 'function'
    exporter.close()
    if (!statsSupported) this.skip()

    request = receiveRequests(2)
    const writer = new AgentlessWriter({
      url: intakeUrl,
      statsEndpoint,
      metadata: {
        env: 'test-env',
        hostname: 'test-host',
        runtimeID: 'test-runtime-id',
        entityId: 'in-1234',
      },
    })
    const statsProcessor = new SpanStatsProcessor({
      stats: {
        DD_TRACE_STATS_COMPUTATION_ENABLED: true,
        interval: 10,
      },
      url: intakeUrl,
      env: 'test-env',
      tags: { 'runtime-id': 'test-runtime-id' },
      version: '1.0.0',
    }, undefined, writer.sendStats.bind(writer))

    try {
      writer.append([{
        duration: 1,
        error: 0,
        meta: {},
        metrics: { [TOP_LEVEL_KEY]: 1 },
        name: 'operation',
        parent_id: id('0'),
        resource: 'resource',
        service: 'service',
        span_id: id('2'),
        start: 1,
        trace_id: id('1'),
      }])
      statsProcessor.onSpanFinished({
        duration: 1,
        error: 0,
        meta: {},
        metrics: { [TOP_LEVEL_KEY]: 1 },
        name: 'operation',
        resource: 'resource',
        service: 'service',
        start: 1,
        type: 'web',
      })

      await Promise.all([
        new Promise(resolve => writer.flush(resolve)),
        new Promise(resolve => statsProcessor.forceFlush(resolve)),
      ])
      const received = await request
      const traceRequest = received.find(({ path }) => path === '/api/v2/spans')
      const statsRequest = received.find(({ path }) => path === '/api/v0.2/stats')

      assert.ok(traceRequest)
      assert.ok(statsRequest)
      assert.strictEqual(traceRequest.headers['datadog-client-computed-stats'], 'true')
      assert.strictEqual(traceRequest.headers['datadog-client-computed-top-level'], 'true')
      assert.strictEqual(traceRequest.headers['datadog-entity-id'], 'in-1234')
      assert.strictEqual(statsRequest.headers['dd-api-key'], 'test-api-key')
      assert.strictEqual(statsRequest.headers['content-type'], 'application/msgpack')
      assert.strictEqual(statsRequest.headers['content-encoding'], 'zstd')
      assert.strictEqual(statsRequest.headers['datadog-client-computed-stats'], 'true')
      assert.strictEqual(statsRequest.headers['datadog-client-computed-top-level'], 'true')
      assert.strictEqual(statsRequest.headers['datadog-entity-id'], 'in-1234')
      assert.deepStrictEqual(statsRequest.payload.subarray(0, ZSTD_MAGIC.length), ZSTD_MAGIC)

      if (zstdDecompressSync) {
        const payload = JSON.parse(zstdDecompressSync(traceRequest.payload).toString())
        assert.strictEqual(Object.hasOwn(payload.traces[0].spans[0].meta, '_dd.compute_stats'), false)
      }
    } finally {
      clearInterval(statsProcessor.timer)
    }
  })

  it('does not trace the pipeline intake request', async () => {
    await agent.load('http', { server: false })
    const writer = new AgentlessWriter({ url: intakeUrl })
    const noIntakeTrace = agent.assertNoTraces(() => {
      assert.fail('the pipeline intake request must not create an HTTP client trace')
    }, { timeoutMs: 100 })

    request = receiveRequests(1)
    writer.append([{
      duration: 1,
      error: 0,
      meta: {},
      metrics: {},
      name: 'operation',
      parent_id: id('0'),
      resource: 'resource',
      service: 'service',
      span_id: id('2'),
      start: 1,
      trace_id: id('1'),
    }])

    await new Promise(resolve => writer.flush(resolve))
    await request
    await noIntakeTrace
  })
})
