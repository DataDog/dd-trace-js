'use strict'

const assert = require('node:assert/strict')

const PGPlugin = require('../../../packages/datadog-plugin-pg/src/index')

const { VARIANT } = process.env

const ITERATIONS = 8_000_000

// Plugin work per traced query: `bindStart` builds the meta literal, calls
// `serviceName` / `maybeTruncate` / `startSpan` / `injectDbmQuery`, then
// assigns `query.__ddInjectableQuery`. We need a real plugin instance for the
// `DatabasePlugin#createDbmComment` private-field access; subclassing PGPlugin
// and overriding `addTraceSubs` skips the diagnostic-channel wiring while
// keeping the real receiver shape that private methods require.
let sink = 0
class BenchedPGPlugin extends PGPlugin {
  addTraceSubs () { /* skip diagnostic-channel subscriptions */ }
  serviceName ({ params }) { return `pg-${params.host}-${params.database}` }
  startSpan (name, opts) {
    sink ^= opts.meta['db.type'].length
    return spanForCall
  }
  getPeerService () { return undefined }
}

const tracer = {
  _env: 'production',
  _service: 'web-app',
  _version: '1.2.3',
  _nomenclature: { opName: () => 'pg.query' },
}
const tracerConfig = { spanComputePeerService: false }
const plugin = new BenchedPGPlugin(tracer, tracerConfig)
plugin.config = { dbmPropagationMode: 'service', appendComment: false, truncate: 5000 }

const SPAN_TAGS = {
  'db.name': 'orders_prod',
  'out.host': 'pg-primary.internal',
  'db.user': 'app',
  'span.kind': 'client',
}

// Single shared span object — production constructs a fresh span per request,
// but the plugin's interaction with it is read-only on `context()._tags` plus
// `setTag` for the hash / full-mode branches that we don't trip here.
const spanForCall = {
  context () { return { _tags: SPAN_TAGS } },
  setTag () {},
  _spanContext: { toTraceparent () { return '00-1234567890abcdef-fedcba0987654321-01' } },
  _processor: { sample () {} },
}

// Eight realistic per-query contexts: short / parameterised / prepared /
// long-text / streamed query, plus a couple of variations. Mirrors the
// distribution a service running both quick reads and analytics queries
// would produce.
const QUERIES = [
  { text: 'SELECT id, name FROM users WHERE id = $1', name: 'select_user_by_id' },
  { text: 'INSERT INTO orders (user_id, total) VALUES ($1, $2) RETURNING id', name: 'insert_order' },
  { text: 'UPDATE inventory SET stock = stock - $1 WHERE sku = $2' },
  { text: 'DELETE FROM sessions WHERE expires_at < NOW()' },
  { text: 'SELECT * FROM products WHERE category_id = ANY($1::int[])', name: 'select_products_by_category' },
  { text: 'WITH ranked AS (SELECT id, ROW_NUMBER() OVER (PARTITION BY category_id ORDER BY price DESC) AS rn FROM products) SELECT * FROM ranked WHERE rn <= 5' },
  { text: 'SELECT customer_id, SUM(total) FROM orders WHERE created_at >= $1 GROUP BY customer_id ORDER BY SUM(total) DESC LIMIT 100' },
  { text: 'SELECT 1' },
]

const PARAMS = { host: '10.0.0.1', port: 5432, database: 'orders_prod', user: 'app' }

const buildCtx = (query) => ({ params: PARAMS, query, processId: 12345, stream: false })

// Pre-flight: confirm `bindStart` runs the meta-build + DBM-injection path on
// a representative query, and that `query.__ddInjectableQuery` ends up
// containing the DBM trace comment.
const sanityQuery = { ...QUERIES[0] }
plugin.bindStart(buildCtx(sanityQuery))
assert.ok(sanityQuery.__ddInjectableQuery.includes('dddb='),
  'pg bindStart did not inject the DBM trace comment into the query')

if (VARIANT === 'mixed-queries') {
  const len = QUERIES.length
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    plugin.bindStart(buildCtx({ ...QUERIES[iteration % len] }))
  }
  if (sink === Number.MIN_SAFE_INTEGER) console.log('unreachable', sink)
} else if (VARIANT === 'repeated-prepared') {
  // Worst case for any per-(span, service) DBM cache: one query repeated. A
  // future memoization should drop the per-call DBM cost to nearly zero on
  // this variant; today's master allocates eight strings per call regardless.
  const ctx = buildCtx({ ...QUERIES[0] })
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    ctx.query = { ...QUERIES[0] }
    plugin.bindStart(ctx)
  }
  if (sink === Number.MIN_SAFE_INTEGER) console.log('unreachable', sink)
}
