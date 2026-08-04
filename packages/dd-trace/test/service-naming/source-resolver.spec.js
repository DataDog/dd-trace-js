'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/core')
const DatadogSpanContext = require('../../src/opentracing/span_context')
const {
  INTEGRATION_SERVICE,
  MANUAL,
  resolveServiceSource,
} = require('../../src/service-naming/source-resolver')

const TRACER_SERVICE = 'app'
const SVC_SRC_KEY = '_dd.svc_src'

function makeSpan (tags = {}, marker) {
  const span = { _spanContext: new DatadogSpanContext({ tags: { ...tags } }) }
  if (marker !== undefined) span[INTEGRATION_SERVICE] = marker
  return span
}

describe('service-naming/source-resolver', () => {
  describe('resolveServiceSource', () => {
    it('clears _dd.svc_src when service.name equals the tracer default', () => {
      const span = makeSpan({ 'service.name': TRACER_SERVICE, [SVC_SRC_KEY]: 'opt.plugin' })

      resolveServiceSource(span, TRACER_SERVICE)

      assert.strictEqual(span._spanContext.getTag(SVC_SRC_KEY), undefined)
    })

    it('keeps the integration source when the marker matches current service.name', () => {
      const span = makeSpan({ 'service.name': 'kafka-broker', [SVC_SRC_KEY]: 'kafka' }, 'kafka-broker')

      resolveServiceSource(span, TRACER_SERVICE)

      assert.strictEqual(span._spanContext.getTag(SVC_SRC_KEY), 'kafka')
    })

    it('marks manual when user overrides an integration value', () => {
      const span = makeSpan({ 'service.name': 'my-app', [SVC_SRC_KEY]: 'kafka' }, 'kafka-broker')

      resolveServiceSource(span, TRACER_SERVICE)

      assert.strictEqual(span._spanContext.getTag(SVC_SRC_KEY), MANUAL)
    })

    it('marks manual for a user-only span with a non-default service', () => {
      const span = makeSpan({ 'service.name': 'my-app' })

      resolveServiceSource(span, TRACER_SERVICE)

      assert.strictEqual(span._spanContext.getTag(SVC_SRC_KEY), MANUAL)
    })
  })
})
