'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const ElasticsearchPlugin = require('../../../packages/datadog-plugin-elasticsearch/src/index')

const { VARIANT } = process.env
const ITERATIONS = Number(process.env.ITERATIONS) || 2_000_000

// Every traced Elasticsearch request walks `bindStart`: serialize the request
// body (JSON.stringify), quantize the path (digit -> ?), serialize the query
// string, and assemble the meta bag. Subclass the real plugin and override only
// the tracer-reaching hooks so the measured surface is that per-request work.
let lastMeta
const FAKE_SPAN = { finish () {}, setTag () {} }
class BenchedElasticsearchPlugin extends ElasticsearchPlugin {
  addSub () {}
  addBind () {}
  operationName () { return 'elasticsearch.query' }
  serviceName () { return 'elasticsearch-prod' }
  startSpan (...args) {
    const opts = args.find((a) => a && a.meta)
    lastMeta = opts?.meta
    return FAKE_SPAN
  }
}

const tracer = { _service: 'web-app', _env: 'prod', _version: '1.0.0' }
const tracerConfig = { spanComputePeerService: false }
const plugin = new BenchedElasticsearchPlugin(tracer, tracerConfig)
plugin.configure({ enabled: true, service: 'elasticsearch-prod' })

// Each variant is a small corpus of realistic requests of that shape. Rotating
// over it (rather than one reused request) keeps the bindStart call site
// polymorphic and varies the path / body / querystring lengths quantizePath and
// the JSON.stringify calls see, closer to real traffic than a single fixture.
const SEARCH = [
  {
    method: 'POST',
    path: '/products/_search',
    body: {
      query: {
        bool: {
          must: [{ match: { title: 'observability' } }, { term: { status: 'published' } }],
          filter: [{ range: { created_at: { gte: '2024-01-01' } } }],
        },
      },
      sort: [{ created_at: 'desc' }],
      size: 20,
    },
    querystring: { timeout: '5s' },
  },
  {
    method: 'POST',
    path: '/orders-2024/_search',
    body: { query: { match: { customer_id: 'c-7788' } }, from: 40, size: 50 },
    querystring: { routing: 'shard-3' },
  },
  {
    method: 'POST',
    path: '/users/_search',
    body: { query: { term: { active: true } } },
    querystring: { _source: 'id,email' },
  },
]

function buildBulkBody (count, index) {
  const body = []
  for (let i = 0; i < count; i++) {
    body.push({ index: { _index: index, _id: `id-${i}` } }, { message: `log line ${i}`, level: 'info', n: i })
  }
  return body
}

const BULK = [
  { method: 'POST', path: '/logs/_bulk', bulkBody: buildBulkBody(40, 'logs') },
  { method: 'POST', path: '/events/_bulk', bulkBody: buildBulkBody(20, 'events') },
  { method: 'POST', path: '/metrics-2024/_bulk', bulkBody: buildBulkBody(60, 'metrics') },
]

const GET = [
  { method: 'GET', path: '/products/_doc/123456', querystring: { _source: 'title,status' } },
  { method: 'GET', path: '/users/_doc/u-998877', querystring: {} },
  { method: 'GET', path: '/orders-2024/_doc/55', querystring: { _source_excludes: 'payload' } },
]

const VARIANTS = { search: SEARCH, 'bulk-index': BULK, get: GET }

const corpus = VARIANTS[VARIANT]
assert.ok(corpus, `unknown VARIANT: ${VARIANT}`)
const ctxs = corpus.map((params) => ({ params }))
const len = ctxs.length

lastMeta = undefined
plugin.bindStart(ctxs[0])
assert.ok(lastMeta && typeof lastMeta['elasticsearch.url'] === 'string', 'bindStart did not build meta')

guard.loopStart()
for (let i = 0; i < ITERATIONS; i++) {
  plugin.bindStart(ctxs[i % len])
}
guard.done()

assert.ok(lastMeta, 'startSpan stub was never reached')
