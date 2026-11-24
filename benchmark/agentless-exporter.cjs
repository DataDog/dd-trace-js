'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { performance } = require('node:perf_hooks')
const { zstdDecompressSync } = require('node:zlib')

process.env.DD_API_KEY = 'agentless-loopback-benchmark'

const AgentlessExporter = require('../packages/dd-trace/src/exporters/agentless')
const id = require('../packages/dd-trace/src/id')

const batchSize = Number(process.argv[2]) || 64
const rounds = Number(process.argv[3]) || 150
const workload = process.argv[4] || 'mixed'
const variant = process.argv[5] || 'shipped'
const noParent = id('0')
const baseStart = Number(1795170000123456700n)
const cases = [
  { type: 'web', resource: 'GET /customers/:id', meta: { 'http.url': 'https://shop.example.test/customers/123?page=1' } },
  { type: 'http', resource: 'GET /test', meta: { 'http.url': 'https://sample:private@example.test/test' } },
  {
    type: 'redis',
    resource: 'ZADD sample-key 1 sample-value',
    meta: { 'redis.raw_command': 'ZADD sample-key 1 sample-value' },
  },
  {
    type: 'valkey',
    resource: 'SET sample-key sample-value',
    meta: { 'valkey.raw_command': 'SET sample-key sample-value' },
  },
  { type: 'memcached', resource: 'set', meta: { 'memcached.command': 'set sample-key 0 0 12\r\nsample-value\r\n' } },
  { type: 'sql', resource: "SELECT * FROM orders WHERE id = 'sample-value'", meta: { 'db.type': 'postgres' } },
  { type: 'cassandra', resource: "SELECT * FROM orders WHERE id = 'sample-value'", meta: { 'db.type': 'cassandra' } },
  { type: 'elasticsearch', resource: 'search', meta: { 'elasticsearch.body': '{"match":{"id":"sample-value"}}' } },
  { type: 'opensearch', resource: 'search', meta: { 'opensearch.body': '{"match":{"id":"sample-value"}}' } },
  { type: 'mongodb', resource: 'find', meta: { 'mongodb.query': '{"id":"sample-value"}' } },
  { type: 'custom', resource: '', meta: { 'card.number': '4111111111111111' } },
]

function makeBatch (sequence = 0) {
  return Array.from({ length: batchSize }, (_, index) => {
    const digest = createHash('sha256').update(`${sequence}:${index}`).digest('hex')
    const traceId = id(digest.slice(0, 16))
    const spanIds = [id(digest.slice(16, 32)), id(digest.slice(32, 48)), id(digest.slice(48, 64))]
    const fixture = cases[workload === 'web' ? 0 : index % cases.length]
    return spanIds.map((spanId, position) => ({
      trace_id: traceId,
      span_id: spanId,
      parent_id: position === 0 ? noParent : spanIds[0],
      start: baseStart + sequence * 10000 + position * 1500,
      duration: 2000000 + index,
      error: 0,
      type: fixture.type,
      name: `${fixture.type}.operation`,
      resource: fixture.resource,
      service: 'benchmark',
      metrics: { _sampling_priority_v1: 1, _dd1: 1 },
      meta: { ...fixture.meta },
    }))
  })
}

async function main () {
  assert.ok(zstdDecompressSync, 'The benchmark requires a Node.js runtime with zstd support')
  let firstPayload
  let firstWirePayload
  let requests = 0
  let sockets = 0
  let capture = true
  const server = createServer((request, response) => {
    requests++
    response.setHeader('connection', 'close')
    if (capture) {
      capture = false
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        const body = Buffer.concat(chunks)
        const decoded = request.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(body) : body
        firstWirePayload = decoded.toString()
        firstPayload = JSON.parse(firstWirePayload)
        response.end('{}')
      })
    } else {
      request.resume()
      request.on('end', () => response.end('{}'))
    }
  })
  server.on('connection', () => { sockets++ })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  function createExporter (generatedObfuscation) {
    const exporter = new AgentlessExporter({
      flushInterval: 60_000,
      env: 'bench',
      tags: { 'runtime-id': 'benchmark' },
      tracing: { DD_TRACE_EXPERIMENTAL_AGENTLESS_GENERATED_OBFUSCATION_ENABLED: generatedObfuscation },
    })
    assert.ok(exporter.setUrl(`http://127.0.0.1:${server.address().port}`))
    return exporter
  }

  async function send (batch, destination) {
    for (const trace of batch) destination.export(trace)
    await new Promise((resolve, reject) => destination.flush(error => error ? reject(error) : resolve()))
  }

  try {
    const baseline = createExporter(false)
    const direct = createExporter(true)
    const testCard = '4111111111111111'
    const validationBatch = makeBatch()
    validationBatch[0][0].meta['custom.number'] = testCard
    await send(validationBatch, baseline)
    const expected = firstPayload
    const expectedStarts = firstWirePayload.match(/"start":\d+/g)
    assert.equal(expected.traces.length, batchSize)
    assert.equal(expected.traces[0].spans[0].meta['custom.number'], testCard)
    capture = true
    const generatedBatch = makeBatch()
    generatedBatch[0][0].meta['custom.number'] = testCard
    await send(generatedBatch, direct)
    const actual = firstPayload
    assert.equal(actual.traces[0].spans[0].meta['custom.number'], '?', 'expected current upstream redaction')
    expected.traces[0].spans[0].meta['custom.number'] = '?'
    assert.deepEqual(firstWirePayload.match(/"start":\d+/g), expectedStarts)
    assert.deepEqual(actual, expected)
    const exporter = variant === 'direct' ? direct : baseline
    const warmup = 150
    for (let iteration = 0; iteration < warmup; iteration++) {
      await send(makeBatch(iteration + 1), exporter)
    }
    let cpu = 0
    let elapsed = 0
    for (let iteration = 0; iteration < rounds; iteration++) {
      const batch = makeBatch(iteration + warmup + 1)
      const cpuStart = process.cpuUsage()
      const start = performance.now()
      await send(batch, exporter)
      const usage = process.cpuUsage(cpuStart)
      elapsed += performance.now() - start
      cpu += usage.user + usage.system
    }
    assert.equal(requests, 2 + warmup + rounds)
    assert.equal(sockets, requests)
    const cpuPerSpan = cpu / (rounds * batchSize * 3)
    const result = { variant, batchSize, rounds, workload, requests, cpu, elapsed, cpuPerSpan }
    process.stdout.write(JSON.stringify(result) + '\n')
  } finally {
    server.close()
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
