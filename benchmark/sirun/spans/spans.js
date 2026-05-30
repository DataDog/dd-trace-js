'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const tracer = require('../../..').init()

tracer._tracer._processor.process = function process (span) {
  const trace = span.context()._trace
  this._erase(trace)
}

const { FINISH, SHAPE = 'plain' } = process.env

// Total spans created per process. The fixed tracer load (~75 ms) must be a small
// fraction of the run so the bench measures span construction, not startup; at
// 2M it is well under 10%. COUNT keeps it tunable per variant.
const COUNT = Number(process.env.COUNT) || 2_000_000

// finish-later defers the finish so it runs off the active-span path. Holding all
// COUNT spans live at once would blow the heap (a 1M array of spans is ~1.6 GB);
// instead run in fixed-size batches so the deferred-finish path is still exercised
// while live memory stays flat.
const BATCH = 10_000

const spans = []

// Span sanitizes link / event attributes inline; reusing the pre-built objects across
// iterations is safe and matches plugin-emitted span construction.
const TAGS = { service: 'svc', env: 'prod', 'http.method': 'GET' }
const LINK_TARGET = tracer.startSpan('link-target')
const LINK_CONTEXT = LINK_TARGET.context()
const LINK_ATTRIBUTES = { 'event.kind': 'fork', priority: 1, ok: true }
const EVENT_ATTRIBUTES = { attempt: 1, ok: true, code: 200 }

const FIELDS_WITH_TAGS = { tags: TAGS }
const FIELDS_WITH_TAGS_AND_LINKS = {
  tags: TAGS,
  links: [{ context: LINK_CONTEXT, attributes: LINK_ATTRIBUTES }],
}

// An enriched HTTP+DB server span: ~20 tags across http, db, peer and custom
// keys, matching what a plugin plus user code attaches on a real request. Drives
// the addTags path far harder than the 3-tag shape.
const MANY_TAGS = {
  'http.method': 'POST',
  'http.url': 'https://api.example.com/v2/orders',
  'http.status_code': 200,
  'http.route': '/v2/orders',
  'span.kind': 'server',
  component: 'express',
  'db.type': 'postgres',
  'db.name': 'orders',
  'db.user': 'app_writer',
  'peer.service': 'orders-db',
  'out.host': 'db-primary.internal',
  'out.port': 5432,
  env: 'production',
  version: '1.42.3',
  'service.name': 'orders-api',
  'user.id': 'u-1234567',
  'tenant.id': 't-7654321',
  region: 'us-east-1',
  'request.id': 'req-abcdef0123',
  'feature.flag': 'checkout_v2',
}
const FIELDS_WITH_MANY_TAGS = { tags: MANY_TAGS }

// Pre-flight: confirm tags / links / events actually attach; catches a silent
// breakage where the construction shape stopped propagating.
const sanitySpan = tracer.startSpan('sanity.span', FIELDS_WITH_TAGS_AND_LINKS)
sanitySpan.addEvent('sanity-event', EVENT_ATTRIBUTES)
assert.equal(sanitySpan.context().getTag('service'), 'svc')
assert.equal(sanitySpan._links.length, 1)
assert.equal(sanitySpan._events.length, 1)
sanitySpan.finish()

// One span creation for the active shape. addEvent only applies to the otel shape.
function startOne () {
  if (SHAPE === 'tags') {
    return tracer.startSpan('some.span.name', FIELDS_WITH_TAGS)
  }
  if (SHAPE === 'many-tags') {
    return tracer.startSpan('some.span.name', FIELDS_WITH_MANY_TAGS)
  }
  if (SHAPE === 'tags-and-otel') {
    const span = tracer.startSpan('some.span.name', FIELDS_WITH_TAGS_AND_LINKS)
    span.addEvent('event-name', EVENT_ATTRIBUTES)
    return span
  }
  return tracer.startSpan('some.span.name', {})
}

guard.loopStart()
if (FINISH === 'now') {
  for (let iteration = 0; iteration < COUNT; iteration++) {
    startOne().finish()
  }
} else {
  // Deferred finish in batches: start BATCH spans, finish them after the batch is
  // built (so each finishes off the active path), then drop the references.
  let remaining = COUNT
  while (remaining > 0) {
    const size = remaining < BATCH ? remaining : BATCH
    for (let i = 0; i < size; i++) {
      spans.push(startOne())
    }
    for (let i = 0; i < size; i++) {
      spans[i].finish()
    }
    spans.length = 0
    remaining -= size
  }
}
// Full-tracer load is a fixed ~90 ms here and the lightest variant can't grow its
// loop past it without risking the span-allocation GC cliff, so use the relaxed ceiling.
guard.done(0.15)
