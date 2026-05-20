'use strict'

const assert = require('node:assert/strict')

const { describe, it, before, after } = require('mocha')
const sinon = require('sinon')
const { channel } = require('dc-polyfill')

require('../setup/core')
const TracingPlugin = require('../../src/plugins/tracing')
const { SVC_SRC_KEY } = require('../../src/constants')
const {
  INTEGRATION_SERVICE,
  MANUAL,
  resolveServiceSource,
} = require('../../src/service-naming/source-resolver')
const agent = require('../plugins/agent')
const plugins = require('../../src/plugins')

describe('TracingPlugin', () => {
  describe('startSpan method', () => {
    let startSpanSpy
    let plugin

    beforeEach(() => {
      startSpanSpy = sinon.stub().callsFake((_name, opts) => ({
        _spanContext: { _tags: { ...opts.tags } },
      }))
      plugin = new TracingPlugin({
        _tracer: {
          startSpan: startSpanSpy,
          _service: 'tracer-default',
        },
      })
      plugin.configure({})
    })

    it('passes given childOf relationship to the tracer', () => {
      plugin.startSpan('Test span', { childOf: 'some parent span' })

      sinon.assert.calledWith(startSpanSpy,
        'Test span',
        sinon.match({
          childOf: 'some parent span',
        })
      )
    })

    it('sets SVC_SRC_KEY tag when service is provided as an object with source', () => {
      plugin.startSpan('Test span', { service: { name: 'my-service', source: 'kafka' } })

      sinon.assert.calledWith(startSpanSpy,
        'Test span',
        sinon.match({
          tags: sinon.match({
            [SVC_SRC_KEY]: 'kafka',
          }),
        })
      )
    })

    it('defaults SVC_SRC_KEY to opt.plugin when service is a plain string', () => {
      // This means the service name was provided from the config, so it should default to opt.plugin
      plugin.startSpan('Test span', { service: 'my-service' })

      sinon.assert.calledWith(startSpanSpy,
        'Test span',
        sinon.match({
          tags: sinon.match({
            [SVC_SRC_KEY]: 'opt.plugin',
          }),
        })
      )
    })

    it('does not set SVC_SRC_KEY tag when service is not provided', () => {
      plugin.startSpan('Test span', {})

      const callArgs = startSpanSpy.firstCall.args[1]
      assert.ok(!(SVC_SRC_KEY in callArgs.tags), 'SVC_SRC_KEY should not be present when service is not provided')
    })

    it('records the integration claim so a user override is detected at finish', () => {
      const span = plugin.startSpan('Test span', { service: { name: 'kafka-broker', source: 'kafka' } })

      span._spanContext._tags['service.name'] = 'user-svc'
      resolveServiceSource(span, 'tracer-default')

      assert.strictEqual(span._spanContext._tags[SVC_SRC_KEY], MANUAL)
    })

    it('records the integration claim when service is supplied via meta.service', () => {
      // Regression: inferred-proxy spans (packages/dd-trace/src/plugins/util/inferred_proxy.js)
      // pass the service through `meta.service`, leaving the top-level `service` undefined.
      // Without recording the claim, a later override would be indistinguishable from a manual write.
      const span = plugin.startSpan('Test span', { meta: { service: 'inferred-proxy-svc' } })

      span._spanContext._tags['service.name'] = 'user-svc'
      resolveServiceSource(span, 'tracer-default')

      assert.strictEqual(span._spanContext._tags[SVC_SRC_KEY], MANUAL)
    })

    it('keeps the integration source when the user does not override service.name', () => {
      const span = plugin.startSpan('Test span', { service: { name: 'kafka-broker', source: 'kafka' } })

      resolveServiceSource(span, 'tracer-default')

      assert.strictEqual(span._spanContext._tags[SVC_SRC_KEY], 'kafka')
    })
  })

  describe('stampIntegrationService method', () => {
    let plugin

    beforeEach(() => {
      plugin = new TracingPlugin({ _tracer: { _service: 'tracer-default' } })
      plugin.configure({})
    })

    it('records the integration claim using the tracer service', () => {
      const span = { _spanContext: { _tags: {} } }

      plugin.stampIntegrationService(span, 'kafka-broker')

      assert.strictEqual(span[INTEGRATION_SERVICE], 'kafka-broker')
    })

    it('does not record a claim when service matches the tracer default', () => {
      const span = { _spanContext: { _tags: {} } }

      plugin.stampIntegrationService(span, 'tracer-default')

      assert.strictEqual(span[INTEGRATION_SERVICE], undefined)
    })
  })

  describe('setServiceName method', () => {
    let plugin

    beforeEach(() => {
      plugin = new TracingPlugin({ _tracer: { _service: 'tracer-default' } })
      plugin.configure({})
    })

    it('sets service.name and stamps the integration claim', () => {
      const span = { _spanContext: { _tags: {} } }

      plugin.setServiceName(span, 'express-app')

      assert.deepStrictEqual(span._spanContext._tags, { 'service.name': 'express-app' })
      assert.strictEqual(span[INTEGRATION_SERVICE], 'express-app')
    })

    it('detects user override at finish when service.name is later mutated', () => {
      const span = { _spanContext: { _tags: { [SVC_SRC_KEY]: 'opt.plugin' } } }
      plugin.setServiceName(span, 'express-app')

      span._spanContext._tags['service.name'] = 'user-svc'
      resolveServiceSource(span, 'tracer-default')

      assert.strictEqual(span._spanContext._tags[SVC_SRC_KEY], MANUAL)
    })
  })
})

