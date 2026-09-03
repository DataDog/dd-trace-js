'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const PGPlugin = require('../../../packages/datadog-plugin-pg/src/index')
const DatadogSpanContext = require('../../../packages/dd-trace/src/opentracing/span_context')
const id = require('../../../packages/dd-trace/src/id')
const { AUTO_KEEP } = require('../../../ext/priority')

const { VARIANT } = process.env
const OPERATIONS = Number(process.env.OPERATIONS)

// Every traced pg query reaches injectDbmQuery -> createDbmComment, which builds
// the Datadog Block Monitoring SQL comment and splices it onto the query. This
// is the dbm hot path. Subclass the real plugin so configure() bakes the
// dde/ddps/ddpv fragments and the prefix cache exactly as in production, then
// drive createDbmComment / injectDbmQuery directly with a real span context.
class BenchedPGPlugin extends PGPlugin {
  addTraceSubs () { /* skip diagnostic-channel subscriptions */ }
  serviceName () { return 'pg-prod' }
  getPeerService () {}
}

const tracer = {
  _env: 'production',
  _service: 'web-app',
  _version: '1.2.3',
}
const tracerConfig = { spanComputePeerService: false }
const plugin = new BenchedPGPlugin(tracer, tracerConfig)
plugin.configure({
  enabled: true,
  service: 'pg-prod',
  dbmPropagationMode: VARIANT === 'full' ? 'full' : 'service',
  appendComment: false,
  truncate: 5000,
})

// A real span context so createDbmComment runs the production getTags / encode /
// (full mode) toTraceparent path. A minimal span wrapper exposes the surface the
// DBM code touches: context(), setTag(), _spanContext, _processor.sample().
const spanContext = new DatadogSpanContext({
  traceId: id('1234567890abcdef', 16),
  spanId: id('abcdef1234567890', 16),
  tags: { 'db.name': 'orders', 'out.host': 'pg-primary.internal' },
})
spanContext._sampling.priority = AUTO_KEEP
spanContext._trace.tags['_dd.p.tid'] = '640cfd8d00000000'

const span = {
  _spanContext: spanContext,
  _processor: { sample () {} },
  context () { return spanContext },
  setTag (key, value) { spanContext.setTag(key, value) },
}

const QUERY = 'SELECT id, user_id, total, status FROM orders WHERE user_id = $1 AND status = $2'

function injectOnce () {
  return plugin.injectDbmQuery(span, QUERY, 'pg-prod', false)
}

// Preflight: confirm the comment was actually spliced, so a refactor cannot
// silently no-op it.
const sample = injectOnce()
assert.ok(sample.includes("dddb='orders'") && sample.length > QUERY.length,
  'injectDbmQuery did not splice the dbm comment')

guard.loopStart()
let sink = 0
if (VARIANT === 'full') {
  // Production builds a new span per query, so toTraceparent() formats freshly
  // generated identifiers each time. Swapping in new ids per iteration keeps the
  // hex computation unwarmed; a single reused context would memoize toString(16)
  // after the first call and measure cached lookups instead of the real cost.
  for (let i = 0; i < OPERATIONS; i++) {
    spanContext._traceId = id()
    spanContext._spanId = id()
    sink += injectOnce().length
  }
} else {
  for (let i = 0; i < OPERATIONS; i++) {
    sink += injectOnce().length
  }
}
guard.done(0.05)

if (sink === 0) throw new Error('unreachable')
