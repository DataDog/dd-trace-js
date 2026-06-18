'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const format = require('../../../packages/dd-trace/src/span_format')
const DatadogSpanContext = require('../../../packages/dd-trace/src/opentracing/span_context')
const id = require('../../../packages/dd-trace/src/id')

const { VARIANT } = process.env
const ITERATIONS = Number(process.env.ITERATIONS) || 3_000_000

// Every finished span runs through span_format.format() before the msgpack
// encoder sees it: the per-tag switch splits the tag bag into meta/metrics,
// truncates over-long keys/values, lifts the error fields, and stamps the
// root/chunk tags. The `encoding` bench measures the encode of an already
// formatted span and `spans` measures the span lifecycle; neither isolates
// format(). Drive it directly over pre-built tag bags.
const ERROR = new Error('connection reset by peer')

const FLAT_TAGS = {
  'service.name': 'web-app',
  'span.type': 'web',
  'resource.name': 'GET /api/v2/orders',
  'span.kind': 'server',
  'http.method': 'GET',
  'http.status_code': 200,
  'http.url': 'https://api.example.com/api/v2/orders?page=2',
  component: 'express',
}

function buildManyTags () {
  const tags = { ...FLAT_TAGS }
  for (let i = 0; i < 40; i++) {
    tags[`custom.tag.${i}`] = i % 3 === 0 ? i : `value-${i}`
  }
  return tags
}

const VARIANTS = {
  'flat-tags': FLAT_TAGS,
  'many-tags': buildManyTags(),
  error: { ...FLAT_TAGS, 'http.status_code': 500, error: ERROR },
  'http-server': {
    'service.name': 'web-app',
    'span.type': 'web',
    'resource.name': 'GET /users/:id',
    'span.kind': 'server',
    'http.method': 'GET',
    'http.status_code': 200,
    'analytics.event': true,
    _dd_measured: 1,
  },
}

const tags = VARIANTS[VARIANT]
assert.ok(tags, `unknown VARIANT: ${VARIANT}`)

// serviceLower matches service.name so the BASE_SERVICE / registerExtraService
// branch stays off (it would mutate the shared tag bag after the first call).
const tracer = { serviceLower: 'web-app' }

const spanContext = new DatadogSpanContext({
  traceId: id(),
  spanId: id(),
  parentId: id('0'),
  name: 'web.request',
  tags,
  sampling: { priority: 1 },
})
spanContext._trace.origin = 'synthetics'
spanContext._trace.tags['_dd.p.tid'] = '640cfd8d00000000'
spanContext._trace.tags['_dd.p.dm'] = '-1'
spanContext._hostname = 'web-1.internal'

const span = {
  _startTime: 1_716_950_000_000.5,
  _duration: 12.345,
  _links: [],
  _events: [],
  meta_struct: undefined,
  context () { return spanContext },
  tracer () { return tracer },
  setTag (key, value) { spanContext.setTag(key, value) },
}
spanContext._trace.started.push(span)

// Preflight: confirm the formatter split tags into meta/metrics and produced
// the language meta every span carries. The loop below folds the fields it
// asserts here, so they must be present in every variant.
const sample = format(span, true, '-1')
assert.equal(sample.meta.language, 'javascript')
assert.equal(sample.meta['http.method'], 'GET', 'every variant carries the http.method meta tag')
assert.equal(sample.metrics._sampling_priority_v1, 1, 'sampling priority should land in metrics')
if (VARIANT === 'error') assert.equal(sample.error, 1, 'error span should set error=1')

// Fold a representative meta string and metrics number (alongside the error
// bit, which is 0 outside the error variant) into the sink. Reading the meta
// and metrics objects keeps every per-tag store the formatter makes observable,
// so V8 cannot dead-store-eliminate the split this bench is meant to measure.
guard.loopStart()
let sink = 0
for (let i = 0; i < ITERATIONS; i++) {
  const formatted = format(span, true, '-1')
  sink += formatted.error + formatted.meta['http.method'].length + formatted.metrics._sampling_priority_v1
}
guard.done()

if (sink === undefined) throw new Error('unreachable')
