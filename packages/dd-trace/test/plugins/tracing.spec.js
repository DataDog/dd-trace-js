'use strict'

require('../setup/tap')

const TracingPlugin = require('../../src/plugins/tracing')
const agent = require('../plugins/agent')
const plugins = require('../../src/plugins')
const { channel } = require('dc-polyfill')

describe('TracingPlugin', () => {
  describe('startSpan method', () => {
    it('passes given childOf relationship to the tracer', () => {
      const startSpanSpy = sinon.spy()
      const plugin = new TracingPlugin({
        _tracer: {
          startSpan: startSpanSpy
        }
      })
      plugin.configure({})

      plugin.startSpan('Test span', { childOf: 'some parent span' })

      expect(startSpanSpy).to.have.been.calledWith(
        'Test span',
        sinon.match({
          childOf: 'some parent span'
        })
      )
    })
  })
})

describe('common Plugin behaviour', () => {
  before(() => agent.load())

  after(() => agent.close({ ritmReset: false }))
  class CommonPlugin extends TracingPlugin {
    static get id () { return 'commonPlugin' }
    static get operation () { return 'dothings' }

    start () {
      return this.startSpan('common.operation', {
        service: this.config.service || this._tracerConfig.service
      }, true)
    }
  }

  class SuffixPlugin extends TracingPlugin {
    static get id () { return 'suffixPlugin' }
    static get operation () { return 'dothings' }
    start () {
      return this.startSpan('common.operation', {
        service: this.config.service || `${this.tracer._service}-suffix`
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
          expect(span).to.have.property('service', 'not-the-right-test')
          expect(span.meta).to.have.property('_dd.base_service', 'test')
        }
      )
    })

    it('should tag when plugin impl does not match tracer service', done => {
      makeSpan(
        done, 'suffixPlugin', {},
        span => {
          expect(span).to.have.property('service', 'test-suffix')
          expect(span.meta).to.have.property('_dd.base_service', 'test')
        }
      )
    })

    it('should not tag when service matches tracer service', done => {
      makeSpan(
        done, 'commonPlugin', {},
        span => {
          expect(span).to.have.property('service', 'test')
          expect(span.meta).to.not.have.property('_dd.base_service', 'test')
        }
      )
    })
  })
})
