'use strict'

const assert = require('node:assert/strict')

const tracer = require('../../..').init()

tracer._tracer._processor.process = function process (span) {
  const trace = span.context()._trace
  this._erase(trace)
}

const { FINISH, SHAPE = 'plain' } = process.env

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

// Pre-flight: confirm tags / links / events actually attach; catches a silent
// breakage where the construction shape stopped propagating.
const sanitySpan = tracer.startSpan('sanity.span', FIELDS_WITH_TAGS_AND_LINKS)
sanitySpan.addEvent('sanity-event', EVENT_ATTRIBUTES)
assert.equal(sanitySpan.context()._tags.service, 'svc')
assert.equal(sanitySpan._links.length, 1)
assert.equal(sanitySpan._events.length, 1)
sanitySpan.finish()

if (SHAPE === 'tags') {
  for (let iteration = 0; iteration < 100_000; iteration++) {
    const span = tracer.startSpan('some.span.name', FIELDS_WITH_TAGS)
    if (FINISH === 'now') {
      span.finish()
    } else {
      spans.push(span)
    }
  }
} else if (SHAPE === 'tags-and-otel') {
  for (let iteration = 0; iteration < 100_000; iteration++) {
    const span = tracer.startSpan('some.span.name', FIELDS_WITH_TAGS_AND_LINKS)
    span.addEvent('event-name', EVENT_ATTRIBUTES)
    if (FINISH === 'now') {
      span.finish()
    } else {
      spans.push(span)
    }
  }
} else {
  for (let iteration = 0; iteration < 100_000; iteration++) {
    const span = tracer.startSpan('some.span.name', {})
    if (FINISH === 'now') {
      span.finish()
    } else {
      spans.push(span)
    }
  }
}

if (FINISH !== 'now') {
  for (let index = 0; index < 100_000; index++) {
    spans[index].finish()
  }
}
