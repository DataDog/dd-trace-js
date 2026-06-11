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
const BUCKET = { name: 'app-data' }
const COLLECTION = { name: 'orders' }

const VARIANTS = {
  query: {
    operation: 'query',
    customTags: {
      'span.type': 'sql',
      'resource.name': 'SELECT * FROM `app-data` WHERE type = $1',
      'span.kind': 'client',
    },
    locator: { bucket: BUCKET, seedNodes: SEED_NODES },
  },
  upsert: {
    operation: 'upsert',
    customTags: {},
    locator: { bucket: BUCKET, collection: COLLECTION, seedNodes: SEED_NODES },
  },
}

const v = VARIANTS[VARIANT]
assert.ok(v, `unknown VARIANT: ${VARIANT}`)
const ctx = {}

lastMeta = undefined
plugin.startSpan(v.operation, v.customTags, v.locator, ctx)
assert.ok(lastMeta && lastMeta['db.type'] === 'couchbase', 'startSpan did not build the couchbase tags')

guard.loopStart()
for (let i = 0; i < ITERATIONS; i++) {
  plugin.startSpan(v.operation, v.customTags, v.locator, ctx)
}
guard.done()

assert.ok(lastMeta, 'storage startSpan stub was never reached')
