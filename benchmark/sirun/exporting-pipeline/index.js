'use strict'

const assert = require('node:assert/strict')

// Entry point normally primes this; bench imports src directly.
globalThis[Symbol.for('dd-trace')] ??= { beforeExitHandlers: new Set() }

const hostname = require('os').hostname()
const guard = require('../startup-guard')
const SpanProcessor = require('../../../packages/dd-trace/src/span_processor')
const PrioritySampler = require('../../../packages/dd-trace/src/priority_sampler')
const id = require('../../../packages/dd-trace/src/id')

// Measures the front of the export pipeline: SpanProcessor.process -> priority
// and span sampling -> spanFormat (span -> wire shape). The encoder and the
// agent socket are out of scope on purpose: encode is covered by the `encoding`
// bench, and the real flush is a deferred unref'd timer that barely fires in a
// short run. A no-op exporter keeps the loop CPU-bound, leaves memory flat (the
// formatted chunk is discarded each pass) and drops the agent dependency.
const COUNT = Number(process.env.COUNT) || 200_000
const WITH_STATS = process.env.WITH_STATS === '1'
const WITH_LINKS = process.env.WITH_LINKS === '1'

// Span link + events fixture for the links-and-events variant. spanFormat
// serializes links into meta['_dd.span_links'] and maps events onto span_events
// for every formatted span -- otel-era paths the plain shape never hits.
const LINK_CONTEXT = {
  toTraceId: () => '1234567890abcdef1234567890abcdef',
  toSpanId: () => 'abcdef1234567890',
  _sampling: { priority: 1 },
}
const LINK_ATTRIBUTES = { 'link.kind': 'fork', priority: 1, ok: true }
const SPAN_EVENTS = [
  { name: 'http.attempt', startTime: 1_415_926.5, attributes: { attempt: 1, ok: true, code: 200 } },
  { name: 'db.query', startTime: 1_415_927, attributes: { rows: 17 } },
]

let exported = 0
let lastFormatted
const exporter = { export (formatted) { exported += formatted.length; lastFormatted = formatted } }
const prioritySampler = new PrioritySampler()
const config = {
  flushMinSpans: 100,
  stats: {
    enabled: WITH_STATS,
    DD_TRACE_STATS_COMPUTATION_ENABLED: WITH_STATS,
  },
  appsec: {},
}
const sp = new SpanProcessor(exporter, prioritySampler, config)

const finished = []
const trace = { finished, started: finished, tags: {} }

function createSpan (parent) {
  const spanId = id(0)
  const context = {
    _trace: trace,
    _spanId: spanId,
    _name: 'this is a name',
    _traceId: parent ? parent.context()._traceId : spanId,
    _parentId: parent ? parent.context()._spanId : id(0),
    _hostname: hostname,
    _sampling: {},
    _tags: {
      'service.name': 'hello',
      a: 'b',
      and: 'this is a longer string, just because we want to test some longer strongs, got it? okay',
      b: 45,
      something: 98764389,
      afloaty: 203987465.756754,
    },
    getTag (key) { return this._tags[key] },
    getTags () { return this._tags },
  }
  const span = {
    context: () => context,
    tracer: () => { return { _service: 'exporting-pipeline-sirun' } },
    setTag: () => {},
    _startTime: 1415926,
    _duration: 100,
  }
  if (WITH_LINKS) {
    span._links = [{ context: LINK_CONTEXT, attributes: LINK_ATTRIBUTES }]
    span._events = SPAN_EVENTS
  }
  finished.push(span)
  return span
}

for (let i = 0, parent = null; i < 30; i++) {
  parent = createSpan(parent)
}

// Pre-flight: one pass must format and hand the whole 30-span chunk to the
// exporter; a broken format path would otherwise measure a near-empty loop.
trace.started = finished
trace.finished = finished
sp.process(finished[0])
assert.equal(exported, 30, 'span processor did not format and export the chunk')
if (WITH_LINKS) {
  assert.ok(lastFormatted[0].meta['_dd.span_links'], 'span links were not formatted')
  assert.ok(lastFormatted[0].span_events?.length, 'span events were not formatted')
}

guard.loopStart()
exported = 0
for (let i = 0; i < COUNT; i++) {
  // process() erases trace.finished each pass; restore the chunk so every
  // iteration formats the full set.
  trace.started = finished
  trace.finished = finished
  sp.process(finished[0])
}

assert.ok(exported > 0, 'export loop produced no formatted spans')
guard.done()
