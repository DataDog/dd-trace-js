'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

// Resolve `src/index` (stable across branches) rather than the internal `query.js`, so the
// baseline run of this file against the older source still resolves. The export is the
// `mongodb-core` composite once the query span is split into a child plugin (`.plugins.query`),
// and the query plugin class itself on the older single-class source.
const MongodbCoreExport = require('../../../packages/datadog-plugin-mongodb-core/src/index')
const MongodbCorePlugin = MongodbCoreExport.plugins?.query ?? MongodbCoreExport

const { VARIANT } = process.env

const OPERATIONS = Number(process.env.OPERATIONS)

// Every traced mongo op walks `bindStart` -> `getQuery` ->
// `sanitiseAndStringify`, builds the meta literal, calls `serviceName` /
// `startSpan`, and would otherwise reach `injectDbmComment`. Subclassing the
// real query plugin and overriding only the four hooks that reach for
// tracer / diagnostic-channel / DBM plumbing keeps the production `bindStart`
// shape intact while pulling the loop's measured surface back to the
// per-op sanitiser + meta construction. Subclassing (rather than
// `Object.create`) is required because `DatabasePlugin` uses private methods
// that demand a real instance.
let lastMeta
const FAKE_SPAN = { finish () {} }
const SERVICE_RESULT = { name: 'mongo-prod', source: 'mongodb' }
class BenchedMongoPlugin extends MongodbCorePlugin {
  addTraceSubs () { /* skip diagnostic-channel subscriptions */ }
  serviceName () { return SERVICE_RESULT }
  startSpan (name, opts) { lastMeta = opts.meta; return FAKE_SPAN }
  getPeerService () {}
  injectDbmComment () { /* DBM concat is a separate per-op concern */ }
}

const tracer = {
  _env: 'production',
  _service: 'web-app',
  _version: '1.2.3',
  _nomenclature: { opName: () => 'mongodb.query' },
}
const tracerConfig = { spanComputePeerService: false }
const plugin = new BenchedMongoPlugin(tracer, tracerConfig)
plugin.config = {
  heartbeatEnabled: true,
  dbmPropagationMode: 'service',
  appendComment: false,
  queryInResourceName: false,
  obfuscateQuery: 'none',
}

const OPTIONS = { host: 'mongo-primary.internal', port: 27017 }

// Pre-built per-variant ops fixtures. The hot loop never allocates a new
// `ops` object; pre-allocation pins the V8 hidden class V8 sees on every
// `bindStart` call and keeps the loop measuring the plugin's own work rather
// than fixture construction.
const PLAIN_FIND = {
  find: 'orders',
  filter: { user_id: 1234567, status: 'active', region: 'us-east-1' },
  limit: 100,
}

const DEEP_AGGREGATE = {
  aggregate: 'orders',
  pipeline: [
    { $match: { status: 'paid', region: { $in: ['us-east-1', 'us-west-2'] } } },
    { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'user' } },
    { $group: { _id: '$user_id', total: { $sum: '$total' }, items: { $sum: '$qty' } } },
    { $sort: { total: -1 } },
    { $limit: 100 },
  ],
}

// 64-bit shard IDs overflow `Number.MAX_SAFE_INTEGER`, so the driver passes
// them as native bigints. That disqualifies the `canStringifyDirect` fast
// path and forces the manual walker -- every customer that shards on a
// 64-bit id hits this shape on every read.
const BIGINT_ID = {
  find: 'shards',
  filter: { _id: 9_999_999_999_999_999_999n, region: 'us-east-1', tier: 'gold' },
}

// A 32-byte binary field (SHA-256 hash, content-addressable key,
// idempotency key, UUID stored as binary) passed as a Node Buffer. The
// driver accepts Buffer in place of `BSON.Binary` for binary-typed
// columns. Binary fields are common in production mongodb workloads
// (hash indexes, blob references, idempotency keys), and this shape
// disqualifies the fast path, so this variant pins the slow path's
// cost on a realistic per-op shape.
const BINARY_HASH = {
  find: 'documents',
  filter: { sha256: Buffer.alloc(32, 0x42), tenant: 'acme', deleted: false },
}

const MIXED_OPS = [
  PLAIN_FIND,
  { insert: 'orders', documents: [{ user_id: 1, total: 99.99, items: [{ sku: 'A', qty: 2 }] }] },
  { update: 'orders', updates: [{ q: { _id: 1 }, u: { $set: { status: 'shipped' } } }] },
  { delete: 'sessions', deletes: [{ q: { expires_at: { $lt: new Date(0) } }, limit: 0 }] },
  DEEP_AGGREGATE,
  { count: 'users', query: { active: true } },
  { findAndModify: 'sessions', query: { id: 'abc' }, update: { $set: { last_seen: new Date(0) } } },
  { ping: 1 },
]

function makeCtx (ops) {
  return { ns: 'shop.orders', ops, options: OPTIONS, name: 'find' }
}

// Pre-flight: confirm `bindStart` reached the meta literal and routed
// through the sanitiser. Without this, a refactor that renames a hook or
// skips a branch can quietly turn the bench into a near no-op and ship a
// fake speedup. Cost: one extra `bindStart` call per variant at module
// load, then zero per iteration. `ping` legitimately produces no query
// (no `.filter` / `.pipeline` / etc.), so verify the meta literal was
// built rather than asserting on the query string.
function preflight (ctx) {
  lastMeta = undefined
  plugin.bindStart(ctx)
  assert.ok(lastMeta && lastMeta['db.name'] === ctx.ns && 'mongodb.query' in lastMeta,
    'bindStart did not build the meta literal')
}

const FIXTURES = {
  'plain-find': PLAIN_FIND,
  'deep-aggregate': DEEP_AGGREGATE,
  'bigint-id': BIGINT_ID,
  'binary-hash': BINARY_HASH,
}

guard.loopStart()
if (VARIANT === 'mixed-ops') {
  const ctxs = MIXED_OPS.map(makeCtx)
  for (const ctx of ctxs) preflight(ctx)
  lastMeta = undefined
  const len = ctxs.length
  for (let i = 0; i < OPERATIONS; i++) {
    plugin.bindStart(ctxs[i % len])
  }
} else {
  const ops = FIXTURES[VARIANT]
  assert.ok(ops, `unknown VARIANT: ${VARIANT}`)
  const ctx = makeCtx(ops)
  preflight(ctx)
  lastMeta = undefined
  for (let i = 0; i < OPERATIONS; i++) {
    plugin.bindStart(ctx)
  }
}

// Post-loop read of `lastMeta` keeps V8 from dead-code-eliminating the
// per-iter `startSpan` stub side effect, which is the only thing pinning
// the meta-literal construction inside the loop.
assert.ok(lastMeta, 'startSpan stub was never reached inside the hot loop')
guard.done()
