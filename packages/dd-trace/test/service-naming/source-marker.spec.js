'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/core')
const {
  INTEGRATION_SERVICE,
  MANUAL,
  setServiceName,
  stampIntegrationService,
  resolveServiceSource,
} = require('../../src/service-naming/source-marker')

const TRACER_SERVICE = 'app'
const SVC_SRC_KEY = '_dd.svc_src'

function makeSpan (tags = {}) {
  return { _spanContext: { _tags: { ...tags } } }
}

describe('service-naming/source-marker', () => {
  describe('stampIntegrationService', () => {
    it('records an integration service claim', () => {
      const span = makeSpan()

      stampIntegrationService(span, 'kafka-broker', TRACER_SERVICE)

      assert.strictEqual(span[INTEGRATION_SERVICE], 'kafka-broker')
    })

    it('does not record a claim when no service is provided', () => {
      const span = makeSpan()

      stampIntegrationService(span, undefined, TRACER_SERVICE)

      assert.strictEqual(span[INTEGRATION_SERVICE], undefined)
    })

    it('does not record a claim when service matches the tracer default', () => {
      const span = makeSpan()

      stampIntegrationService(span, TRACER_SERVICE, TRACER_SERVICE)

      assert.strictEqual(span[INTEGRATION_SERVICE], undefined)
    })
  })

  describe('setServiceName', () => {
    it('sets service.name and records the integration service claim', () => {
      const span = makeSpan()

      setServiceName(span, 'express-app', TRACER_SERVICE)

      assert.deepStrictEqual(span._spanContext._tags, {
        'service.name': 'express-app',
      })
      assert.strictEqual(span[INTEGRATION_SERVICE], 'express-app')
    })
  })

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

    it('keeps an existing integration source when no marker was recorded', () => {
      const span = makeSpan({ 'service.name': 'next', [SVC_SRC_KEY]: 'next' })

      resolveServiceSource(span, TRACER_SERVICE)

      assert.strictEqual(span._spanContext._tags[SVC_SRC_KEY], 'next')
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