describe('common Plugin behaviour', () => {
  before(() => agent.load())

  after(() => agent.close())
  class CommonPlugin extends TracingPlugin {
    static id = 'commonPlugin'
    static operation = 'dothings'

    start () {
      return this.startSpan('common.operation', {
        service: this.config.service || this._tracerConfig.service,
      }, true)
    }
  }

  class SuffixPlugin extends TracingPlugin {
    static id = 'suffixPlugin'
    static operation = 'dothings'
    start () {
      return this.startSpan('common.operation', {
        service: this.config.service || `${this.tracer._service}-suffix`,
      }, true)
    }
  }

  const testPlugins = { commonPlugin: CommonPlugin, suffixPlugin: SuffixPlugin }
  const loadChannel = channel('dd-trace:instrumentation:load')

  before(() => {
    for (const [name, cls] of Object.entries(testPlugins)) {
      plugins[name] = cls
      loadChannel.publish({ name })
    }
  })

  after(() => { Object.keys(testPlugins).forEach(name => delete plugins[name]) })

  describe('tagBaseService', () => {
    function makeSpan (done, pluginName, pluginConf, spanExpectations) {
      /**
       * Make plugin `pluginName` generate a span given `pluginConf` plugin init
       * and verify it against spanExpectations: span -> void
       */
      const startCh = channel(`apm:${pluginName}:dothings:start`)
      const finishCh = channel(`apm:${pluginName}:dothings:finish`)

      agent.reload(pluginName, pluginConf)

      agent.assertSomeTraces(
        traces => {
          const span = traces[0][0]
          spanExpectations(span)
        }
      ).then(done).catch(done)

      startCh.publish({ foo: 'bar' })
      finishCh.publish({})
    }

    it('should tag when tracer service does not match plugin', done => {
      makeSpan(
        done, 'commonPlugin', { service: 'not-the-right-test' },
        span => {
          assert.strictEqual(span.service, 'not-the-right-test')
          assert.strictEqual(span.meta['_dd.base_service'], 'test')
        }
      )
    })

    it('should tag when plugin impl does not match tracer service', done => {
      makeSpan(
        done, 'suffixPlugin', {},
        span => {
          assert.strictEqual(span.service, 'test-suffix')
          assert.strictEqual(span.meta['_dd.base_service'], 'test')
        }
      )
    })

    it('should not tag when service matches tracer service', done => {
      makeSpan(
        done, 'commonPlugin', {},
        span => {
          assert.strictEqual(span.service, 'test')
          assert.ok(!('_dd.base_service' in span.meta) || span.meta['_dd.base_service'] !== 'test')
        }
      )
    })
  })
})
