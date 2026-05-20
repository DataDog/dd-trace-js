'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/core')
const {
  MANUAL,
  stampIntegrationService,
  resolveServiceSource,
} = require('../../src/service-naming/source-marker')

const TRACER_SERVICE = 'app'
const SVC_SRC_KEY = '_dd.svc_src'

function makeSpan (tags = {}) {
  return { _spanContext: { _tags: { ...tags } } }
}

describe('service-naming/source-marker', () => {
  describe('resolveServiceSource', () => {
    it('clears _dd.svc_src when service.name equals the tracer default', () => {
      const span = makeSpan({ 'service.name': TRACER_SERVICE, [SVC_SRC_KEY]: 'opt.plugin' })

      resolveServiceSource(span, TRACER_SERVICE)

      assert.strictEqual(span._spanContext._tags[SVC_SRC_KEY], undefined)
    })

    it('keeps the integration source when the marker matches current service.name', () => {
      const span = makeSpan({ 'service.name': 'kafka-broker', [SVC_SRC_KEY]: 'kafka' })
      stampIntegrationService(span, 'kafka-broker')

      resolveServiceSource(span, TRACER_SERVICE)

      assert.strictEqual(span._spanContext._tags[SVC_SRC_KEY], 'kafka')
    })

    it('marks manual when user overrides an integration value', () => {
      const span = makeSpan({ 'service.name': 'my-app', [SVC_SRC_KEY]: 'kafka' })
      stampIntegrationService(span, 'kafka-broker')

      resolveServiceSource(span, TRACER_SERVICE)

      assert.strictEqual(span._spanContext._tags[SVC_SRC_KEY], MANUAL)
    })

    it('marks manual for a user-only span with a non-default service', () => {
      const span = makeSpan({ 'service.name': 'my-app' })

      resolveServiceSource(span, TRACER_SERVICE)

      assert.strictEqual(span._spanContext._tags[SVC_SRC_KEY], MANUAL)
    })

    it('does not mark manual when user "overrides" with the integration\'s own value', () => {
      const span = makeSpan({ 'service.name': 'kafka-broker', [SVC_SRC_KEY]: 'kafka' })
      stampIntegrationService(span, 'kafka-broker')

      resolveServiceSource(span, TRACER_SERVICE)

      assert.strictEqual(span._spanContext._tags[SVC_SRC_KEY], 'kafka')
    })
  })
})
