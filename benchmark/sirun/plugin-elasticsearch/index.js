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

const SEARCH_BODY = {
  query: {
    bool: {
      must: [{ match: { title: 'observability' } }, { term: { status: 'published' } }],
      filter: [{ range: { created_at: { gte: '2024-01-01' } } }],
    },
  },
  sort: [{ created_at: 'desc' }],
  size: 20,
}
const BULK_BODY = []
for (let i = 0; i < 40; i++) {
  BULK_BODY.push({ index: { _index: 'logs', _id: `id-${i}` } }, { message: `log line ${i}`, level: 'info', n: i })
}

const VARIANTS = {
  search: { method: 'POST', path: '/products/_search', body: SEARCH_BODY, querystring: { timeout: '5s' } },
  'bulk-index': { method: 'POST', path: '/logs/_bulk', bulkBody: BULK_BODY },
  get: { method: 'GET', path: '/products/_doc/123456', querystring: { _source: 'title,status' } },
}

const params = VARIANTS[VARIANT]
assert.ok(params, `unknown VARIANT: ${VARIANT}`)
const ctx = { params }

lastMeta = undefined
plugin.bindStart(ctx)
assert.ok(lastMeta && typeof lastMeta['elasticsearch.url'] === 'string', 'bindStart did not build meta')

guard.loopStart()
for (let i = 0; i < ITERATIONS; i++) {
  plugin.bindStart(ctx)
}
guard.done()

assert.ok(lastMeta, 'startSpan stub was never reached')
