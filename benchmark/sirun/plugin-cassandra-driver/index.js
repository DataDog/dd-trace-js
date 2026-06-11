'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const CassandraDriverPlugin = require('../../../packages/datadog-plugin-cassandra-driver/src/index')

const { VARIANT } = process.env
const ITERATIONS = Number(process.env.ITERATIONS) || 3_000_000

// Every traced cassandra query walks `bindStart`: combine a batch of statements
// into one resource string (or trim a single long one), then assemble the meta
// bag. Subclass the real plugin and override only the tracer-reaching hooks so
// the measured surface is that resource/meta work.
let lastMeta
let lastResource
const FAKE_SPAN = { finish () {}, setTag () {} }
class BenchedCassandraPlugin extends CassandraDriverPlugin {
  addSub () {}
  addBind () {}
  operationName () { return 'cassandra.query' }
  serviceName () { return 'cassandra-prod' }
  startSpan (...args) {
    const opts = args.find((a) => a && a.meta)
    lastMeta = opts?.meta
    lastResource = opts?.resource
    return FAKE_SPAN
  }
}

const tracer = { _service: 'web-app', _env: 'prod', _version: '1.0.0' }
const plugin = new BenchedCassandraPlugin(tracer, { spanComputePeerService: false })
plugin.configure({ enabled: true, service: 'cassandra-prod' })

const CONTACT_POINTS = ['10.0.0.1', '10.0.0.2', '10.0.0.3']

const SINGLE_QUERIES = [
  'SELECT id, name, email FROM users WHERE id = ? AND tenant = ? ALLOW FILTERING',
  'INSERT INTO events (id, payload, ts) VALUES (?, ?, ?)',
  'SELECT * FROM orders WHERE customer_id = ? LIMIT 100',
  'UPDATE sessions SET last_seen = ? WHERE id = ?',
]

function buildBatch (count, table) {
  const batch = []
  for (let i = 0; i < count; i++) batch.push({ query: `INSERT INTO ${table} (id, payload) VALUES (?, ?) -- ${i}` })
  return batch
}

function buildLong (cols) {
  return 'SELECT * FROM events WHERE ' + Array.from({ length: cols }, (_, i) => `col_${i} = ?`).join(' OR ')
}

// Each variant rotates a small corpus of that shape so the resource/meta build
// runs over varied query lengths (and batch sizes) rather than one fixed query.
// bindStart only reads ctx (combine reads the batch array without draining it),
// so the pre-built ctxs are safe to reuse across iterations.
const VARIANTS = {
  query: SINGLE_QUERIES.map((query) => ({ keyspace: 'app', query, contactPoints: CONTACT_POINTS })),
  batch: [buildBatch(12, 'events'), buildBatch(8, 'audit'), buildBatch(16, 'metrics')]
    .map((query) => ({ keyspace: 'app', query, contactPoints: CONTACT_POINTS })),
  'long-query': [buildLong(400), buildLong(520)]
    .map((query) => ({ keyspace: 'app', query, contactPoints: CONTACT_POINTS })),
}

const ctxs = VARIANTS[VARIANT]
assert.ok(ctxs, `unknown VARIANT: ${VARIANT}`)
const len = ctxs.length

lastMeta = undefined
plugin.bindStart(ctxs[0])
assert.ok(lastMeta && typeof lastResource === 'string', 'bindStart did not build the resource/meta')
if (VARIANT === 'long-query') {
  assert.ok(lastResource.endsWith('...'), 'long-query should hit the 5000-char trim')
}

guard.loopStart()
for (let i = 0; i < ITERATIONS; i++) {
  plugin.bindStart(ctxs[i % len])
}
guard.done()

assert.ok(lastMeta, 'startSpan stub was never reached')
