'use strict'

const assert = require('node:assert/strict')

const MongodbCorePlugin = require('../../../packages/datadog-plugin-mongodb-core/src/index')

const { VARIANT } = process.env

const ITERATIONS = 1_000_000

// Plugin work per traced mongo op: `bindStart` walks `getQuery` ->
// `limitDepth` / `extractQuery` / `sanitizeBigInt` (JSON-stringify with a
// reviver), builds the meta literal, calls `serviceName` / `startSpan`, then
// hits `injectDbmComment` -> `createDbmComment` for the DBM trace tag.
//
// Subclassing instead of `Object.create` is required because the inherited
// `DatabasePlugin#createDbmComment` calls private methods on the receiver and
// throws "Receiver must be an instance" otherwise. `addTraceSubs` is
// overridden to skip the diagnostic-channel wiring; `serviceName` / `startSpan`
// / `getPeerService` are stubbed to skip tracer plumbing while keeping the
// production `bindStart` shape intact.
let sink = 0
class BenchedMongoPlugin extends MongodbCorePlugin {
  addTraceSubs () { /* skip diagnostic-channel subscriptions */ }
  serviceName () { return { name: 'mongo-prod', source: 'mongodb' } }
  startSpan (name, opts) {
    sink ^= opts.meta['db.name'].length
    return spanForCall
  }
  getPeerService () { return undefined }
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
  truncate: 5000,
  queryInResourceName: false,
}

const SPAN_TAGS = {
  'db.name': 'shop.orders',
  'out.host': 'mongo-primary.internal',
  'span.kind': 'client',
}

const spanForCall = {
  context () { return { _tags: SPAN_TAGS } },
  setTag () {},
  _spanContext: { toTraceparent () { return '00-1234567890abcdef-fedcba0987654321-01' } },
  _processor: { sample () {} },
}

// Eight realistic mongo command shapes: find / insert / update / delete /
// aggregate / count / single-statement and array-of-statements; mix of
// flat and nested filters so `limitDepth`'s queue walker is exercised.
const OPS_TEMPLATES = [
  { find: 'orders', filter: { user_id: 1234567 }, limit: 100 },
  { insert: 'orders', documents: [{ user_id: 1, total: 99.99, items: [{ sku: 'A', qty: 2 }] }] },
  { update: 'orders', updates: [{ q: { _id: 1 }, u: { $set: { status: 'shipped' } } }] },
  { delete: 'sessions', deletes: [{ q: { expires_at: { $lt: new Date(0) } }, limit: 0 }] },
  { aggregate: 'orders', pipeline: [
    { $match: { status: 'paid' } },
    { $group: { _id: '$user_id', total: { $sum: '$total' } } },
    { $sort: { total: -1 } },
    { $limit: 10 },
  ] },
  { count: 'users', query: { active: true } },
  { findAndModify: 'sessions', query: { id: 'abc' }, update: { $set: { last_seen: new Date(0) } } },
  { ping: 1 },
]

const OPTIONS = { host: 'mongo-primary.internal', port: 27017 }

const buildCtx = (opsIndex) => ({
  ns: 'shop.orders',
  ops: structuredClone(OPS_TEMPLATES[opsIndex]),
  options: OPTIONS,
  name: 'find',
})

// Pre-flight: confirm `bindStart` reaches the meta-literal path and writes a
// DBM comment back onto `ops` (when DBM mode is enabled).
const sanityCtx = buildCtx(0)
plugin.bindStart(sanityCtx)
assert.equal(typeof sanityCtx.ops.comment, 'string',
  'mongo bindStart did not write a DBM trace comment onto ops.comment')
assert.ok(sanityCtx.ops.comment.includes('dddb='),
  'mongo bindStart DBM comment is missing the dddb= field')

if (VARIANT === 'mixed-ops') {
  const len = OPS_TEMPLATES.length
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    plugin.bindStart(buildCtx(iteration % len))
  }
  if (sink === Number.MIN_SAFE_INTEGER) console.log('unreachable', sink)
} else if (VARIANT === 'deep-aggregate') {
  // Worst case for `limitDepth`: a 5-stage aggregate pipeline with nested
  // operators. Exercises the queue-walker depth-limit path on every call.
  const deepCtx = () => buildCtx(4)
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    plugin.bindStart(deepCtx())
  }
  if (sink === Number.MIN_SAFE_INTEGER) console.log('unreachable', sink)
}
