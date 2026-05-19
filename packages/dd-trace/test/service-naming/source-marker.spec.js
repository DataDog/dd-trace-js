'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')

require('../setup/core')
const {
  INTEGRATION_SERVICE,
  MANUAL,
  stampIntegrationService,
  resolveServiceSource,
} = require('../../src/service-naming/source-marker')

const TRACER_SERVICE = 'app'

function makeSpan (tags = {}) {
  return {
    _spanContext: { _tags: { ...tags } },
  }
}

describe('service-naming/source-marker', () => {
  describe('stampIntegrationService', () => {
    it('records the intended service name under the INTEGRATION_SERVICE symbol', () => {
      const span = makeSpan()
      stampIntegrationService(span, 'kafka-broker')
      assert.strictEqual(span[INTEGRATION_SERVICE], 'kafka-broker')
    })

    it('overwrites the marker when called again', () => {
      const span = makeSpan()
      stampIntegrationService(span, 'first')
      stampIntegrationService(span, 'second')
      assert.strictEqual(span[INTEGRATION_SERVICE], 'second')
    })
  })

  describe('resolveServiceSource', () => {
    let span

    beforeEach(() => {
      span = makeSpan()
    })

    it('clears _dd.svc_src when service.name equals the tracer default', () => {
      span._spanContext._tags['service.name'] = TRACER_SERVICE
      span._spanContext._tags['_dd.svc_src'] = 'opt.plugin'

      resolveServiceSource(span, TRACER_SERVICE)

      assert.strictEqual(span._spanContext._tags['_dd.svc_src'], undefined)
    })

    it('clears _dd.svc_src when service.name is missing', () => {
      span._spanContext._tags['_dd.svc_src'] = 'kafka'

      resolveServiceSource(span, TRACER_SERVICE)

      assert.strictEqual(span._spanContext._tags['_dd.svc_src'], undefined)
    })

    it('keeps the integration source when the marker matches current service.name', () => {
      span._spanContext._tags['service.name'] = 'kafka-broker'
      span._spanContext._tags['_dd.svc_src'] = 'kafka'
      stampIntegrationService(span, 'kafka-broker')

      resolveServiceSource(span, TRACER_SERVICE)

      assert.strictEqual(span._spanContext._tags['_dd.svc_src'], 'kafka')
    })

    it('marks manual when user overrides an integration value', () => {
      span._spanContext._tags['service.name'] = 'my-app'
      span._spanContext._tags['_dd.svc_src'] = 'kafka'
      stampIntegrationService(span, 'kafka-broker')

      resolveServiceSource(span, TRACER_SERVICE)

      assert.strictEqual(span._spanContext._tags['_dd.svc_src'], MANUAL)
    })

    it('marks manual for a user-only span with a non-default service', () => {
      span._spanContext._tags['service.name'] = 'my-app'

      resolveServiceSource(span, TRACER_SERVICE)

      assert.strictEqual(span._spanContext._tags['_dd.svc_src'], MANUAL)
    })

    it('does not mark manual when user "overrides" with the integration\'s own value', () => {
      span._spanContext._tags['service.name'] = 'kafka-broker'
      span._spanContext._tags['_dd.svc_src'] = 'kafka'
      stampIntegrationService(span, 'kafka-broker')

      resolveServiceSource(span, TRACER_SERVICE)

      assert.strictEqual(span._spanContext._tags['_dd.svc_src'], 'kafka')
    })
  })
})
