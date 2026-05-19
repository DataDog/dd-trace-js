'use strict'

const assert = require('node:assert/strict')

const { describe, it, before, after } = require('mocha')
const sinon = require('sinon')
const { channel } = require('dc-polyfill')

require('../setup/core')
const TracingPlugin = require('../../src/plugins/tracing')
const { SVC_SRC_KEY } = require('../../src/constants')
const { INTEGRATION_SERVICE } = require('../../src/service-naming/source-marker')
const agent = require('../plugins/agent')
const plugins = require('../../src/plugins')

describe('TracingPlugin', () => {
  describe('startSpan method', () => {
    let startSpanSpy
    let plugin

    beforeEach(() => {
      startSpanSpy = sinon.stub().returns({})
      plugin = new TracingPlugin({
        _tracer: {
          startSpan: startSpanSpy,
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

    it('stamps the integration marker when service is provided with a source', () => {
      const span = {}
      startSpanSpy.returns(span)

      plugin.startSpan('Test span', { service: { name: 'kafka-broker', source: 'kafka' } })

      assert.strictEqual(span[INTEGRATION_SERVICE], 'kafka-broker')
    })

    it('stamps the integration marker when service is supplied via meta.service', () => {
      // Regression: inferred-proxy spans (packages/dd-trace/src/plugins/util/inferred_proxy.js)
      // pass the service through `meta.service`, leaving the top-level `service` undefined.
      // Without stamping here, resolveServiceSource at finish would misclassify these as manual.
      const span = {}
      startSpanSpy.returns(span)

      plugin.startSpan('Test span', { meta: { service: 'inferred-proxy-svc' } })

      assert.strictEqual(span[INTEGRATION_SERVICE], 'inferred-proxy-svc')
    })

    it('stamps the integration marker when service equals the tracer default', () => {
      // resolveServiceSource handles the equal-to-tracer-default case at finish time,
      // so we unconditionally stamp here and let finish reconcile.
      const localStub = sinon.stub().returns({})
      const localPlugin = new TracingPlugin({ _tracer: { startSpan: localStub, _service: 'app' } })
      localPlugin.configure({})

      const span = {}
      localStub.returns(span)
      localPlugin.startSpan('Test span', { service: 'app' })

      assert.strictEqual(span[INTEGRATION_SERVICE], 'app')
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
