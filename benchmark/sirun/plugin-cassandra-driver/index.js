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
const SINGLE = 'SELECT id, name, email FROM users WHERE id = ? AND tenant = ? ALLOW FILTERING'
const BATCH = []
for (let i = 0; i < 12; i++) BATCH.push({ query: `INSERT INTO events (id, payload) VALUES (?, ?) -- ${i}` })
const LONG = 'SELECT * FROM events WHERE ' + Array.from({ length: 400 }, (_, i) => `col_${i} = ?`).join(' OR ')

const VARIANTS = {
  query: { keyspace: 'app', query: SINGLE, contactPoints: CONTACT_POINTS },
  batch: { keyspace: 'app', query: BATCH, contactPoints: CONTACT_POINTS },
  'long-query': { keyspace: 'app', query: LONG, contactPoints: CONTACT_POINTS },
}

const v = VARIANTS[VARIANT]
assert.ok(v, `unknown VARIANT: ${VARIANT}`)

function makeCtx () {
  // query is reassigned inside bindStart for batches (combine), and arrays would
  // otherwise be consumed across calls; a fresh ctx per preflight keeps inputs
  // stable. The hot loop reuses one ctx (startSpan is stubbed, so ctx is not
  // mutated and the batch array is read, not drained).
  return { keyspace: v.keyspace, query: v.query, contactPoints: v.contactPoints }
}

const ctx = makeCtx()
lastMeta = undefined
plugin.bindStart(ctx)
assert.ok(lastMeta && typeof lastResource === 'string', 'bindStart did not build the resource/meta')
if (VARIANT === 'long-query') {
  assert.ok(lastResource.endsWith('...'), 'long-query should hit the 5000-char trim')
}

guard.loopStart()
for (let i = 0; i < ITERATIONS; i++) {
  plugin.bindStart(ctx)
}
guard.done()

assert.ok(lastMeta, 'startSpan stub was never reached')
