'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const CouchBasePlugin = require('../../../packages/datadog-plugin-couchbase/src/index')
const StoragePlugin = require('../../../packages/dd-trace/src/plugins/storage')

const { VARIANT } = process.env
const ITERATIONS = Number(process.env.ITERATIONS) || 5_000_000

// Couchbase builds its span tags in `CouchBasePlugin.startSpan`: assemble the
// base tag bag, add bucket/collection names, and merge the per-operation custom
// tags before delegating to the storage base. Stub the storage base's startSpan
// (the tracer-reaching layer) so the measured surface is the couchbase tag
// assembly itself, which we drive directly.
let lastMeta
const FAKE_SPAN = { finish () {}, setTag () {} }
StoragePlugin.prototype.startSpan = function (name, options) {
  lastMeta = options.meta
  return FAKE_SPAN
}

class BenchedCouchbasePlugin extends CouchBasePlugin {
  addSub () {}
  addBind () {}
  operationName () { return 'couchbase.query' }
  serviceName () { return 'couchbase-prod' }
}

const tracer = { _service: 'web-app', _env: 'prod', _version: '1.0.0' }
const plugin = new BenchedCouchbasePlugin(tracer, { spanComputePeerService: false })
plugin.configure({ enabled: true, service: 'couchbase-prod' })

const SEED_NODES = '10.0.0.1,10.0.0.2,10.0.0.3'

function sqlTags (resource) {
  return { 'span.type': 'sql', 'resource.name': resource, 'span.kind': 'client' }
}

// Each variant rotates a small corpus so the tag assembly runs over varied
// resource names (query) and buckets/collections (mutate). The upsert corpus
// also covers the sibling insert/replace operations, which share the same span
// starter. Cluster queries are traced with `{ resource, seedNodes }` only
// (wrapV3Query never sets a bucket), so the query locator carries no bucket --
// adding one would charge the `if (bucket)` branch real query spans never take.
const QUERY_OPS = [
  {
    operation: 'query',
    customTags: sqlTags('SELECT * FROM `app-data` WHERE type = $1'),
    locator: { seedNodes: SEED_NODES },
  },
  {
    operation: 'query',
    customTags: sqlTags('SELECT id, total FROM `orders` WHERE status = $1 LIMIT 50'),
    locator: { seedNodes: SEED_NODES },
  },
  {
    operation: 'query',
    customTags: sqlTags('UPDATE `sessions` SET active = true WHERE id = $1'),
    locator: { seedNodes: SEED_NODES },
  },
]

const MUTATE_OPS = [
  {
    operation: 'upsert',
    customTags: {},
    locator: { bucket: { name: 'app-data' }, collection: { name: 'orders' }, seedNodes: SEED_NODES },
  },
  {
    operation: 'insert',
    customTags: {},
    locator: { bucket: { name: 'users' }, collection: { name: 'profiles' }, seedNodes: SEED_NODES },
  },
  {
    operation: 'replace',
    customTags: {},
    locator: { bucket: { name: 'events' }, collection: { name: 'audit' }, seedNodes: SEED_NODES },
  },
]

const VARIANTS = { query: QUERY_OPS, upsert: MUTATE_OPS }

const ops = VARIANTS[VARIANT]
assert.ok(ops, `unknown VARIANT: ${VARIANT}`)
const len = ops.length
const ctx = {}

lastMeta = undefined
plugin.startSpan(ops[0].operation, ops[0].customTags, ops[0].locator, ctx)
assert.ok(lastMeta && lastMeta['db.type'] === 'couchbase', 'startSpan did not build the couchbase tags')

guard.loopStart()
for (let i = 0; i < ITERATIONS; i++) {
  const entry = ops[i % len]
  plugin.startSpan(entry.operation, entry.customTags, entry.locator, ctx)
}
guard.done()

assert.ok(lastMeta, 'storage startSpan stub was never reached')
